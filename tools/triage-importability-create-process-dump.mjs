#!/usr/bin/env node
/** Dump all create/process auto-import entries TNB vs stock for css.ts */
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

async function fetch(tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', { preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }] });
		const comp = await send('completionInfo', { file: testFile, line, offset: col, includeExternalModuleExports: true, includeInsertTextCompletions: true });
		return comp?.body?.entries ?? [];
	});
}

const tnb = await fetch(path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js'), tnbHarnessEnv());
const stock = await fetch('/tmp/stock-ts-p3/package/lib/tsserver.js', process.env);

for (const name of ['create', 'process']) {
	const t = tnb.filter(e => e.name === name && e.source);
	const s = stock.filter(e => e.name === name && e.source);
	console.log(`\n${name}: TNB=${t.length} STOCK=${s.length}`);
	const tSrc = new Set(t.map(e => e.source));
	const sSrc = new Set(s.map(e => e.source));
	console.log('onlyTnb:', [...tSrc].filter(x => !sSrc.has(x)).length);
	console.log('onlyStock:', [...sSrc].filter(x => !tSrc.has(x)).length);
	console.log('TNB sources sample:', [...tSrc].slice(0, 15).join('\n  '));
	console.log('STOCK sources sample:', [...sSrc].slice(0, 15).join('\n  '));
}

const out = { create: { tnb: tnb.filter(e => e.name === 'create' && e.source), stock: stock.filter(e => e.name === 'create' && e.source) }, process: { tnb: tnb.filter(e => e.name === 'process' && e.source), stock: stock.filter(e => e.name === 'process' && e.source) } };
fs.writeFileSync('/tmp/tnb-importability-create-process-dump.json', JSON.stringify(out, null, 2));
console.log('\nwritten /tmp/tnb-importability-create-process-dump.json');
