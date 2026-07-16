#!/usr/bin/env node
// Triage: CPU-profile steady-state typing (completionInfo + getCodeFixes per
// keystroke) in main.vue, excluding warmup. A 3s idle gap separates warmup
// from the typing loop so the analyzer can bucket samples after the gap.
// Sends `exit` at the end so --cpu-prof flushes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(testWorkspacePath, 'component-meta/#4577/main.vue');
const baseContent = fs.readFileSync(mainVue, 'utf8');
const PROF_DIR = '/tmp/tnb-typing-cpuprof';
const INSERT_LINE = 12;

fs.rmSync(PROF_DIR, { recursive: true, force: true });
fs.mkdirSync(PROF_DIR, { recursive: true });

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

await withTsserver({
	tsserverPath: tnbPath,
	args: harnessArgs,
	env: tnbHarnessEnv({ NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${PROF_DIR}` }),
}, async ({ send }) => {
	await send('configure', {
		preferences: process.env.TYPING_PROF_AUTOIMPORT === '1' ? {
			includeCompletionsForModuleExports: true,
			includeCompletionsForImportStatements: true,
			includeCompletionsWithInsertText: true,
			includePackageJsonAutoImports: 'auto',
			includeCompletionsWithSnippetText: true,
			useLabelDetailsInCompletionEntries: true,
		} : {},
	});
	await send('updateOpen', {
		changedFiles: [], closedFiles: [],
		openFiles: [{ file: mainVue, fileContent: baseContent, projectRootPath: testWorkspacePath }],
	});
	// Warmup: full first-time costs (program, caches, first completion+codefix).
	await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: 1 });
	await send('getCodeFixes', {
		file: mainVue, startLine: INSERT_LINE, startOffset: 1,
		endLine: INSERT_LINE, endOffset: 1, errorCodes: [2304],
	}).catch(() => {});
	// Idle gap marker (3s) separating warmup from steady-state.
	await new Promise(r => setTimeout(r, 3000));

	// Steady-state typing: 2 rounds of r -> e -> f, with delete between rounds.
	for (let round = 0; round < 2; round++) {
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
			const t0 = Date.now();
			await send('getCodeFixes', {
				file: mainVue, startLine: INSERT_LINE, startOffset: 1,
				endLine: INSERT_LINE, endOffset: typed.length + 1, errorCodes: [2304],
			}).catch(() => {});
			const t1 = Date.now();
			await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: typed.length + 1 });
			console.log(`round${round} '${typed}': codefix=${t1 - t0}ms completion=${Date.now() - t1}ms`);
		}
		// Delete the 3 chars.
		await send('updateOpen', {
			changedFiles: [{
				fileName: mainVue,
				textChanges: [{ start: { line: INSERT_LINE, offset: 1 }, end: { line: INSERT_LINE, offset: 4 }, newText: '' }],
			}],
			openFiles: [], closedFiles: [],
		});
	}
	send('exit', undefined).catch(() => {});
	await new Promise(r => setTimeout(r, 2500));
});
console.log('profiles:', fs.readdirSync(PROF_DIR));
