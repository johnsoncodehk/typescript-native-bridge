#!/usr/bin/env node
/**
 * T5 witness f2hl-typesref: documentHighlights on a `/// <reference types="vue/jsx" />`
 * triple-slash types reference must highlight the reference (stock resolves the types
 * reference through the host program's resolvedTypeReferenceDirectiveReferences; the
 * bridge mirrors that when mapping tsgo positions back to host nodes).
 *
 * Case: tsc/#2472/main.vue (sim-nav highlights missing cluster B).
 * Runs TNB vs STOCK; verdict MATCH requires identical loc sets.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const tw = path.join(volarRoot, 'test-workspace');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const CASES = [
	['tsc/#2472/main.vue', 2, 23],
	['tsc/#2472/main.vue', 2, 27],
];

async function run(tsserverPath, env, rel, line, offset) {
	const file = path.join(tw, rel);
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: fs.readFileSync(file, 'utf8'), projectRootPath: tw }] });
		const resp = await send('documentHighlights', { file, line, offset, filesToSearch: [file] });
		const locs = (resp?.body ?? []).flatMap((d) => (d.highlightSpans ?? []).map((s) => `${rel}|${s.start.line}|${s.start.offset}`));
		return { success: !!resp?.success, locs: [...new Set(locs)].sort() };
	});
}

console.log('=== WITNESS f2hl-typesref (triple-slash types reference highlights) ===');
let fails = 0;
for (const [rel, line, offset] of CASES) {
	const tnb = await run(tnbPath, tnbHarnessEnv(), rel, line, offset);
	const stock = await run(stockPath, process.env, rel, line, offset);
	const match = tnb.success === stock.success && JSON.stringify(tnb.locs) === JSON.stringify(stock.locs);
	if (!match) fails++;
	console.log(`-- ${rel}:${line}:${offset} verdict=${match ? 'MATCH' : 'DIFF'}`);
	if (!match) {
		console.log(`   TNB   ${JSON.stringify(tnb.locs)}`);
		console.log(`   STOCK ${JSON.stringify(stock.locs)}`);
	}
}
console.log(fails === 0 ? 'VERDICT: PASS' : `VERDICT: FAIL (${fails}/${CASES.length})`);
process.exit(fails === 0 ? 0 : 1);
