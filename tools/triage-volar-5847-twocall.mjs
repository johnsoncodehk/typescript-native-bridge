#!/usr/bin/env node
/**
 * Simulate vue plugin two-call completion merge for #5847.
 */
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const fixtureTs = path.join(testWorkspacePath, 'tsconfigProject/fixture.ts');
const fixtureVue = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');
const tsContent = `export function testFn() { console.log('testFn'); }`;
const vueContent = `
<script setup></script>

<template>{{ testFn| }}</template>
`;
const templateOffset = vueContent.indexOf('|');
const vueFileContent = vueContent.slice(0, templateOffset) + vueContent.slice(templateOffset + 1);

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

function summarize(e) {
	return e ? { kind: e.kind, kindModifiers: e.kindModifiers, sortText: e.sortText, source: e.source, hasAction: e.hasAction, isFromUncheckedFile: e.isFromUncheckedFile } : null;
}

await withTsserver({ tsserverPath: tnbPath, args: harnessArgs, env: tnbHarnessEnv() }, async ({ send }) => {
	const withCfg = process.argv.includes('--configure');
	if (withCfg) {
		await send('configure', {
			preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true },
		});
	}
	console.log('configure:', withCfg);
	await send('updateOpen', {
		changedFiles: [], closedFiles: [],
		openFiles: [
			{ file: fixtureTs, fileContent: tsContent },
			{ file: fixtureVue, fileContent: vueFileContent },
		],
	});
	// template position
	const c1 = await send('completions', { file: fixtureVue, position: templateOffset });
	const e1 = (Array.isArray(c1?.body) ? c1.body : c1?.body?.entries ?? []).find(x => x.name === 'testFn');
	console.log('call1 template:', JSON.stringify(summarize(e1)));
	// scan positions for proper testFn (simulate plugin second call search)
	for (const pos of [0, 1, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500]) {
		const c = await send('completions', { file: fixtureVue, position: pos });
		const entries = Array.isArray(c?.body) ? c.body : c?.body?.entries ?? [];
		const testFn = entries.find(x => x.name === 'testFn');
		if (testFn && testFn.kind !== 'warning') {
			console.log(`call2 pos=${pos}:`, JSON.stringify(summarize(testFn)));
		}
	}
});
