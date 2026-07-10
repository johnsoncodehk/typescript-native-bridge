#!/usr/bin/env node
/**
 * Q2: TNB vs stock completionInfo for Auto import repro (empty.vue template <| />).
 * Usage: node tools/triage-volar-auto-import-diff.mjs [--dump /tmp/out.json]
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
const emptyVue = path.join(testWorkspacePath, 'tsconfigProject/empty.vue');
const content = `<template><| /></template>`;
const cursorOffset = content.indexOf('|');
const fileContent = content.replace('|', '');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const SAMPLE_NAMES = ['BaseTransition', 'computed', 'withScopeId'];

function offsetToLineCol(text, offset) {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset; i++) {
		if (text[i] === '\n') {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	return { line, offset: col };
}

function pickEntry(entries, name) {
	return entries.find(e => e.name === name);
}

async function completionRun(label, tsserverPath, env) {
	const logs = [];
	return withTsserver({
		tsserverPath,
		args: harnessArgs,
		env,
		onEvent: ev => {
			if (ev?.event === 'log') logs.push(ev.body?.message ?? '');
		},
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
			openFiles: [{ file: emptyVue, fileContent, projectRootPath: testWorkspacePath }],
		});
		// Vue plugin getAutoImportSuggestions for template-without-script uses position 0
		// on the virtual TS file backing empty.vue (see typescript-plugin/index.ts).
		const comp0 = await send('completions', { file: emptyVue, position: 0 });
		const entries0 = Array.isArray(comp0?.body) ? comp0.body : comp0?.body?.entries ?? [];
		const auto0 = entries0.filter(e => e.source);
		const vueAuto0 = auto0.filter(e => String(e.source).includes('vue'));
		const autoImportTagged = entries0.filter(e => e.data?.__vue__autoImport || e.data?.__vue__componentAutoImport);

		const pos = offsetToLineCol(fileContent, cursorOffset);
		const compTpl = await send('completionInfo', {
			file: emptyVue,
			line: pos.line,
			offset: pos.offset,
			includeExternalModuleExports: true,
			includeInsertTextCompletions: true,
		});
		const tplEntries = compTpl?.body?.entries ?? [];

		const collectLog = logs.find(l => /collectAutoImports: resolved/.test(l));
		return {
			label,
			completionsAt0: {
				success: comp0?.success,
				message: comp0?.message,
				total: entries0.length,
				auto: auto0.length,
				vueAuto: vueAuto0.length,
				autoImportTagged: autoImportTagged.length,
			},
			completionInfoAtTemplate: {
				success: compTpl?.success,
				message: compTpl?.message,
				total: tplEntries.length,
			},
			collectLog,
			// Primary auto-import path for this fixture
			success: comp0?.success,
			message: comp0?.message,
			total: entries0.length,
			auto: auto0.length,
			vueAuto: vueAuto0.length,
			names: new Set(entries0.map(e => e.name)),
			entries: entries0,
			samples: Object.fromEntries(
				SAMPLE_NAMES.map(n => [n, pickEntry(entries0, n)]),
			),
		};
	});
}

console.log('fixture:', emptyVue);
console.log('content:', fileContent);
console.log('cursor offset:', cursorOffset, offsetToLineCol(fileContent, cursorOffset));
console.log('TNB:', fs.realpathSync(tnbPath));
console.log('STOCK:', stockPath);

const tnb = await completionRun('TNB', tnbPath, tnbHarnessEnv());
console.log(`\nTNB: success=${tnb.success} total=${tnb.total} auto=${tnb.auto} vueAuto=${tnb.vueAuto}`);

if (!fs.existsSync(stockPath)) {
	console.error(`Stock tsserver missing: ${stockPath}`);
	process.exit(1);
}
const stock = await completionRun('STOCK', stockPath, process.env);
console.log(`STOCK: success=${stock.success} total=${stock.total} auto=${stock.auto} vueAuto=${stock.vueAuto}`);

const onlyStock = [...stock.names].filter(n => !tnb.names.has(n)).sort();
const onlyTnb = [...tnb.names].filter(n => !stock.names.has(n)).sort();
const vueOnlyStock = onlyStock.filter(n =>
	['BaseTransition', 'computed', 'withScopeId', 'defineComponent', 'h', 'ref'].includes(n)
	|| stock.entries.some(e => e.name === n && String(e.source ?? '').includes('vue')),
);

console.log('\n=== diff ===');
console.log(JSON.stringify({
	onlyStock: onlyStock.length,
	onlyTnb: onlyTnb.length,
	vueOnlyStockSample: vueOnlyStock.slice(0, 20),
}, null, 2));

console.log('\n=== sample dumps ===');
for (const name of SAMPLE_NAMES) {
	console.log(`\n--- ${name} ---`);
	console.log('TNB:', JSON.stringify(tnb.samples[name] ?? null, null, 2));
	console.log('STOCK:', JSON.stringify(stock.samples[name] ?? null, null, 2));
}

console.log('\n=== stock vue auto-import proof (3 entries) ===');
const stockVueProof = stock.entries
	.filter(e => e.source && String(e.source).includes('vue'))
	.filter(e => SAMPLE_NAMES.includes(e.name) || ['defineComponent', 'h'].includes(e.name))
	.slice(0, 5);
for (const e of stockVueProof) {
	console.log(JSON.stringify(e));
}

const layer = vueOnlyStock.length > 0 || (stock.vueAuto > tnb.vueAuto)
	? '(a) TNB tsserver layer missing vue module exports'
	: '(b) tsserver parity — check Volar plugin/LSP layer';
console.log('\n=== layer verdict ===');
console.log(layer);

if (dumpPath) {
	fs.writeFileSync(dumpPath, JSON.stringify({ tnb, stock, onlyStock, onlyTnb, layer }, null, 2));
	console.log(`\nWrote ${dumpPath}`);
}
