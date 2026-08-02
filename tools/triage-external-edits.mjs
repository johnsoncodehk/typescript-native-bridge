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
 *   - tsserver: external rewrite of a.ts + updateOpen re-send must clear the
 *               dependent b.ts diagnostic.
 *   - tscwatch: plain `tsc -w` — content edit must clear the error, file add
 *               must surface the new file's error, output text stock-equal.
 * Usage: node tools/triage-external-edits.mjs [estree|tsserver|tscwatch...]
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
const cacheRoot = process.env.TNB_FW_CACHE ?? '/tmp/tnb-fw-fixtures';
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

function runEstree() {
	if (!fs.existsSync(path.join(estreeDir, 'node_modules', '@typescript-eslint', 'typescript-estree'))) {
		return fail('estree', `fixture missing — run triage-framework-checks.mjs once to populate ${estreeDir}`);
	}
	// Driver must live inside the fixture: ESM resolves the bare
	// @typescript-eslint import relative to the driver file, not cwd.
	const driver = path.join(estreeDir, '.tnb-49-driver.mjs');
	fs.mkdirSync(scratchRoot, { recursive: true });
	fs.writeFileSync(driver, ESTREE_DRIVER);
	const tsLink = path.join(estreeDir, 'node_modules', 'typescript');
	const linkTo = (target) => { fs.rmSync(tsLink, { force: true, recursive: true }); fs.symlinkSync(target, tsLink); };
	let outTnb, outStock;
	linkTo(repoRoot);
	try {
		outTnb = runNode(driver, [], estreeDir);
		linkTo(stockPkg);
		outStock = runNode(driver, [], estreeDir);
	}
	finally {
		linkTo(repoRoot);
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
] }); // fire-and-forget; the awaited diagnosticsSync below orders after it
const bDiags = async () => (await send('semanticDiagnosticsSync', { file: b })).body?.length;

openBoth(fs.readFileSync(a, 'utf8'));
console.log('before external rewrite: diags(b.ts) =', await bDiags());
fs.writeFileSync(a, 'export const alpha = "str";\\n');    // external tool rewrites a.ts
openBoth(fs.readFileSync(a, 'utf8'));                     // IDE watcher re-sends the new disk text
console.log('after external rewrite:  diags(b.ts) =', await bDiags());
srv.kill();
process.exit(0);
`;

function runTsserver() {
	const driver = path.join(scratchRoot, 'tsserver-driver.mjs');
	fs.mkdirSync(scratchRoot, { recursive: true });
	fs.writeFileSync(driver, TSSERVER_DRIVER);
	const outTnb = runNode(driver, [path.join(repoRoot, 'lib', 'tsserver.js')], scratchRoot);
	const outStock = runNode(driver, [path.join(stockPkg, 'lib', 'tsserver.js')], scratchRoot);
	const grab = (out, label) => {
		const m = out.match(new RegExp(label + 'diags\\(b\\.ts\\) = (\\d+)'));
		return m ? +m[1] : undefined;
	};
	const tnb = { before: grab(outTnb, 'before external rewrite: '), after: grab(outTnb, 'after external rewrite:  ') };
	const stock = { before: grab(outStock, 'before external rewrite: '), after: grab(outStock, 'after external rewrite:  ') };
	if (stock.before !== 1 || stock.after !== 0) {
		return fail('tsserver', `stock control diverged from issue table: ${JSON.stringify(stock)}\n${outStock}`);
	}
	if (tnb.before !== stock.before || tnb.after !== stock.after) {
		return fail('tsserver', `phase mismatch vs stock:\n  tnb:   ${JSON.stringify(tnb)}\n  stock: ${JSON.stringify(stock)}\n--- tnb output ---\n${outTnb}`);
	}
	console.log('[tsserver] ok (before=1, after=0, stock-identical)');
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

// ── driver ───────────────────────────────────────────────────────────────

function fail(name, msg) {
	console.error(`[${name}] FAIL: ${msg}`);
	return false;
}

ensureStock();
const wanted = process.argv.slice(2);
const CASES = { estree: runEstree, tsserver: runTsserver, tscwatch: runTscwatchCase };
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
