#!/usr/bin/env node
// Triage: completion latency while typing r -> re -> ref in main.vue <script setup>.
// User report: each keystroke waits ~500ms for the completion popup (suspected cache issue).
// Measures per-keystroke updateOpen+completionInfo round-trip, TNB vs stock.
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

// Insert typing on the blank line 12 (after `export type BaseRow ...`).
const INSERT_LINE = 12;

async function run(label, tsserverPath, env, prefs) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		const steps = [];
		const t0 = Date.now();
		await send('configure', { preferences: prefs });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: mainVue, fileContent: baseContent, projectRootPath: testWorkspacePath }],
		});
		// Warm up: initial completion at line start (simulates opening the file and first interaction).
		const warm0 = Date.now();
		await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: 1 });
		steps.push({ step: 'warmup-completion', ms: Date.now() - warm0 });

		let typed = '';
		for (const ch of ['r', 'e', 'f']) {
			typed += ch;
			const tEdit = Date.now();
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
			const editMs = Date.now() - tEdit;
			const tComp = Date.now();
			const comp = await send('completionInfo', {
				file: mainVue, line: INSERT_LINE, offset: typed.length + 1,
			});
			const compMs = Date.now() - tComp;
			const entries = comp?.body?.entries?.length ?? 0;
			const hasRef = (comp?.body?.entries ?? []).some(e => e.name === 'ref');
			steps.push({ step: `type '${typed}'`, editMs, compMs, entries, hasRef, success: comp?.success });
		}
		// Repeat the last completion without any edit — isolates cache/recompute behavior.
		for (let i = 0; i < 2; i++) {
			const tRep = Date.now();
			const comp = await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: typed.length + 1 });
			steps.push({ step: `repeat-no-edit #${i + 1}`, compMs: Date.now() - tRep, entries: comp?.body?.entries?.length ?? 0 });
		}
		return { label, totalMs: Date.now() - t0, steps };
	});
}

const autoImportPrefs = {
	includeCompletionsForModuleExports: true,
	includeCompletionsForImportStatements: true,
	includeCompletionsWithInsertText: true,
	includePackageJsonAutoImports: 'auto',
	includeCompletionsWithSnippetText: true,
	useLabelDetailsInCompletionEntries: true,
};

const results = [];
results.push(await run('TNB', tnbPath, tnbHarnessEnv(), autoImportPrefs));
results.push(await run('STOCK', stockPath, process.env, autoImportPrefs));

for (const r of results) {
	console.log(`\n=== ${r.label} (total ${r.totalMs}ms) ===`);
	for (const s of r.steps) {
		const parts = [`${s.step}:`];
		if (s.editMs !== undefined) parts.push(`edit=${s.editMs}ms`);
		if (s.compMs !== undefined) parts.push(`completion=${s.compMs}ms`);
		if (s.ms !== undefined) parts.push(`${s.ms}ms`);
		if (s.entries !== undefined) parts.push(`entries=${s.entries}`);
		if (s.hasRef !== undefined) parts.push(`hasRef=${s.hasRef}`);
		console.log('  ' + parts.join(' '));
	}
}

const tnbType = results[0].steps.filter(s => s.step.startsWith('type'));
const stockType = results[1].steps.filter(s => s.step.startsWith('type'));
const tnbAvg = tnbType.reduce((a, s) => a + s.compMs, 0) / tnbType.length;
const stockAvg = stockType.reduce((a, s) => a + s.compMs, 0) / stockType.length;
console.log(`\nper-keystroke completion avg: TNB=${tnbAvg.toFixed(0)}ms STOCK=${stockAvg.toFixed(0)}ms ratio=${(tnbAvg / stockAvg).toFixed(1)}x`);
