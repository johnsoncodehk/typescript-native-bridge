#!/usr/bin/env node
// Triage: does an in-flight geterr (semantic check) serialize/block a subsequent
// completionInfo after a keystroke? Simulates the IDE pattern:
//   updateOpen(edit) -> geterr(delay=0) -> immediately completionInfo
// Measures completion round-trip with and without the interleaved geterr,
// TNB vs stock. If TNB's completion RTT balloons only when geterr is in flight,
// the bottleneck is uninterruptible semantic-check serialization, not completion itself.
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
	// NOTE: no --suppressDiagnosticEvents; we want geterr to actually run.
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
		// Warm up program + first completion.
		await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: 1 });

		let typed = '';
		for (const [i, ch] of ['r', 'e', 'f'].entries()) {
			typed += ch;
			const withGeterr = i % 2 === 0 ? true : false; // alternate: r->geterr, e->plain, f->geterr
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
			if (withGeterr) {
				// Fire-and-forget: geterr has no direct response; it emits events.
				// Don't await; swallow the eventual timeout/requestCompleted resolution.
				send('geterr', { files: [mainVue], delay: 0 }, 30_000).catch(() => {});
				// Give the server a beat to start the errorCheck step, like a real IDE pause.
				await new Promise(r => setTimeout(r, 10));
			}
			const t0 = Date.now();
			const comp = await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: typed.length + 1 });
			steps.push({
				step: `type '${typed}'${withGeterr ? ' +geterr-in-flight' : ''}`,
				compMs: Date.now() - t0,
				entries: comp?.body?.entries?.length ?? 0,
			});
		}
		return { label, steps };
	});
}

const results = [];
results.push(await run('TNB', tnbPath, tnbHarnessEnv()));
results.push(await run('STOCK', stockPath, process.env));
for (const r of results) {
	console.log(`\n=== ${r.label} ===`);
	for (const s of r.steps) console.log(`  ${s.step}: completion=${s.compMs}ms entries=${s.entries}`);
}
const pick = (r, withG) => r.steps.filter(s => s.step.includes('+geterr') === withG).map(s => s.compMs);
for (const r of results) {
	console.log(`${r.label}: with-geterr=${JSON.stringify(pick(r, true))} plain=${JSON.stringify(pick(r, false))}`);
}
