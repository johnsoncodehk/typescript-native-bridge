#!/usr/bin/env node
// Triage: CPU-profile the tsserver process during per-keystroke completionInfo.
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
const PROF_DIR = '/tmp/tnb-completion-cpuprof';
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
	await send('configure', { preferences: {} });
	await send('updateOpen', {
		changedFiles: [], closedFiles: [],
		openFiles: [{ file: mainVue, fileContent: baseContent, projectRootPath: testWorkspacePath }],
	});
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
		const t0 = Date.now();
		await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: typed.length + 1 });
		console.log(`'${typed}' completionInfo: ${Date.now() - t0}ms`);
	}
	send('exit', undefined).catch(() => {});
	await new Promise(r => setTimeout(r, 2500));
});
console.log('profiles:', fs.readdirSync(PROF_DIR));
