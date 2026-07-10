#!/usr/bin/env node
/** Compare auto-import sources present in TNB vs stock completions. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

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

async function entries(label, tsserverPath, env) {
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

const tnb = await entries('TNB', tnbPath, tnbHarnessEnv());
const stock = await entries('STOCK', stockPath, process.env);

function bySource(list) {
	const m = new Map();
	for (const e of list) {
		if (!e.source) continue;
		m.set(e.source, (m.get(e.source) ?? 0) + 1);
	}
	return m;
}

const sources = ['@vue/compiler-dom', '@vue/shared', 'process', 'node:process'];
for (const src of sources) {
	console.log(`${src}: TNB=${bySource(tnb).get(src) ?? 0} STOCK=${bySource(stock).get(src) ?? 0}`);
}

const tnbCompiler = [...tnb.filter(e => e.source === '@vue/compiler-dom').map(e => e.name)].sort();
const stockCompiler = [...stock.filter(e => e.source === '@vue/compiler-dom').map(e => e.name)].sort();
const onlyStockCompiler = stockCompiler.filter(n => !tnbCompiler.includes(n));
console.log(`\n@vue/compiler-dom onlyStock names: ${onlyStockCompiler.length}`);
console.log('sample:', onlyStockCompiler.slice(0, 15).join(', '));

const tnbPathSrc = tnb.filter(e => e.source?.includes('compiler-dom'));
const tnbNames = new Set(tnb.map(e => e.name));
console.log(`\nTNB compiler-dom by path source: ${tnbPathSrc.length}`);
console.log('has BASE_TRANSITION (any source):', tnbNames.has('BASE_TRANSITION'));
console.log('path source sample:', tnbPathSrc.slice(0, 3).map(e => `${e.name} -> ${e.source?.slice(-50)}`));
