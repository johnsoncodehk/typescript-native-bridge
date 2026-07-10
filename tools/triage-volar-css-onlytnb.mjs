#!/usr/bin/env node
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

async function entries(tsserverPath, env) {
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

const tnb = await entries(path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js'), tnbHarnessEnv());
const stock = await entries('/tmp/stock-ts-p3/package/lib/tsserver.js', process.env);
const stockNames=new Set(stock.map(e=>e.name));
const onlyTnb=tnb.filter(e=>!stockNames.has(e.name));
const onlyStock=stock.filter(e=>!new Set(tnb.map(x=>x.name)).has(e.name));
console.log('onlyTnb',onlyTnb.length,'onlyStock',onlyStock.length);
const bySrc=new Map();
for (const e of onlyTnb) { if(!e.source) continue; bySrc.set(e.source,(bySrc.get(e.source)??0)+1); }
console.log('onlyTnb top sources:', [...bySrc.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12));
console.log('onlyTnb no-source', onlyTnb.filter(e=>!e.source).length);
console.log('onlyTnb names:', onlyTnb.map(e => `${e.name}(${e.source ?? 'local'})`).join(', '));
console.log('onlyStock sample:', onlyStock.slice(0,20).map(e=>`${e.name}(${e.source})`).join(', '));
