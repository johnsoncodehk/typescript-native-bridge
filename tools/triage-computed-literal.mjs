#!/usr/bin/env node
/**
 * Witness: binder-literal computed property names print as-written.
 *
 * `{ ["a b"]: 1 }` binds a symbol named `a b` via a ComputedPropertyName
 * wrapping a string literal (no Late checkFlag — the binder resolves the
 * literal early). Stock getNameOfSymbolAsWritten prints the literal
 * as-written ("a b" with quotes); the bridge printed the bare binder name.
 * Covers the direct string-literal names and true computed (Late) names as
 * regression guards.
 *
 * Self-built plain-TS fixture (no vue plugin); quickinfo TNB vs STOCK.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const fixtureDir = '/tmp/tnb-computed-literal';
fs.mkdirSync(fixtureDir, { recursive: true });
const file = path.join(fixtureDir, 'fixture.ts');
const LINES = [
	'const key = "key" as const;',
	'const o = {',
	'	["a b"]: 1,',   // line 3 — binder-literal computed, non-identifier
	'	["kk"]: 2,',    // line 4 — binder-literal computed, identifier-safe
	'	"a b": 3,',     // line 5 — direct string-literal name
	"	'foo': 4,",     // line 6 — direct string-literal name
	'	[0]: 5,',       // line 7 — numeric-literal computed
	'	[key]: 6,',     // line 8 — true computed (Late-bound)
	'	plain: 7,',     // line 9 — identifier
	'};',
	'export {};',
];
fs.writeFileSync(file, LINES.join('\n') + '\n');

const CASES = [
	{ name: 'binder-literal "a b"', line: 3, offset: 4 },
	{ name: 'binder-literal "kk"', line: 4, offset: 4 },
	{ name: 'direct "a b"', line: 5, offset: 3 },
	{ name: "direct 'foo'", line: 6, offset: 3 },
	{ name: 'numeric [0]', line: 7, offset: 3 },
	{ name: 'computed [key]', line: 8, offset: 4 },
	{ name: 'identifier plain', line: 9, offset: 3 },
];

const harnessArgs = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];

async function run(tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: fs.readFileSync(file, 'utf8'), projectRootPath: fixtureDir }] });
		const out = [];
		for (const c of CASES) {
			const qi = await send('quickinfo', { file, line: c.line, offset: c.offset });
			out.push(qi?.body?.displayString ?? `ERROR: ${qi?.message ?? 'no body'}`);
		}
		return out;
	});
}

console.log('=== WITNESS computed-literal (binder-literal names as-written) ===');
const tnb = await run(tnbPath, tnbHarnessEnv());
const stock = await run(stockPath, process.env);
let fails = 0;
for (let i = 0; i < CASES.length; i++) {
	const match = tnb[i] === stock[i];
	if (!match) fails++;
	console.log(`-- ${CASES[i].name}@${CASES[i].line}:${CASES[i].offset} verdict=${match ? 'MATCH' : 'DIFF'}`);
	if (!match) {
		console.log(`   TNB   ${JSON.stringify(tnb[i])}`);
		console.log(`   STOCK ${JSON.stringify(stock[i])}`);
	}
}
console.log(fails === 0 ? `VERDICT: PASS (${CASES.length}/${CASES.length})` : `VERDICT: FAIL (${fails}/${CASES.length})`);
process.exit(fails === 0 ? 0 : 1);
