/**
 * Triage: completions → references → updateOpen (mimics vitest pollution chain).
 * Run: node tools/triage-pollution.mjs  (from repo root; needs volar/vue sibling)
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const testWorkspacePath = path.resolve(volarRoot, 'test-workspace');
const tsserverPath = path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');

async function main() {
	const tsserver = launchServer(tsserverPath, [
		'--disableAutomaticTypingAcquisition',
		'--globalPlugins', '@vue/typescript-plugin',
		'--pluginProbeLocations', pluginProbe,
		'--suppressDiagnosticEvents',
	]);

	let seq = 1;
	const send = (command, args) =>
		tsserver.message({ seq: seq++, type: 'request', command, arguments: args });

	await send('configure', {
		preferences: {
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
		},
	});

	const fixtureVue = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');
	const fooVue = path.join(testWorkspacePath, 'tsconfigProject/foo.vue');

	async function updateOpen(label, openFiles) {
		const res = await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		console.log(`\n[${label}] success=${res?.success}`);
		console.log(`  message: ${res?.message ?? '(none)'}`);
		console.log(`  body: ${JSON.stringify(res?.body)?.slice(0, 300) ?? '(none)'}`);
		return res;
	}

	const compContent = `
<script setup lang="ts">
import Component from '@/|';
</script>
`;
	const offset = compContent.indexOf('|');
	const fileContent = compContent.slice(0, offset) + compContent.slice(offset + 1);
	await updateOpen('completions open', [{ file: fixtureVue, fileContent }]);
	const comp = await send('completions', { file: fixtureVue, position: offset });
	console.log(`completions: success=${comp?.success} entries=${comp?.body?.entries?.length ?? comp?.body?.length ?? 'n/a'}`);

	const refContent = `
<script setup lang="ts">
const foo = 1;
foo;
</script>
<template><div>{{ foo }}</div></template>
`;
	await updateOpen('references open', [{ file: fooVue, fileContent: refContent }]);
	const refPos = refContent.indexOf('foo;');
	const refs = await send('references', { file: fooVue, position: refPos, includeDeclaration: false });
	console.log(`references: success=${refs?.success} count=${refs?.body?.refs?.length ?? 'n/a'}`);
	console.log(`  references message: ${refs?.message ?? '(none)'}`);

	const defContent = `
<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
</script>
<template><div>{{ count }}</div></template>
`;
	await updateOpen('definitions open (after pollution)', [{ file: fixtureVue, fileContent: defContent }]);

	tsserver.kill();
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
