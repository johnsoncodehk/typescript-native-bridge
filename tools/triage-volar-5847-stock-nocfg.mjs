#!/usr/bin/env node
/**
 * Ground-truth check: does STOCK tsserver also degrade testFn to a warning
 * entry when includeCompletionsForModuleExports is NOT configured (the
 * isolated `-t "#5847"` vitest scenario)?
 */
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = '/tmp/stock-ts-p3/package/lib/tsserver.js';
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const fixtureTs = path.join(testWorkspacePath, 'tsconfigProject/fixture.ts');
const fixtureVue = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');
const tsContent = `export function testFn() { console.log('testFn'); }`;
const vueContentRaw = `
<script setup></script>

<template>{{ testFn| }}</template>
`;
const offset = vueContentRaw.indexOf('|');
const vueContent = vueContentRaw.slice(0, offset) + vueContentRaw.slice(offset + 1);

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

await withTsserver({ tsserverPath: stockPath, args: harnessArgs }, async ({ send }) => {
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: fixtureTs, fileContent: tsContent }] });
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: fixtureVue, fileContent: vueContent }] });
	const comp = await send('completions', { file: fixtureVue, position: offset });
	const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
	const testFn = entries.find(e => e.name === 'testFn');
	console.log(JSON.stringify({
		label: 'stock-noConfigure',
		success: comp?.success,
		testFn: testFn && {
			kind: testFn.kind, kindModifiers: testFn.kindModifiers, sortText: testFn.sortText,
			source: testFn.source, hasAction: testFn.hasAction, isFromUncheckedFile: testFn.isFromUncheckedFile,
		},
	}));
});
