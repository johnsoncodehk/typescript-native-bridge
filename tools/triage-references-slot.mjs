/**
 * Triage: references on default slot.
 * Run: node tools/triage-references-slot.mjs
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const volarRoot = process.env.VOLAR_ROOT ?? path.resolve(__dirname, '../../../volar/vue');
const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const testWorkspacePath = path.resolve(volarRoot, 'test-workspace');
const tsserverPath = process.env.TSSERVER_PATH
	?? path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');

const fooContent = `
		<script setup lang="ts">
		import Fixture from './fixture.vue';
		</script>

		<template>
			<Fixture>
				<div></div>
			</Fixture>
		</template>
	`;

const fixtureContent = `
			<template>
				<slot|></slot>
			</template>
		`;
const offset = fixtureContent.indexOf('|');
const fixtureFileContent = fixtureContent.slice(0, offset) + fixtureContent.slice(offset + 1);

const fooFile = path.join(testWorkspacePath, 'tsconfigProject/foo.vue');
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
		openFiles: [
			{ file: fooFile, fileContent: fooContent },
			{ file: fixtureFile, fileContent: fixtureFileContent },
		],
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
