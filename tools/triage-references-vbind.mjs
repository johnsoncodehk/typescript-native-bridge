/**
 * Triage: references on v-bind shorthand.
 * Run: node tools/triage-references-vbind.mjs
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
const tsserverPath = process.env.TSSERVER_PATH
	?? path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');

const fixtureContent = `
			<script setup lang="ts">
			const |foo = 1;
			</script>

			<template>
				<Foo :foo></Foo>
			</template>
		`;
const offset = fixtureContent.indexOf('|');
const fixtureFileContent = fixtureContent.slice(0, offset) + fixtureContent.slice(offset + 1);
const fixtureFile = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');

const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
]);

let seq = 1;
const send = (command, args) => tsserver.message({ seq: seq++, type: 'request', command, arguments: args });

try {
	await send('configure', { preferences: {} });
	await send('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: fixtureFile, fileContent: fixtureFileContent }],
	});

	const refs = await send('references', {
		file: fixtureFile,
		position: offset,
		includeDeclaration: false,
	});

	console.log('success:', refs?.success);
	console.log('message:', refs?.message ?? '(none)');
	console.log('refs count:', refs?.body?.refs?.length ?? 'n/a');
	console.log('body:', JSON.stringify(refs?.body, null, 2));
} finally {
	tsserver.kill?.();
}
