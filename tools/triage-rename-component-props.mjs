// Debug Component props rename failure.
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const volarRoot = process.env.VOLAR_ROOT ?? path.resolve(__dirname, '../../../volar/vue');
const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const tsserverPath = process.env.TSSERVER_PATH
	?? path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');

const fooContent = `
		<template>
			<Comp :aaa-bbb="'foo'"></Comp>
			<Comp :aaaBbb="'foo'"></Comp>
		</template>

		<script lang="ts" setup>
		import Comp from './fixture.vue';
		</script>
	`;

const fixtureContent = `
			<template>
				{{ aaaBbb }}
			</template>

			<script lang="ts" setup>
			defineProps({ aaaBbb|: String });
			</script>
		`;
const fixtureOffset = fixtureContent.indexOf('|');
const fixtureFile = fixtureContent.slice(0, fixtureOffset) + fixtureContent.slice(fixtureOffset + 1);

const fooUri = path.join(testWorkspacePath, 'tsconfigProject/foo.vue');
const fixtureUri = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');

const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
]);

let seq = 1;
const send = (command, args) => tsserver.message({ seq: seq++, type: 'request', command, arguments: args });

await send('configure', { preferences: {} });
await send('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [
		{ file: fooUri, fileContent: fooContent },
		{ file: fixtureUri, fileContent: fixtureFile },
	],
});

const rename = await send('rename', {
	file: fixtureUri,
	position: fixtureOffset,
	findInStrings: false,
	findInComments: false,
});

console.log('success:', rename?.success);
console.log('message:', rename?.message);
console.log('body:', JSON.stringify(rename?.body, null, 2));

tsserver.kill?.();
