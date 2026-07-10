#!/usr/bin/env node
/**
 * Hypothesis: a prior completions request (empty.vue, as in the "Auto import" test)
 * poisons/stales the export info map or tsgo batch snapshot, so a later #5847-style
 * request from fixture.vue misses testFn even though a fresh server returns it.
 */
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const emptyVue = path.join(testWorkspacePath, 'tsconfigProject/empty.vue');
const fixtureTs = path.join(testWorkspacePath, 'tsconfigProject/fixture.ts');
const fixtureVue = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');

const emptyContent = `<template>< /></template>`;
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

const summarize = e => e && ({
	kind: e.kind, kindModifiers: e.kindModifiers, sortText: e.sortText,
	source: e.source, hasAction: e.hasAction, isFromUncheckedFile: e.isFromUncheckedFile,
});

async function run(label, { priorEmptyCompletion }) {
	return withTsserver({ tsserverPath: tnbPath, args: harnessArgs, env: tnbHarnessEnv() }, async ({ send }) => {
		await send('configure', {
			preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true },
		});
		if (priorEmptyCompletion) {
			await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: emptyVue, fileContent: emptyContent }] });
			const c0 = await send('completions', { file: emptyVue, position: 11 });
			const n0 = Array.isArray(c0?.body) ? c0.body.length : c0?.body?.entries?.length ?? 0;
			console.log(`  [${label}] prior empty.vue completions: success=${c0?.success} entries=${n0}`);
		}
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: fixtureTs, fileContent: tsContent }] });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: fixtureVue, fileContent: vueContent }] });
		const comp = await send('completions', { file: fixtureVue, position: offset });
		const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
		console.log(JSON.stringify({ label, success: comp?.success, testFn: summarize(entries.find(e => e.name === 'testFn')) }));
	});
}

await run('fresh', { priorEmptyCompletion: false });
await run('afterEmptyVue', { priorEmptyCompletion: true });
