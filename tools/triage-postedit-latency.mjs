#!/usr/bin/env node
// Triage: is the ~400ms post-keystroke latency completion-specific (auto-import cache)
// or generic per-edit recompute? After each keystroke, request quickinfo at a fixed
// unrelated position instead of completionInfo. If quickinfo is also ~400ms, the cost
// is program-update/re-check in the bridge, not the completion/auto-import path.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(testWorkspacePath, 'component-meta/#4577/main.vue');
const baseContent = fs.readFileSync(mainVue, 'utf8');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const INSERT_LINE = 12;
// quickinfo target: `BaseRow` on line 11 (`export type BaseRow = ...`), col 13.
const QI = { line: 11, offset: 13 };

async function run(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		const steps = [];
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: mainVue, fileContent: baseContent, projectRootPath: testWorkspacePath }],
		});
		const tw = Date.now();
		await send('quickinfo', { file: mainVue, ...QI });
		steps.push({ step: 'warmup-quickinfo', ms: Date.now() - tw });

		let typed = '';
		for (const ch of ['r', 'e', 'f']) {
			typed += ch;
			await send('updateOpen', {
				changedFiles: [{
					fileName: mainVue,
					textChanges: [{
						start: { line: INSERT_LINE, offset: typed.length },
						end: { line: INSERT_LINE, offset: typed.length },
						newText: ch,
					}],
				}],
				openFiles: [], closedFiles: [],
			});
			const tQi = Date.now();
			const qi = await send('quickinfo', { file: mainVue, ...QI });
			steps.push({ step: `edit '${typed}' then quickinfo`, ms: Date.now() - tQi, success: qi?.success });
		}
		const tRep = Date.now();
		await send('quickinfo', { file: mainVue, ...QI });
		steps.push({ step: 'repeat-no-edit', ms: Date.now() - tRep });
		return { label, steps };
	});
}

const results = [];
results.push(await run('TNB', tnbPath, tnbHarnessEnv()));
results.push(await run('STOCK', stockPath, process.env));
for (const r of results) {
	console.log(`\n=== ${r.label} ===`);
	for (const s of r.steps) console.log(`  ${s.step}: ${s.ms}ms`);
}
