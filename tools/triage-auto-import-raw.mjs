#!/usr/bin/env node
/**
 * Raw tsserver completion entries for Auto import repro (before vueserver).
 * GODEBUG=asyncpreemptoff=1 node tools/triage-auto-import-raw.mjs
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
// position inside empty tag: after `<`
const offset = content.indexOf('<') + 1;

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

const comp = await send('completionInfo', {
	file: emptyVue,
	includeExternalModuleExports: true,
	includeInsertTextCompletions: true,
	...offsetToLineCol(content, offset),
});

const entries = comp?.body?.entries ?? [];
const names = entries.map(e => e.name);
const withSource = entries.filter(e => e.source);
const vueExports = withSource.filter(e => String(e.source).includes('vue') || String(e.source).includes('dist/vue'));
const defineComp = entries.find(e => e.name === 'defineComponent');
const fragment = entries.find(e => e.name === 'Fragment');
const fixture = entries.find(e => e.name === 'Fixture');

console.log('tsserver:', tsserverPath.includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('success:', comp?.success, 'message:', comp?.message ?? '(none)');
console.log('total entries:', names.length);
console.log('with source:', withSource.length);
console.log('vue-sourced:', vueExports.length);
console.log('has defineComponent:', !!defineComp, defineComp ? `kind=${defineComp.kind} sort=${defineComp.sortText}` : '');
console.log('has Fragment:', !!fragment, fragment ? `kind=${fragment.kind} sort=${fragment.sortText}` : '');
console.log('has Fixture:', !!fixture, fixture ? `kind=${fixture.kind} sort=${fixture.sortText} source=${fixture.source}` : '');
if (vueExports.length) {
	console.log('vue export sample:', vueExports.slice(0, 5).map(e => `${e.name}(kind=${e.kind},sort=${e.sortText})`));
}

tsserver.kill?.();

function offsetToLineCol(text, offset) {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset; i++) {
		if (text[i] === '\n') { line++; col = 1; } else col++;
	}
	return { line, offset: col };
}
