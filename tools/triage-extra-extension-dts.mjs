#!/usr/bin/env node
/**
 * Issue #63: a source file with a host-registered extra extension emits its
 * declaration under stock's name, `Button.vue.d.ts`. tsgo's output-path code
 * answered `.d.<ext>.ts` for any non-script extension — the name a module
 * import looks up under allowArbitraryExtensions, never an emit target in
 * pristine tsgo — so vue-tsc declaration builds on TNB wrote
 * `Button.vue.d.vue.ts`, which no importer resolves.
 *
 * Mirrors the issue's Compiler-API repro (custom CompilerHost,
 * allowNonTsExtensions as vue-tsc's own dts test sets, a real configFilePath
 * so the native project path is active) across outDir / declarationDir /
 * in-place layouts with declaration maps, and diffs against stock: the
 * written file set, each declaration's sourceMappingURL, and each map's
 * file/sources.
 *
 * Stock side: STOCK_TYPESCRIPT_PATH, else derived from STOCK_TSSERVER_PATH
 * (CI), else /tmp/stock-ts-p3/package/lib/typescript.js.
 * Exit: 0 = PASS, 1 = FAIL.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forkTs = path.join(repoRoot, 'lib', 'typescript.js');
const stockTs = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH ? path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js') : undefined)
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';
if (!fs.existsSync(stockTs)) {
	console.error(`stock typescript not found at ${stockTs} — set STOCK_TYPESCRIPT_PATH or STOCK_TSSERVER_PATH`);
	process.exit(1);
}

// Child: emit one fixture with the given typescript.js, print the outputs.
if (process.argv[2] === '--child') {
	const [, , , tsPath, dir, ext, layout] = process.argv;
	const { createRequire } = await import('node:module');
	const ts = createRequire(import.meta.url)(tsPath);
	const files = {
		[path.join(dir, 'src', 'components', `Button${ext}`)]: 'export default function Button(disabled?: boolean): string { return String(disabled); }\n',
		[path.join(dir, 'src', 'index.ts')]: `export { default as Button } from "./components/Button${ext}";\n`,
	};
	const options = {
		module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ESNext,
		strict: true, skipLibCheck: true, types: [], declaration: true, declarationMap: true, emitDeclarationOnly: true,
		allowArbitraryExtensions: true, allowNonTsExtensions: true,
		rootDir: path.join(dir, 'src'), configFilePath: path.join(dir, 'tsconfig.json'),
		...layout === 'outDir' ? { outDir: path.join(dir, 'dist') } : layout === 'declarationDir' ? { declarationDir: path.join(dir, 'types') } : {},
	};
	const host = ts.createCompilerHost(options);
	const { readFile, fileExists, getSourceFile } = host;
	host.readFile = f => files[f] ?? readFile(f);
	host.fileExists = f => f in files || fileExists(f);
	host.getSourceFile = (f, lang, ...rest) => f in files ? ts.createSourceFile(f, files[f], lang, true, ts.ScriptKind.TS) : getSourceFile(f, lang, ...rest);
	const written = {};
	host.writeFile = (f, text) => {
		const rel = path.relative(dir, f).replaceAll('\\', '/');
		written[rel] = rel.endsWith('.map')
			? (({ file, sources }) => ({ file, sources }))(JSON.parse(text))
			: /\/\/# sourceMappingURL=.*/.exec(text)?.[0] ?? null;
	};
	const r = ts.createProgram({ rootNames: Object.keys(files), options, host }).emit();
	console.log(JSON.stringify({ emitSkipped: r.emitSkipped, diagnostics: r.diagnostics.map(d => d.code), written: Object.fromEntries(Object.entries(written).sort()) }));
	process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-extra-ext-dts-'));
function run(tsPath, ext, layout) {
	const dir = fs.mkdtempSync(path.join(root, `${ext.slice(1)}-${layout}-`));
	fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
	const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', tsPath, dir, ext, layout], { encoding: 'utf8', env: { ...process.env, GODEBUG: 'asyncpreemptoff=1' } });
	if (r.status !== 0) return `exit ${r.status ?? r.signal}: ${r.stderr.slice(-500)}`;
	return r.stdout.split('\n').find(l => l.startsWith('{')) ?? `no result: ${r.stdout.slice(-500)}`;
}

let failed = 0;
let cells = 0;
for (const ext of ['.foo', '.vue']) {
	for (const layout of ['outDir', 'declarationDir', 'inPlace']) {
		cells++;
		const label = `${ext} ${layout}`;
		const stock = run(stockTs, ext, layout);
		const fork = run(forkTs, ext, layout);
		const want = `Button${ext}.d.ts`;
		if (!stock.includes(`"${layout === 'declarationDir' ? 'types' : layout === 'outDir' ? 'dist' : 'src'}/components/${want}"`)) {
			console.error(`FAIL ${label}: stock no longer writes ${want} — fixture is stale.\n${stock}`);
			failed++;
		} else if (fork !== stock) {
			console.error(`FAIL ${label}: fork emit diverges from stock.\n--- stock ---\n${stock}\n--- fork ---\n${fork}`);
			failed++;
		} else {
			console.log(`ok ${label} (${want})`);
		}
	}
}
fs.rmSync(root, { recursive: true, force: true });
if (failed) {
	console.error(`FAIL: ${failed}/${cells} extra-extension declaration-emit cells diverged`);
	process.exit(1);
}
console.log(`PASS: all ${cells} extra-extension declaration-emit cells match stock`);
