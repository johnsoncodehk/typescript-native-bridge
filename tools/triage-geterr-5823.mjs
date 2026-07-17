#!/usr/bin/env node
/**
 * T5 witness geterr-5823: stock checkUnusedLocalsAndParameters rolls the 6133
 * diagnostic for an unused single-element object binding pattern up to the whole
 * pattern span (`{ info }`); tsgo reports the element name span. The bridge widens
 * the span to the pattern to match stock (rollUpUnusedBindingPatternDiagnostic).
 *
 * Case: tsc/_failed_#5823/main.vue (sim-nav geterr missing cluster E).
 * Runs TNB vs STOCK; verdict MATCH requires identical diagnostic lists.
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
];

const rel = 'tsc/_failed_#5823/main.vue';
const file = path.join(tw, rel);

async function run(tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: fs.readFileSync(file, 'utf8'), projectRootPath: tw }] });
		const resp = await send('semanticDiagnosticsSync', { file, includeLinePosition: true });
		return (resp?.body ?? []).map((d) => {
			const s = d.start ?? d.startLocation, e = d.end ?? d.endLocation;
			return `${d.code}@${s?.line}:${s?.offset}-${e?.line}:${e?.offset}`;
		}).sort();
	});
}

console.log('=== WITNESS geterr-5823 (unused single-element object binding pattern span) ===');
const tnb = await run(tnbPath, tnbHarnessEnv());
const stock = await run(stockPath, process.env);
const match = JSON.stringify(tnb) === JSON.stringify(stock);
console.log(`-- ${rel} verdict=${match ? 'MATCH' : 'DIFF'}`);
if (!match) {
	console.log(`   TNB   ${JSON.stringify(tnb)}`);
	console.log(`   STOCK ${JSON.stringify(stock)}`);
}
console.log(match ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(match ? 0 : 1);
