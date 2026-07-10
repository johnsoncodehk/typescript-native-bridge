#!/usr/bin/env node
/**
 * Dump all completion entries for given name(s) from TNB and stock.
 *
 * Usage:
 *   node tools/triage-dedup-entry-dump.mjs --name createApp
 *   node tools/triage-dedup-entry-dump.mjs --name createApp --name ref --out /tmp/sample.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const args = process.argv.slice(2);
const names = [];
let outPath;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--name') names.push(args[++i]);
	else if (args[i] === '--out') outPath = args[++i];
}
if (!names.length) {
	console.error('Usage: node tools/triage-dedup-entry-dump.mjs --name <name> [--name <name>...] [--out file]');
	process.exit(1);
}

const volarRoot = resolveVolarRoot();
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);
const pluginProbe = path.join(volarRoot, 'packages/language-server');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

function pickFields(e) {
	return {
		name: e.name,
		kind: e.kind,
		kindModifiers: e.kindModifiers,
		sortText: e.sortText,
		source: e.source,
		sourceDisplay: e.sourceDisplay,
		hasAction: e.hasAction,
		isRecommended: e.isRecommended,
		isFromUncheckedFile: e.isFromUncheckedFile,
		data: e.data,
		insertText: e.insertText,
	};
}

async function fetch(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
			},
		});
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }],
		});
		const comp = await send('completionInfo', {
			file: testFile,
			line,
			offset: col,
			includeExternalModuleExports: true,
			includeInsertTextCompletions: true,
		});
		return comp?.body?.entries ?? [];
	});
}

const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const tnbEntries = await fetch('TNB', tnbPath, tnbHarnessEnv());
const stockEntries = await fetch('STOCK', stockPath, process.env);

const result = {};
for (const name of names) {
	result[name] = {
		tnb: tnbEntries.filter(e => e.name === name).map(pickFields),
		stock: stockEntries.filter(e => e.name === name).map(pickFields),
	};
}

const text = JSON.stringify(result, null, 2);
if (outPath) {
	fs.writeFileSync(outPath, text + '\n');
	console.log(`written: ${outPath}`);
} else {
	console.log(text);
}
