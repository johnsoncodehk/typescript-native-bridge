#!/usr/bin/env node
/**
 * Capture the crash stack for empty.vue completions@11 when opened WITHOUT
 * projectRootPath (matches the vitest server.ts open flow).
 */
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const emptyVue = path.join(volarRoot, 'test-workspace/tsconfigProject/empty.vue');
const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

await withTsserver({ tsserverPath: tnbPath, args: harnessArgs, env: tnbHarnessEnv() }, async ({ send }) => {
	await send('configure', {
		preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true },
	});
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: emptyVue, fileContent: '<template>< /></template>' }] });
	const c = await send('completions', { file: emptyVue, position: 11 });
	console.log('success=', c?.success);
	if (!c?.success) console.log((c?.message ?? '').split('\n').slice(0, 14).join('\n'));
});
