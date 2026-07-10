#!/usr/bin/env node
/**
 * Q3 form A: TNB vs stock completions entry dump for #5847 (testFn in fixture.vue template).
 * Usage: node tools/triage-volar-5847-diff.mjs [--dump /tmp/out.json]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const args = process.argv.slice(2);
const dumpIdx = args.indexOf('--dump');
const dumpPath = dumpIdx >= 0 ? args[dumpIdx + 1] : undefined;

const volarRoot = resolveVolarRoot();
const defaultStock = '/tmp/stock-ts-p3/package/lib/tsserver.js';
const stockPath = process.env.STOCK_TSSERVER_PATH ?? defaultStock;
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
const cursorOffset = vueContent.indexOf('|');
const vueFileContent = vueContent.replace('|', '');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function run5847(label, tsserverPath, env) {
	return withTsserver({
		tsserverPath,
		args: harnessArgs,
		env,
	}, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
			},
		});
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [
				{ file: fixtureTs, fileContent: tsContent, projectRootPath: testWorkspacePath },
				{ file: fixtureVue, fileContent: vueFileContent, projectRootPath: testWorkspacePath },
			],
		});
		const comp = await send('completions', {
			file: fixtureVue,
			position: cursorOffset,
		});
		const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
		const testFn = entries.find(e => e.name === 'testFn');
		return {
			label,
			success: comp?.success,
			message: comp?.message,
			total: entries.length,
			testFn,
			entries,
		};
	});
}

console.log('fixture.ts:', fixtureTs);
console.log('fixture.vue:', fixtureVue);
console.log('cursor offset:', cursorOffset);
console.log('TNB:', fs.realpathSync(tnbPath));
console.log('STOCK:', stockPath);

const tnb = await run5847('TNB', tnbPath, tnbHarnessEnv());
console.log(`\nTNB: success=${tnb.success} total=${tnb.total}`);
console.log('TNB testFn:', JSON.stringify(tnb.testFn, null, 2));

if (!fs.existsSync(stockPath)) {
	console.error(`Stock tsserver missing: ${stockPath}`);
	process.exit(1);
}
const stock = await run5847('STOCK', stockPath, process.env);
console.log(`\nSTOCK: success=${stock.success} total=${stock.total}`);
console.log('STOCK testFn:', JSON.stringify(stock.testFn, null, 2));

if (dumpPath) {
	fs.writeFileSync(dumpPath, JSON.stringify({ tnb, stock }, null, 2));
	console.log(`\nWrote ${dumpPath}`);
}
