#!/usr/bin/env node
// Diagnostic: dump completion entries named "default" at vue-script-global.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(testWorkspacePath, 'component-meta/#4577/main.vue');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const prefs = {
	includeCompletionsForModuleExports: true,
	includeCompletionsForImportStatements: true,
	includeCompletionsWithInsertText: true,
	includePackageJsonAutoImports: 'auto',
};

const content = fs.readFileSync(mainVue, 'utf8');

await withTsserver({
	tsserverPath: tnbPath,
	args: harnessArgs,
	env: { ...tnbHarnessEnv(), TNB_SCOPE_TRACE: '1' },
}, async ({ send }) => {
	await send('configure', { preferences: prefs });
	await send('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: mainVue, fileContent: content, projectRootPath: testWorkspacePath }],
	});
	const res = await send('completionInfo', { file: mainVue, line: 12, offset: 1 });
	const entries = res?.body?.entries ?? [];
	const defaults = entries.filter(e => e.name === 'default');
	console.log('completion default entries:', JSON.stringify(defaults, null, 2));
	console.log('total entries:', entries.length);
	if (fs.existsSync('/tmp/tnb-scope-trace.log')) {
		console.log('scope trace:\n' + fs.readFileSync('/tmp/tnb-scope-trace.log', 'utf8').slice(-2000));
	}
});
