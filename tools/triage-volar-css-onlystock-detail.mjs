#!/usr/bin/env node
/** List onlyStock completion entries grouped by source module. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function completionEntries(tsserverPath, env) {
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

const tnb = await completionEntries(tnbPath, tnbHarnessEnv());
const stock = await completionEntries(stockPath, process.env);

const tnbNames = new Set(tnb.map(e => e.name));
const onlyStock = stock.filter(e => !tnbNames.has(e.name));

const bySource = new Map();
for (const e of onlyStock) {
	const src = e.source ?? '(local)';
	bySource.set(src, (bySource.get(src) ?? 0) + 1);
}
const sorted = [...bySource.entries()].sort((a, b) => b[1] - a[1]);

console.log(`onlyStock=${onlyStock.length}`);
console.log('top sources:');
for (const [src, n] of sorted.slice(0, 25)) {
	console.log(`  ${n}\t${src}`);
}

const compilerDom = onlyStock.filter(e => e.source === '@vue/compiler-dom').map(e => e.name).sort();
if (compilerDom.length) {
	console.log(`\n@vue/compiler-dom sample (${compilerDom.length}):`, compilerDom.slice(0, 20).join(', '));
}
