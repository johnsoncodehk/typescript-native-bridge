#!/usr/bin/env node
/**
 * Vueserver completion labels for Auto import repro.
 * cd volar/vue && GODEBUG=asyncpreemptoff=1 node path/to/triage-auto-import-vueserver.mjs
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const require = createRequire(path.join(volarRoot, 'package.json'));
const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const { PublishDiagnosticsNotification } = require('@volar/language-server');
const { startLanguageServer } = require('@volar/test-utils');
const { URI } = require('vscode-uri');

const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const tsserverPath = path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const languageServerEntry = path.join(volarRoot, 'packages/language-server/index.js');

let seq = 1;
const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
]);

await tsserver.message({
	seq: seq++,
	command: 'configure',
	arguments: {
		preferences: {
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
		},
	},
});

const vueserver = startLanguageServer(languageServerEntry, testWorkspacePath);
vueserver.connection.onNotification(PublishDiagnosticsNotification.method, () => {});
vueserver.connection.onRequest('workspace/configuration', ({ items }) =>
	items.map(({ section }) => (section?.startsWith('vue.inlayHints.') ? true : null)),
);
vueserver.connection.onNotification('tsserver/request', ([id, command, args]) => {
	tsserver.message({ seq: seq++, command, arguments: args }).then(
		res => vueserver.connection.sendNotification('tsserver/response', [id, res?.body]),
		() => vueserver.connection.sendNotification('tsserver/response', [id, undefined]),
	);
});
await vueserver.initialize(URI.file(testWorkspacePath).toString(), {}, { workspace: { configuration: true } });

const content = `<template><| /></template>`;
const offset = content.indexOf('|');
const fileContent = content.slice(0, offset) + content.slice(offset + 1);
const fileName = 'tsconfigProject/empty.vue';
const uri = URI.file(`${testWorkspacePath}/${fileName}`).toString();

const openRes = await tsserver.message({
	seq: seq++,
	command: 'updateOpen',
	arguments: {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: URI.parse(uri).fsPath, fileContent }],
	},
});
if (!openRes.success) throw new Error(openRes.message || String(openRes.body));

const document = await vueserver.openInMemoryDocument(uri, 'vue', fileContent);
const position = document.positionAt(offset);
const completions = await vueserver.sendCompletionRequest(document.uri, position);
const labels = (completions?.items ?? []).map(i => i.label);

console.log('typescript:', require.resolve('typescript/package.json').includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('total labels:', labels.length);
for (const key of [
	'defineComponent', 'Fragment', 'withScopeId', 'BaseTransition', 'BaseTransitionPropsValidators',
	'createVNode', 'customRef', 'defineAsyncComponent', 'EffectScope', 'ErrorCodes', 'Fixture', 'h', 'ref',
]) {
	console.log(`has ${key}:`, labels.includes(key));
}
const fi = labels.indexOf('Fixture');
if (fi >= 0) console.log('after Fixture:', labels.slice(fi + 1, fi + 8));

// getCompletionsAtPosition at offset 0 (auto-import path in vue plugin)
const raw0 = await tsserver.message({
	seq: seq++,
	command: 'completions',
	arguments: { file: URI.parse(uri).fsPath, position: 0 },
});
const entries0 = raw0?.body ?? [];
const vue0 = entries0.filter(e => e.source && String(e.source).includes('vue'));
const sort16 = entries0.filter(e => e.sortText === '16');
console.log('completions@0:', entries0.length, 'vue-sourced:', vue0.length, 'sortText16:', sort16.length);
if (vue0[0]) console.log('sample@0:', JSON.stringify({ name: vue0[0].name, kind: vue0[0].kind, sortText: vue0[0].sortText }));

// completionInfo at template cursor (vueserver path)
const raw = await tsserver.message({
	seq: seq++,
	command: 'completionInfo',
	arguments: {
		file: URI.parse(uri).fsPath,
		line: position.line + 1,
		offset: position.character + 1,
		includeExternalModuleExports: true,
		includeInsertTextCompletions: true,
	},
});
const entries = raw?.body?.entries ?? [];
const vueEntries = entries.filter(e => e.source && String(e.source).includes('vue'));
console.log('raw completionInfo entries:', entries.length, 'vue-sourced:', vueEntries.length);
if (vueEntries[0]) console.log('sample vue entry:', JSON.stringify({ name: vueEntries[0].name, kind: vueEntries[0].kind, sortText: vueEntries[0].sortText, source: vueEntries[0].source }));

tsserver.kill?.();
process.exit(0);
