#!/usr/bin/env node
/**
 * Witness: decoded RemoteNode display tokens — optionality and template prefixes.
 *
 * Two boundary mismatches between tsgo's decoded AST and stock's display
 * machinery (issue #4):
 *   1. tsgo stores the question-mark token as `postfixToken` on some node
 *      kinds; stock reads `questionToken` — quickinfo reusing a
 *      tsgo-materialized declaration dropped `bar?: T` as `bar: T`.
 *   2. Decoded TemplateHead/Middle/Tail carry rawText="" when the producer
 *      left no raw form; stock getLiteralText prefers rawText over text with
 *      `??`, so "" shadowed the cooked text and `` `on${...}` `` prefixes
 *      vanished.
 *
 * Dual-side quickinfo, noUncheckedIndexedAccess ON (the trigger) and OFF.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const FILE = [
	'declare function stub<T>(fn: (props: T) => () => void): T;',
	'export const A = stub((_: { bar?: number }) => () => {});',   // line 2 — 可選性
	'type C = `on${Capitalize<string>}`;',                          // line 3 — 模板前綴
	'export const z: C = "onA";',
	'z;',                                                           // line 5
	'export {};',
].join('\n') + '\n';

const CASES = [
	{ name: 'optional param', line: 2, offset: 24, expect: '{ bar?: number; }' },
	{ name: 'template alias', line: 3, offset: 7, expect: '`on${Capitalize<string>}`' },
	{ name: 'template use', line: 5, offset: 1, expect: '`on${Capitalize<string>}`' },
];

const harnessArgs = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];

function makeFixture(noUIA) {
	const dir = `/tmp/tnb-display-tokens-${noUIA ? 'on' : 'off'}`;
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'fixture.ts'), FILE);
	fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: { noUncheckedIndexedAccess: noUIA },
		include: ['fixture.ts'],
	}, null, '\t') + '\n');
	return dir;
}

async function run(tsserverPath, env, dir, file) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: FILE, projectRootPath: dir }] });
		const out = [];
		for (const c of CASES) {
			const qi = await send('quickinfo', { file, line: c.line, offset: c.offset });
			out.push(qi?.body?.displayString ?? `ERROR: ${qi?.message ?? 'no body'}`);
		}
		return out;
	});
}

let fails = 0;
for (const noUIA of [true, false]) {
	const dir = makeFixture(noUIA);
	const file = path.join(dir, 'fixture.ts');
	console.log(`=== noUncheckedIndexedAccess=${noUIA} ===`);
	const tnb = await run(tnbPath, tnbHarnessEnv(), dir, file);
	const stock = await run(stockPath, process.env, dir, file);
	for (let i = 0; i < CASES.length; i++) {
		const c = CASES[i];
		const squash = s => (s ?? '').replace(/\s+/g, ' ');
		const match = squash(tnb[i]) === squash(stock[i]);
		const hasExpect = squash(tnb[i]).includes(c.expect);
		const ok = match && hasExpect;
		if (!ok) fails++;
		console.log(`-- ${c.name}@${c.line}:${c.offset} verdict=${ok ? 'MATCH' : 'DIFF'}`);
		if (!ok) {
			console.log(`   TNB   ${JSON.stringify(tnb[i])}`);
			console.log(`   STOCK ${JSON.stringify(stock[i])}`);
		}
	}
}
console.log(fails === 0 ? `VERDICT: PASS (${CASES.length * 2}/${CASES.length * 2})` : `VERDICT: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
