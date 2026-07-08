// Compare vue module export enumeration (stock vs TNB).
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const volarRoot = resolveVolarRoot();
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const tsconfigPath = path.join(testWorkspacePath, 'tsconfigProject/tsconfig.json');

const tsserverPath = process.env.TSSERVER_PATH
	?? path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');

const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const pluginProbe = path.join(volarRoot, 'packages/language-server');

const emptyUri = path.join(testWorkspacePath, 'tsconfigProject/empty.vue');
const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
]);

let seq = 1;
const send = (command, args) => tsserver.message({ seq: seq++, type: 'request', command, arguments: args });

await send('configure', {
	preferences: {
		includeCompletionsForModuleExports: true,
		includeCompletionsWithInsertText: true,
	},
});
await send('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [{ file: emptyUri, fileContent: '<template></template>' }],
});

const completion = await send('completionInfo', {
	file: emptyUri,
	line: 1,
	offset: 10,
	includeExternalModuleExports: true,
	includeInsertTextCompletions: true,
});

const labels = (completion?.body?.entries ?? []).map(e => e.name).filter(Boolean);
const vueExports = labels.filter(n => ['defineComponent', 'h', 'ref', 'computed', 'Fixture', 'Foo'].includes(n));
console.log('tsserver:', tsserverPath);
console.log('total entries:', labels.length);
console.log('key labels:', vueExports);
console.log('has defineComponent:', labels.includes('defineComponent'));
console.log('has Fixture:', labels.includes('Fixture'));
console.log('has Foo:', labels.includes('Foo'));

tsserver.kill?.();
