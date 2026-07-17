#!/usr/bin/env node
/**
 * T5 witness f2hl-defaultkw: `{ default as X }` ImportSpecifier 的 `default`
 * 關鍵字位點 —— stock 經 aliased target 解析讓 highlights/refs/quickinfo 落對
 * scope；bridge 對 propertyName 走 RPC aliased target 後一致。
 *
 * Case: tsc/#5067/main.vue 5:2 (sim-nav highlights missing cluster D).
 * Runs TNB vs STOCK; verdict MATCH requires identical results.
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

const rel = 'tsc/#5067/main.vue';
const file = path.join(tw, rel);

async function run(tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: fs.readFileSync(file, 'utf8'), projectRootPath: tw }] });
		const hl = await send('documentHighlights', { file, line: 5, offset: 2, filesToSearch: [file] });
		const refs = await send('references', { file, line: 5, offset: 2 });
		const qi = await send('quickinfo', { file, line: 5, offset: 2 });
		return {
			hl: [...new Set((hl?.body ?? []).flatMap((d) => (d.highlightSpans ?? []).map((s) => `${s.start.line}|${s.start.offset}`)))].sort(),
			refs: (refs?.body?.refs ?? []).map((r) => `${r.file.split('/test-workspace/')[1]}|${r.start.line}|${r.start.offset}`).sort(),
			qi: qi?.body?.displayString ?? null,
		};
	});
}

console.log('=== WITNESS f2hl-defaultkw ({ default as X } keyword site) ===');
const tnb = await run(tnbPath, tnbHarnessEnv());
const stock = await run(stockPath, process.env);
let fails = 0;
for (const k of ['hl', 'refs']) {
	const match = JSON.stringify(tnb[k]) === JSON.stringify(stock[k]);
	if (!match) fails++;
	console.log(`-- ${k}@5:2 verdict=${match ? 'MATCH' : 'DIFF'}`);
	if (!match) {
		console.log(`   TNB   ${JSON.stringify(tnb[k])}`);
		console.log(`   STOCK ${JSON.stringify(stock[k])}`);
	}
}
// qi displayString is informational only: known non-key Go-printer fidelity
// divergence (truncation / member order / optionality — same family as the T4
// qi WONTFIX list), not a sim key.
console.log(`-- qi@5:2 info (non-key): ${JSON.stringify(tnb.qi) === JSON.stringify(stock.qi) ? 'same' : 'known non-key divergence'}`);
console.log(fails === 0 ? 'VERDICT: PASS' : `VERDICT: FAIL (${fails}/2)`);
process.exit(fails === 0 ? 0 : 1);
