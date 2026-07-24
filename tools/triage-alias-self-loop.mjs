#!/usr/bin/env node
/**
 * getImmediateAliasedSymbol must never return the input alias itself, and the
 * wildcard-ambient-module default-export alias must resolve to its target.
 *
 * Issue #27: on the tsserver ProjectService checker path (the one
 * `parserOptions.projectService` uses), the alias created by
 * `export { default as Baz } from './thing.foo'` — where `*.foo` is a
 * wildcard ambient module with `export default bar` — self-looped:
 * refineNavSymbol swapped the RPC-resolved `default` alias for a host-refined
 * symbol with no bridge identity, resolveRpcSymbol could not route it back
 * (ambient-module export assignments were looked up in the file's exports
 * table instead of the ambient module's), the RPC short-circuited to
 * undefined, and the adapter fallback returned the input symbol itself. Alias
 * chain walks (consistent-type-exports recursion, no-deprecated while loop)
 * never terminated.
 *
 * Drives a real ts.server.ProjectService (same flavor typescript-eslint's
 * projectService option uses). Stock resolves Baz → default → bar;
 * unresolvable aliases must end in undefined, never the input symbol.
 *
 * Usage: node tools/triage-alias-self-loop.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require2(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-alias-loop-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler' },
	include: ['src.ts', 'shim.d.ts'],
}));
fs.writeFileSync(path.join(dir, 'shim.d.ts'), `declare module '*.foo' {
	const bar: { readonly label: string };
	export default bar;
}
`);
const srcText = `export { default as Baz } from './thing.foo';\n`;
fs.writeFileSync(path.join(dir, 'src.ts'), srcText);

const logger = {
	hasLevel: () => false,
	loggingEnabled: () => false,
	write: () => {},
	writeLogFile: () => {},
	info: (..._args) => {},
	msg: (..._args) => {},
	verbose: (..._args) => {},
	startGroup: () => {},
	endGroup: () => {},
	getLevel: () => 0,
};
const service = new ts.server.ProjectService({
	host: {
		getCurrentDirectory: () => dir,
		getExecutingFilePath: () => path.join(repoRoot, 'lib', 'tsserver.js'),
		getNodeMajorVersion: () => process.versions.node.split('.')[0],
		getScriptSnapshot: f => fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined,
		getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
		getNewLine: () => '\n',
		watchFile: () => ts.Noop,
		watchDirectory: () => ts.Noop,
	},
	logger,
	cancellationToken: ts.server.nullCancellationToken,
	useSingleInferredProject: false,
	useInferredProjectPerProjectRoot: false,
});
service.openClientFile(path.join(dir, 'src.ts'), srcText, ts.ScriptKind.TS);
const project = [...service.configuredProjects.values()][0] ?? service.getDefaultProjectForFile(path.join(dir, 'src.ts'), true);
const program = project.getLanguageService().getProgram();
const checker = program.getTypeChecker();
const sf = program.getSourceFile(path.join(dir, 'src.ts'));
let specifier;
(function visit(n) { if (ts.isExportSpecifier(n)) specifier = n; ts.forEachChild(n, visit); })(sf);
if (!specifier) { console.error('FAIL: no export specifier found'); process.exit(1); }

const CAP = 10;
let symbol = checker.getSymbolAtLocation(specifier.name);
const chain = [symbol?.getName?.() ?? String(symbol)];
let end = 'cap';
for (let depth = 0; depth < CAP; depth++) {
	if (!symbol) { end = 'undefined'; break; }
	if (!(symbol.flags & ts.SymbolFlags.Alias)) { end = 'value'; break; }
	const next = checker.getImmediateAliasedSymbol(symbol);
	if (next === symbol) { end = 'self'; break; }
	if (!next) { end = 'undefined'; break; }
	symbol = next;
	chain.push(symbol.getName());
}
service.dispose?.();

if (end === 'self' || end === 'cap') {
	console.error(`FAIL: alias chain does not terminate (${end}): ${chain.join(' -> ')}`);
	process.exit(1);
}
if (end !== 'value' || symbol.getName() !== 'bar') {
	console.error(`FAIL: alias chain ended at ${end === 'value' ? `\`${symbol.getName()}\`` : 'undefined'}, want non-alias \`bar\` (stock): ${chain.join(' -> ')}`);
	process.exit(1);
}
console.log('ok wildcard ambient default-export alias resolves Baz -> default -> bar (no self-loop)');
