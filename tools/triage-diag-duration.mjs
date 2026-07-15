#!/usr/bin/env node
// Triage: how long is one uninterruptible semantic-check window for main.vue?
// Uses semanticDiagnosticsSync (blocking request/response) after an edit,
// TNB vs stock. This bounds the worst-case queueing delay a completionInfo
// suffers when it lands behind an in-flight per-file check.
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

async function run(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		const steps = [];
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: mainVue, fileContent: baseContent, projectRootPath: testWorkspacePath }],
		});
		// Warm program.
		await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: 1 });

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
			const tSyn = Date.now();
			await send('syntacticDiagnosticsSync', { file: mainVue });
			const synMs = Date.now() - tSyn;
			const tSem = Date.now();
			const sem = await send('semanticDiagnosticsSync', { file: mainVue });
			steps.push({ step: `after '${typed}'`, synMs, semMs: Date.now() - tSem, n: sem?.body?.length ?? -1 });
		}
		// Steady-state: no edit, repeat check (measures re-check cost with warm caches).
		const tRep = Date.now();
		await send('semanticDiagnosticsSync', { file: mainVue });
		steps.push({ step: 'repeat-no-edit', semMs: Date.now() - tRep });
		return { label, steps };
	});
}

const results = [];
results.push(await run('TNB', tnbPath, tnbHarnessEnv()));
results.push(await run('STOCK', stockPath, process.env));
for (const r of results) {
	console.log(`\n=== ${r.label} ===`);
	for (const s of r.steps) {
		console.log(`  ${s.step}: syn=${s.synMs ?? '-'}ms sem=${s.semMs}ms diags=${s.n ?? '-'}`);
	}
}
