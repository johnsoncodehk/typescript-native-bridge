#!/usr/bin/env node
/**
 * CLI-only compiler options must reach the Go program. TNB's tsc path has two
 * options consumers: the JS adapter sees stock parseCommandLine's merged
 * result (CLI + tsconfig + extends), while tsgo re-parses the tsconfig from
 * disk — so a flag that exists only on the CLI never reached the checker
 * (`tsconfig "strict": false` + `tsc --strict` silently reported nothing).
 * The bridge now sends the host's effective compiler options on updateSnapshot
 * (openProject entries) and Go builds the program from them.
 *
 * Each case runs one fixture through stock tsc and the fork's tsc — without
 * the CLI flags (baseline) and with them — and asserts (a) stock's diagnostic
 * set moves between baseline and flagged runs exactly as expected (vacuity
 * guard: the flags demonstrably do something) and (b) the fork's flagged run
 * is byte-identical to stock's.
 *
 * Usage: node tools/triage-cli-only-flags.mjs
 * Stock side: STOCK_TYPESCRIPT_PATH, else derived from STOCK_TSSERVER_PATH
 * (CI), else /tmp/stock-ts-p3/package/lib/typescript.js.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// lib/tsc.js, not bin/tsc: CI's isolated witness layout symlinks only
// vendor/lib/native into the tools copy — bin/ does not exist there.
// bin/tsc's tnb-godebug re-exec is replicated via GODEBUG in run()'s env.
const forkTsc = path.join(repoRoot, 'lib', 'tsc.js');
const stockTsPath = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH ? path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js') : undefined)
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';
const stockTsc = path.join(path.dirname(stockTsPath), 'tsc.js');
if (!fs.existsSync(stockTsc)) {
	console.error(`stock tsc not found at ${stockTsc} — set STOCK_TYPESCRIPT_PATH or STOCK_TSSERVER_PATH`);
	process.exit(1);
}

/** name → { tsconfig, files: { rel: text }, args, baselineCodes, flaggedCodes } */
const cases = [
	{
		name: 'strict-on-over-false',
		tsconfig: { compilerOptions: { strict: false, noEmit: true }, include: ['src'] },
		files: { 'src/a.ts': 'export function f(x) { return x; }\n' },
		args: ['--strict'],
		baselineCodes: [],
		flaggedCodes: ['TS7006'],
	},
	{
		name: 'strict-off-over-true',
		tsconfig: { compilerOptions: { strict: true, noEmit: true }, include: ['src'] },
		files: { 'src/a.ts': 'export function f(x) { return x; }\n' },
		args: ['--strict', 'false'],
		baselineCodes: ['TS7006'],
		flaggedCodes: [],
	},
	{
		name: 'noUncheckedIndexedAccess',
		tsconfig: { compilerOptions: { strict: true, noEmit: true }, include: ['src'] },
		files: { 'src/a.ts': 'declare const a: string[];\nexport const s: string = a[0];\n' },
		args: ['--noUncheckedIndexedAccess'],
		baselineCodes: [],
		flaggedCodes: ['TS2322'],
	},
	{
		name: 'target-over-es2020',
		tsconfig: { compilerOptions: { target: 'es2020', strict: true, noEmit: true }, include: ['src'] },
		files: { 'src/a.ts': 'export const b = 1n;\n' },
		args: ['--target', 'es2018'],
		// BigInt literals require ES2020+.
		baselineCodes: [],
		flaggedCodes: ['TS2737'],
	},
	{
		name: 'module-over-commonjs',
		tsconfig: { compilerOptions: { module: 'commonjs', strict: true, noEmit: true }, include: ['src'] },
		files: { 'src/a.ts': 'export const u = import.meta.url;\n' },
		args: ['--module', 'es2020', '--moduleResolution', 'bundler'],
		// import.meta is not allowed in CommonJS output, allowed under es2020.
		baselineCodes: ['TS1343'],
		flaggedCodes: [],
	},
];

function run(tscJs, cwd, args) {
	const r = spawnSync(process.execPath, [tscJs, '-p', 'tsconfig.json', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GODEBUG: 'asyncpreemptoff=1' } });
	// Diagnostics print to stdout; normalize to relative, forward-slash paths.
	return (r.stdout ?? '').replaceAll(cwd.replaceAll('\\', '/'), '.').replaceAll('\\', '/');
}
// The diagnostic SET = header lines (file,pos + code + headline). Indented
// elaboration lines are excluded: tsgo renders shallower elaborations than
// stock by design (pre-existing delta, unrelated to options flow).
const headersOf = out => out.split('\n').filter(l => l.trim() && !/^\s/.test(l)).join('\n');
const codesOf = out => [...new Set([...out.matchAll(/TS\d{4,5}/g)].map(m => m[0]))].sort();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-cli-flags-'));
let failed = 0;
for (const c of cases) {
	const dir = path.join(root, c.name);
	fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(c.tsconfig, null, 2));
	for (const [rel, text] of Object.entries(c.files)) fs.writeFileSync(path.join(dir, rel), text);

	const stockBaseline = codesOf(run(stockTsc, dir, []));
	const stockFlagged = headersOf(run(stockTsc, dir, c.args));
	const stockFlaggedCodes = codesOf(stockFlagged);
	const forkFlagged = headersOf(run(forkTsc, dir, c.args));

	const expect = (label, actual, wanted) =>
		wanted.every(code => actual.includes(code)) && actual.length === wanted.length;
	if (!expect('baseline', stockBaseline, c.baselineCodes) || !expect('flagged', stockFlaggedCodes, c.flaggedCodes)) {
		console.error(`FAIL ${c.name}: stock side moved ${JSON.stringify(stockBaseline)} → ${JSON.stringify(stockFlaggedCodes)}, `
			+ `expected ${JSON.stringify(c.baselineCodes)} → ${JSON.stringify(c.flaggedCodes)} — case is vacuous or stale.\n${stockFlagged}`);
		failed++;
		continue;
	}
	if (forkFlagged !== stockFlagged) {
		console.error(`FAIL ${c.name}: fork diagnostics diverge from stock.\n--- stock ---\n${stockFlagged}\n--- fork ---\n${forkFlagged}`);
		failed++;
		continue;
	}
	console.log(`ok ${c.name} (${c.baselineCodes.join('+') || 'clean'} → ${c.flaggedCodes.join('+') || 'clean'})`);
}
fs.rmSync(root, { recursive: true, force: true });
if (failed) {
	console.error(`FAIL: ${failed}/${cases.length} CLI-only-flag cases diverged`);
	process.exit(1);
}
console.log(`ok -- all ${cases.length} CLI-only-flag cases match stock`);
