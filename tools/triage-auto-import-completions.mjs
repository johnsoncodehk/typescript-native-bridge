/**
 * Compare module-export completion entries for Auto import repro.
 * GODEBUG=asyncpreemptoff=1 node tools/triage-auto-import-completions.mjs
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

const emptyVue = path.join(testWorkspacePath, 'tsconfigProject/empty.vue');
const content = `<template>< /></template>`;
const offset = content.indexOf('<') + 1; // inside tag

const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
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
	openFiles: [{ file: emptyVue, fileContent: content }],
});

const comp = await send('completions', { file: emptyVue, position: offset });
const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
const labels = entries.map(e => e.name);
const withSource = entries.filter(e => e.source);
const vueSource = withSource.filter(e => String(e.source).includes('vue'));

console.log('tsserver:', tsserverPath.includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('total entries:', labels.length);
console.log('with source:', withSource.length);
console.log('vue module exports:', vueSource.length);
console.log('has BaseTransition:', labels.includes('BaseTransition'));
console.log('has Fragment:', labels.includes('Fragment'));
console.log('has withScopeId:', labels.includes('withScopeId'));
console.log('has Fixture:', labels.includes('Fixture'));
console.log('last 5 labels:', labels.slice(-5));

tsserver.kill?.();
