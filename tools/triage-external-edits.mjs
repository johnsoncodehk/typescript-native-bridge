#!/usr/bin/env node
/**
 * External-edit witness (issue #49): a file rewritten on disk outside the
 * host (git checkout, generator, another tool) must reach tsgo — TNB keeps
 * Go's disk view frozen at first read unless the JS side tells it. Three
 * repros from the issue, each run against the TNB fork and stock
 * typescript@6.0.3, asserting phase-by-phase stock-identical results:
 *   - estree:   typescript-eslint classic `project:` path — watch program
 *               lints a.ts; external rewrite + unsaved-buffer code must both
 *               change the linted file's diagnostics like stock.
 *   - tsserver: external rewrite of a.ts + the client's buffer re-sync
 *               (re-open, updateOpen changedFiles, reload — issue #74) must
 *               clear the dependent b.ts diagnostic and classify a.ts at its
 *               new offsets.
 *   - tscwatch: plain `tsc -w` — content edit must clear the error, file add
 *               must surface the new file's error, output text stock-equal.
 *   - stablecache: external rewrite of a node_modules .d.ts under a
 *               constant-version host must re-materialize the host AST on the
 *               JS side (stock does; the bridge's disk stamp must evict its
 *               stable host-SF cache so JS agrees with Go).
 *   - createprogram: repeated plain ts.createProgram with no watcher at all —
 *               stock re-reads disk on every program; each rewrite (fresh
 *               file, aged file rewritten to the same size, back-to-back
 *               rewrite) must move the diagnostics like stock.
 * Usage: node tools/triage-external-edits.mjs [estree|tsserver|tscwatch|stablecache|createprogram...]
 * Exit: 0 = PASS, 1 = FAIL. Network required on first run (stock pack).
 *
 * v5 classification: bridge-contract surface — stock's own watch/session
 * code delivers external changes to the program; the bridge must carry them
 * to tsgo (fileChanges.changed / overlay push). Stock-gated by construction
 * (every phase asserts TNB === stock).
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The package the estree fixture links as `typescript`: lib's realpath parent,
// since an isolated tools copy (the CI witness job) has lib/ but no package.json.
const tnbPackageRoot = path.dirname(fs.realpathSync(path.join(repoRoot, 'lib')));
const cacheRoot = '/tmp/tnb-fw-fixtures';
const stockDir = path.join(cacheRoot, 'stock-ts');
const estreeDir = path.join(cacheRoot, 'estree');
const scratchRoot = '/tmp/tnb-49-repro';
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function ensureStock() {
	if (fs.existsSync(path.join(stockDir, 'package', 'lib', 'typescript.js'))) return;
	fs.mkdirSync(stockDir, { recursive: true });
	execSync('npm pack typescript@6.0.3 --silent', { cwd: stockDir, stdio: 'ignore' });
	execSync('tar -xzf typescript-6.0.3.tgz', { cwd: stockDir, stdio: 'ignore' });
}

const stockPkg = path.join(stockDir, 'package');
const tnbEnv = {
	...process.env,
	GODEBUG: 'asyncpreemptoff=1',
	TNB_GODEBUG_REEXEC: '1',
	TNB_PARENT_PID: String(process.pid),
};

function runNode(scriptPath, args, cwd) {
	try {
		return execFileSync('node', [scriptPath, ...args], { cwd, encoding: 'utf8', env: tnbEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
	}
	catch (e) {
		return (e.stdout ?? '') + (e.stderr ?? '') + `\n[driver exited ${e.status ?? e.signal}]`;
	}
}

// ── Repro 1: typescript-eslint classic project: path ─────────────────────

const ESTREE_DRIVER = `
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAndGenerateServices } from '@typescript-eslint/typescript-estree';

const dir = ${JSON.stringify(path.join(scratchRoot, 'estree'))};
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, 'a.ts');
fs.writeFileSync(target, 'export const a: number = 1;\\n');
fs.writeFileSync(path.join(dir, 'entry.ts'), 'import { a } from "./a";\\nexport const b: number = a;\\n');
fs.writeFileSync(path.join(dir, 'tsconfig.json'),
	JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }));

const opts = { filePath: target, project: ['./tsconfig.json'], tsconfigRootDir: dir };
const diags = (code) => {
	const s = parseAndGenerateServices(code, { ...opts, code });
	const sf = s.services.program.getSourceFile(target);
	return s.services.program.getSemanticDiagnostics(sf).map(d => d.code);
};

console.log('cold:', diags(fs.readFileSync(target, 'utf8')));
fs.writeFileSync(target, 'export const a: number = "not a number";\\n'); // external edit
console.log('after disk edit:', diags(fs.readFileSync(target, 'utf8')));
fs.writeFileSync(target, 'export const a: number = 1;\\n');
console.log('unsaved buffer:', diags('export const a: number = "unsaved";\\n')); // never written to disk
`;

function estreePhases(out) {
	const grab = (label) => {
		const m = out.match(new RegExp(label + ': \\[([^\\]]*)\\]'));
		if (!m) return undefined;
		return m[1].split(',').map(s => s.trim()).filter(Boolean).map(Number).sort((a, b) => a - b);
	};
	return { cold: grab('cold'), edited: grab('after disk edit'), unsaved: grab('unsaved buffer') };
}

function ensureEstree() {
	if (fs.existsSync(path.join(estreeDir, 'node_modules', '@typescript-eslint', 'typescript-estree'))) return;
	fs.mkdirSync(estreeDir, { recursive: true });
	fs.writeFileSync(path.join(estreeDir, 'package.json'), '{ "private": true }\n');
	execSync('npm install --no-audit --no-fund @typescript-eslint/typescript-estree@8.70.1', { cwd: estreeDir, stdio: 'ignore' });
}

function runEstree() {
	ensureEstree();
	// Driver must live inside the fixture: ESM resolves the bare
	// @typescript-eslint import relative to the driver file, not cwd.
	const driver = path.join(estreeDir, '.tnb-49-driver.mjs');
	fs.mkdirSync(scratchRoot, { recursive: true });
	fs.writeFileSync(driver, ESTREE_DRIVER);
	const tsLink = path.join(estreeDir, 'node_modules', 'typescript');
	const linkTo = (target) => { fs.rmSync(tsLink, { force: true, recursive: true }); fs.symlinkSync(target, tsLink); };
	let outTnb, outStock;
	linkTo(tnbPackageRoot);
	try {
		outTnb = runNode(driver, [], estreeDir);
		linkTo(stockPkg);
		outStock = runNode(driver, [], estreeDir);
	}
	finally {
		linkTo(tnbPackageRoot);
		fs.rmSync(driver, { force: true });
	}
	const tnb = estreePhases(outTnb), stock = estreePhases(outStock);
	const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	if (!(stock.cold?.length === 0 && eq(stock.edited, [2322]) && eq(stock.unsaved, [2322]))) {
		return fail('estree', `stock control diverged from issue table: ${JSON.stringify(stock)}\n${outStock}`);
	}
	if (!eq(tnb, stock)) {
		return fail('estree', `phase mismatch vs stock:\n  tnb:   ${JSON.stringify(tnb)}\n  stock: ${JSON.stringify(stock)}\n--- tnb output ---\n${outTnb}`);
	}
	console.log(`[estree] ok (cold=[], after edit=[2322], unsaved=[2322], stock-identical)`);
	return true;
}

// ── Repro 2: tsserver external rewrite + IDE re-open ─────────────────────

const TSSERVER_DRIVER = `
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const dir = ${JSON.stringify(path.join(scratchRoot, 'tsserver'))};
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const a = path.join(dir, 'a.ts'), b = path.join(dir, 'b.ts');
fs.writeFileSync(a, 'export const alpha = 1;\\n');
fs.writeFileSync(b, 'import { alpha } from "./a";\\nconst s: string = alpha;\\n');
fs.writeFileSync(path.join(dir, 'tsconfig.json'),
	JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'] }));

const srv = spawn('node', [process.argv[2], '--disableAutomaticTypingAcquisition'], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
let buf = '', seq = 0; const pending = new Map();
srv.stdout.on('data', (d) => {
	buf += d;
	for (;;) {
		const m = buf.match(/Content-Length: (\\d+)\\r\\n\\r\\n/);
		if (!m || buf.length < m.index + m[0].length + +m[1]) return;
		const msg = JSON.parse(buf.slice(m.index + m[0].length, m.index + m[0].length + +m[1]));
		buf = buf.slice(m.index + m[0].length + +m[1]);
		if (msg.type === 'response') { pending.get(msg.request_seq)?.(msg); pending.delete(msg.request_seq); }
	}
});
const send = (command, args) => new Promise((res) => {
	const s = ++seq; pending.set(s, res);
	srv.stdin.write(JSON.stringify({ seq: s, type: 'request', command, arguments: args }) + '\\n');
});
const openBoth = (aText) => send('updateOpen', { openFiles: [
	{ file: a, fileContent: aText, scriptKindName: 'TS' },
	{ file: b, fileContent: fs.readFileSync(b, 'utf8'), scriptKindName: 'TS' },
] }); // fire-and-forget; the awaited requests below order after it
const bDiags = async () => (await send('semanticDiagnosticsSync', { file: b })).body?.length;
const aSpans = async () => (await send('encodedSemanticClassifications-full',
	{ file: a, start: 0, length: fs.readFileSync(a, 'utf8').length, format: '2020' })).body?.spans;

const v1 = fs.readFileSync(a, 'utf8');
openBoth(v1);
console.log('before external rewrite: diags(b.ts) =', await bDiags());
// Shifted offsets: a stale Go text answers classifications at v1 positions.
fs.writeFileSync(a, '// shifted\\nfunction useThing() {}\\nexport const alpha = "str";\\nuseThing();\\n');
const v2 = fs.readFileSync(a, 'utf8');
// How the client re-syncs the open buffer after the rewrite (argv[3]).
const resync = {
	reopen: () => openBoth(v2),
	changedFiles: () => send('updateOpen', { changedFiles: [{ fileName: a, textChanges: [
		{ start: { line: 1, offset: 1 }, end: { line: v1.split('\\n').length, offset: 1 }, newText: v2 },
	] }] }),
	reload: () => send('reload', { file: a, tmpfile: a }),
}[process.argv[3]];
await resync();
console.log('after external rewrite:  diags(b.ts) =', await bDiags());
console.log('after external rewrite:  spans(a.ts) =', JSON.stringify(await aSpans()));
srv.kill();
process.exit(0);
`;

// reopen: #49 (openFiles re-send). changedFiles / reload: #74 — the reused
// tsserver program only syncs through the query-path overlay push.
const TSSERVER_RESYNC_MODES = ['reopen', 'changedFiles', 'reload'];

function runTsserver() {
	const driver = path.join(scratchRoot, 'tsserver-driver.mjs');
	fs.mkdirSync(scratchRoot, { recursive: true });
	fs.writeFileSync(driver, TSSERVER_DRIVER);
	const parse = (out) => ({
		before: +out.match(/before external rewrite: diags\(b\.ts\) = (\d+)/)?.[1],
		after: +out.match(/after external rewrite:  diags\(b\.ts\) = (\d+)/)?.[1],
		spans: out.match(/after external rewrite:  spans\(a\.ts\) = (.*)/)?.[1],
	});
	for (const mode of TSSERVER_RESYNC_MODES) {
		const outTnb = runNode(driver, [path.join(repoRoot, 'lib', 'tsserver.js'), mode], scratchRoot);
		const outStock = runNode(driver, [path.join(stockPkg, 'lib', 'tsserver.js'), mode], scratchRoot);
		const tnb = parse(outTnb), stock = parse(outStock);
		if (stock.before !== 1 || stock.after !== 0 || !stock.spans || stock.spans === '[]') {
			return fail('tsserver', `${mode}: stock control diverged from issue table: ${JSON.stringify(stock)}\n${outStock}`);
		}
		if (JSON.stringify(tnb) !== JSON.stringify(stock)) {
			return fail('tsserver', `${mode}: phase mismatch vs stock:\n  tnb:   ${JSON.stringify(tnb)}\n  stock: ${JSON.stringify(stock)}\n--- tnb output ---\n${outTnb}`);
		}
	}
	console.log(`[tsserver] ok (${TSSERVER_RESYNC_MODES.join('/')}: before=1, after=0, rewritten-file classifications stock-identical)`);
	return true;
}

// ── Repro 3: plain tsc -w ────────────────────────────────────────────────

function tscWatchOnce(tscPath) {
	return new Promise((resolve) => {
		const dir = path.join(scratchRoot, 'tscwatch');
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a: number = 1;\n');
		fs.writeFileSync(path.join(dir, 'entry.ts'), 'import { a } from "./a";\nconst s: string = a;\nexport { s };\n');
		fs.writeFileSync(path.join(dir, 'tsconfig.json'),
			'{"compilerOptions":{"strict":true,"noEmit":true,"types":[]},"include":["*.ts"]}\n');

		const proc = spawn('node', [tscPath, '-w', '--preserveWatchOutput', 'false'], { cwd: dir, env: tnbEnv, stdio: ['ignore', 'pipe', 'inherit'] });
		let out = '';
		let blockCount = 0;
		const blocks = [];
		let current = '';
		const deadline = setTimeout(() => {
			proc.kill('SIGKILL');
			resolve({ out, error: `timeout waiting for watch block ${blockCount + 1}` });
		}, 90_000);
		proc.stdout.on('data', (d) => {
			out += d;
			current += d;
			if (/Watching for file changes\./.test(current)) {
				blocks.push(current);
				current = '';
				blockCount++;
				if (blockCount === 1) {
					// content edit: should clear the entry.ts error
					fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = "str";\n');
				}
				else if (blockCount === 2) {
					// file add: should surface added.ts's own error
					fs.writeFileSync(path.join(dir, 'added.ts'), 'export const extra: string = 42;\n');
				}
				else if (blockCount === 3) {
					clearTimeout(deadline);
					proc.kill('SIGKILL');
					resolve({ out });
				}
			}
		});
	});
}

async function runTscwatchCase() {
	const norm = (s) => stripAnsi(s)
		.replace(/^\[[^\]]*\]\s*/gm, '')                    // [hh:mm:ss AM] watch timestamps
		.replace(/[^\n]*TNB ACTIVE[^\n]*\n?/g, '')          // TNB banner
		.replace(/File change detected\.\s*/g, '')
		.replace(/\r/g, '');
	const outTnb = await tscWatchOnce(path.join(repoRoot, 'lib', 'tsc.js'));
	if (outTnb.error) return fail('tscwatch', outTnb.error + `\n${outTnb.out}`);
	const outStock = await tscWatchOnce(path.join(stockPkg, 'lib', 'tsc.js'));
	if (outStock.error) return fail('tscwatch', 'stock: ' + outStock.error + `\n${outStock.out}`);
	const a = norm(outTnb.out), b = norm(outStock.out);
	const count = (s) => [...s.matchAll(/Found (\d+) errors?\./g)].map(m => +m[1]);
	const tnbCounts = count(a), stockCounts = count(b);
	if (JSON.stringify(stockCounts) !== JSON.stringify([1, 0, 1])) {
		return fail('tscwatch', `stock control diverged from issue table: ${JSON.stringify(stockCounts)}\n${b}`);
	}
	if (JSON.stringify(tnbCounts) !== JSON.stringify(stockCounts)) {
		return fail('tscwatch', `error counts mismatch vs stock:\n  tnb:   ${JSON.stringify(tnbCounts)}\n  stock: ${JSON.stringify(stockCounts)}\n--- tnb ---\n${a}\n--- stock ---\n${b}`);
	}
	const diagLines = (s) => s.split('\n').filter(l => /error TS/.test(l)).sort();
	if (JSON.stringify(diagLines(a)) !== JSON.stringify(diagLines(b))) {
		return fail('tscwatch', `diagnostic lines mismatch vs stock:\n--- tnb ---\n${a}\n--- stock ---\n${b}`);
	}
	console.log('[tscwatch] ok (error counts 1→0→1, diagnostic lines stock-identical)');
	return true;
}

// ── Repro 4: stable host-SF cache vs external rewrite (constant-version host) ──
// Issue E: _hostSfStableGlobal reuses the bound host AST while the script
// version is unchanged. Under a constant-version host (typescript-estree's
// getScriptVersion always "1"), an externally-rewritten node_modules .d.ts
// re-reads on the Go side (issue #49 fileChanges.changed) while the JS side
// keeps serving the stale stable AST — a silent cross-side mismatch. Stock
// re-reads disk on the next program (no cross-program AST cache), so both
// stock and TNB must surface the NEW text. The host forces preferHostSourceFiles
// via a divergent snapshot on the root file (the overlay path the stable
// cache was built for). No change signal is fed: a direct createProgram's
// only freshness source is the bridge's disk stamp.

const STABLE_DRIVER = `
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const ts = require2(process.argv[2]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-stable-'));
const pkgRel = path.join('node_modules', 'tnb-stable-pkg', 'index.d.ts');
fs.mkdirSync(path.join(dir, 'node_modules', 'tnb-stable-pkg'), { recursive: true });
fs.writeFileSync(path.join(dir, 'node_modules', 'tnb-stable-pkg', 'package.json'), JSON.stringify({ name: 'tnb-stable-pkg', types: 'index.d.ts' }));
fs.writeFileSync(path.join(dir, pkgRel), 'export declare const stableValue: string;\\n');
fs.writeFileSync(path.join(dir, 'entry.ts'), 'import { stableValue } from "tnb-stable-pkg";\\nexport const b: string = stableValue;\\n');
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'commonjs', moduleResolution: 'node', types: [] },
	include: ['entry.ts'],
}));
const pkgDts = fs.realpathSync(path.join(dir, pkgRel));
const entry = fs.realpathSync(path.join(dir, 'entry.ts'));
const tsconfig = fs.realpathSync(path.join(dir, 'tsconfig.json'));
const options = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }).options;

const makeHost = () => {
	const host = ts.createCompilerHost(options);
	host.getScriptVersion = () => '1'; // constant-version host (typescript-estree style)
	// Divergent snapshot on the root file -> overlay -> preferHostSourceFiles
	// (the path that populates the stable host-SF cache).
	host.getScriptSnapshot = (f) => {
		if (path.resolve(f) === entry) {
			return ts.ScriptSnapshot.fromString('import { stableValue } from "tnb-stable-pkg";\\nexport const b: string = stableValue;\\n// OVERLAY_SNAPSHOT\\n');
		}
		return undefined;
	};
	return host;
};
const opts = { rootNames: [entry], options, configFilePath: tsconfig };

const program1 = ts.createProgram({ ...opts, host: makeHost() });
const sf1 = program1.getSourceFile(pkgDts);
console.log('gen1 hasMarker:', !!sf1?.text?.includes('V1_MARKER'));

fs.writeFileSync(pkgDts, 'export declare const stableValue: number; // V1_MARKER\\n');

const program2 = ts.createProgram({ ...opts, host: makeHost() });
const sf2 = program2.getSourceFile(pkgDts);
console.log('gen2 hasMarker:', !!sf2?.text?.includes('V1_MARKER'));
console.log('sameObject:', sf1 === sf2);
`;

function runStablecacheCase() {
	const driver = path.join(scratchRoot, 'stablecache-driver.mjs');
	fs.mkdirSync(scratchRoot, { recursive: true });
	fs.writeFileSync(driver, STABLE_DRIVER);
	const outTnb = runNode(driver, [path.join(repoRoot, 'lib', 'typescript.js')], scratchRoot);
	const outStock = runNode(driver, [path.join(stockPkg, 'lib', 'typescript.js')], scratchRoot);
	const parse = (out) => {
		const grab = (label) => {
			const m = out.match(new RegExp(label + ':\\s*(true|false)'));
			return m ? m[1] === 'true' : undefined;
		};
		return { g1: grab('gen1 hasMarker'), g2: grab('gen2 hasMarker'), same: grab('sameObject') };
	};
	const tnb = parse(outTnb), stock = parse(outStock);
	if (!(stock.g1 === false && stock.g2 === true && stock.same === false)) {
		return fail('stablecache', `stock control diverged: expected g1=false g2=true same=false, got ${JSON.stringify(stock)}\n${outStock}`);
	}
	if (!(tnb.g1 === false && tnb.g2 === true && tnb.same === false)) {
		return fail('stablecache', `external rewrite of node_modules .d.ts did not re-materialize: ${JSON.stringify(tnb)} (expected g1=false g2=true same=false)\n${outTnb}`);
	}
	console.log('[stablecache] ok (node_modules .d.ts external rewrite re-materializes under constant-version host, stock-identical)');
	return true;
}

// ── Repro 5: repeated plain createProgram, no watcher ────────────────────
// Build scripts, test runners and plugin checkers call ts.createProgram more
// than once per process with a plain CompilerHost; stock re-reads disk every
// time. Stages: a file written just before the first build (its first stamp
// can't be ordered against Go's read), an aged file rewritten to the SAME
// size (only mtime moves), and a back-to-back rewrite.

const CREATEPROGRAM_DRIVER = `
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ts = createRequire(import.meta.url)(process.argv[2]);
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-cp-')));
const a = path.join(dir, 'a.ts'), fresh = path.join(dir, 'fresh.ts');
fs.writeFileSync(a, "export const a = 'y';\\n");
fs.writeFileSync(path.join(dir, 'b.ts'), "import { a } from './a';\\nexport const s: 'x' = a;\\n");
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'] }));
const aged = new Date(Date.now() - 60_000);
for (const f of ['a.ts', 'b.ts', 'tsconfig.json']) fs.utimesSync(path.join(dir, f), aged, aged);
const tsconfig = path.join(dir, 'tsconfig.json');
const build = () => {
	const cfg = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
	const p = ts.createProgram({ rootNames: cfg.fileNames, options: cfg.options, host: ts.createCompilerHost(cfg.options) });
	return ts.getPreEmitDiagnostics(p).map(d => d.code).sort((x, y) => x - y);
};
fs.writeFileSync(fresh, 'export const f: number = 1;\\n');
console.log('stage fresh-cold:', JSON.stringify(build()));
fs.writeFileSync(fresh, 'export const f: number = "s";\\n');
console.log('stage fresh-rewrite:', JSON.stringify(build()));
fs.writeFileSync(a, "export const a = 'x';\\n");
console.log('stage aged-same-size:', JSON.stringify(build()));
fs.writeFileSync(a, "export const a = 'y';\\n");
fs.writeFileSync(fresh, 'export const f: number = 1;\\n');
console.log('stage back-to-back:', JSON.stringify(build()));
`;

function runCreateprogramCase() {
	const driver = path.join(scratchRoot, 'createprogram-driver.mjs');
	fs.mkdirSync(scratchRoot, { recursive: true });
	fs.writeFileSync(driver, CREATEPROGRAM_DRIVER);
	const parse = (out) => Object.fromEntries([...out.matchAll(/stage ([\w-]+): (\[[^\]]*\])/g)].map(m => [m[1], m[2]]));
	const outTnb = runNode(driver, [path.join(repoRoot, 'lib', 'typescript.js')], scratchRoot);
	const outStock = runNode(driver, [path.join(stockPkg, 'lib', 'typescript.js')], scratchRoot);
	const tnb = parse(outTnb), stock = parse(outStock);
	const expected = { 'fresh-cold': '[2322]', 'fresh-rewrite': '[2322,2322]', 'aged-same-size': '[2322]', 'back-to-back': '[2322]' };
	if (JSON.stringify(stock) !== JSON.stringify(expected)) {
		return fail('createprogram', `stock control diverged: ${JSON.stringify(stock)} (expected ${JSON.stringify(expected)})\n${outStock}`);
	}
	if (JSON.stringify(tnb) !== JSON.stringify(stock)) {
		return fail('createprogram', `stage mismatch vs stock:\n  tnb:   ${JSON.stringify(tnb)}\n  stock: ${JSON.stringify(stock)}\n--- tnb output ---\n${outTnb}`);
	}
	console.log('[createprogram] ok (fresh / aged same-size / back-to-back rewrites reach tsgo across plain createProgram calls, stock-identical)');
	return true;
}

// ── driver ───────────────────────────────────────────────────────────────

function fail(name, msg) {
	console.error(`[${name}] FAIL: ${msg}`);
	return false;
}

ensureStock();
const wanted = process.argv.slice(2);
const CASES = { estree: runEstree, tsserver: runTsserver, tscwatch: runTscwatchCase, stablecache: runStablecacheCase, createprogram: runCreateprogramCase };
const names = wanted.length ? wanted : Object.keys(CASES);
let ok = true;
for (const name of names) {
	const run = CASES[name];
	if (!run) { console.error(`unknown case: ${name}`); ok = false; continue; }
	try { ok = (await run()) && ok; }
	catch (e) { console.error(`[${name}] FAIL: ${e.message}`); ok = false; }
}
console.log(ok ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(ok ? 0 : 1);
