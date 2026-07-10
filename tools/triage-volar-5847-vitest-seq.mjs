#!/usr/bin/env node
/**
 * Replicate vitest #5847 request sequence (no projectRootPath, no includeCompletionsForModuleExports).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const fixtureTs = path.join(testWorkspacePath, 'tsconfigProject/fixture.ts');
const fixtureVue = path.join(testWorkspacePath, 'tsconfigProject/fixture.vue');
const tsContent = `export function testFn() { console.log('testFn'); }`;
const vueContent = `
<script setup></script>

<template>{{ testFn| }}</template>
`;
const offset = vueContent.indexOf('|');
const vueFileContent = vueContent.slice(0, offset) + vueContent.slice(offset + 1);

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function runVitestSeq(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		// vitest server.ts open(): updateOpen WITHOUT projectRootPath
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [
				{ file: fixtureTs, fileContent: tsContent },
				{ file: fixtureVue, fileContent: vueFileContent },
			],
		});
		const comp = await send('completions', { file: fixtureVue, position: offset });
		const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
		const testFn = entries.find(e => e.name === 'testFn');
		return { label, success: comp?.success, message: comp?.message, total: entries.length, testFn };
	});
}

console.log('vitest-seq: no projectRootPath, no configure');
console.log('TNB:', fs.realpathSync(tnbPath));
console.log('STOCK:', stockPath);

const tnb = await runVitestSeq('TNB', tnbPath, tnbHarnessEnv());
console.log('\nTNB:', JSON.stringify(tnb, null, 2));

if (fs.existsSync(stockPath)) {
	const stock = await runVitestSeq('STOCK', stockPath, process.env);
	console.log('\nSTOCK:', JSON.stringify(stock, null, 2));
}
