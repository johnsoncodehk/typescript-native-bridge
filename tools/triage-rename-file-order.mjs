/**
 * Compare program source file order for rename repro (stock vs TNB).
 * node tools/triage-rename-file-order.mjs
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const testWorkspacePath = path.resolve(volarRoot, 'test-workspace');
const tsserverPath = path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
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
			defineProps({ aaaBbb: String });
			</script>
		`;
const fixtureOffset = fixtureContent.indexOf('aaaBbb');

const fooUri = path.join(testWorkspacePath, 'tsconfigProject/foo.vue');
const fixtureUri = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');

const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
]);

let seq = 1;
const send = (command, args) => tsserver.message({ seq: seq++, type: 'request', command, arguments: args });

// Open foo first, then fixture (same as test)
await send('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [
		{ file: fooUri, fileContent: fooContent },
		{ file: fixtureUri, fileContent: fixtureContent },
	],
});

const rename = await send('rename', {
	file: fixtureUri,
	position: fixtureOffset,
	findInStrings: false,
	findInComments: false,
});

console.log('tsserver:', tsserverPath.includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('locs file order:', rename?.body?.locs?.map(l => path.basename(l.file)));
console.log('first file locs count:', rename?.body?.locs?.[0]?.locs?.length);

tsserver.kill?.();
