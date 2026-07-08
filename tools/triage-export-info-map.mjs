#!/usr/bin/env node
/**
 * Capture tsserver verbose log around export map / auto-import for empty.vue.
 * cd volar/vue && GODEBUG=asyncpreemptoff=1 node path/to/triage-export-info-map.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const testWorkspacePath = path.resolve(volarRoot, 'test-workspace');
const tsserverPath = path.join(volarRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const logFile = path.join(os.tmpdir(), `tnb-export-map-${Date.now()}.log`);

const emptyVue = path.join(testWorkspacePath, 'tsconfigProject/empty.vue');
const content = `<template>< /></template>`;
const offset = content.indexOf('<') + 1;

const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--logVerbosity', 'verbose',
	'--logFile', logFile,
]);

let seq = 1;
const send = (command, args) => tsserver.message({ seq: seq++, type: 'request', command, arguments: args });

await send('configure', {
	preferences: {
		includeCompletionsForModuleExports: true,
		includeCompletionsWithInsertText: true,
	},
});

await send('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [{ file: emptyVue, fileContent: content }],
});

// Wait for auto-import provider / export map
await new Promise(r => setTimeout(r, 2000));

const comp = await send('completions', { file: emptyVue, position: 0 });
const entries = comp?.body ?? [];
const sort16 = entries.filter(e => e.sortText === '16');
const vue16 = sort16.filter(e => e.source && String(e.source).includes('vue'));

console.log('typescript:', tsserverPath.includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('completions@0:', entries.length, 'sortText16:', sort16.length, 'vue sortText16:', vue16.length);
console.log('log:', logFile);

const log = fs.readFileSync(logFile, 'utf8');
const lines = log.split('\n');
const interesting = lines.filter(l =>
	/getExportInfoMap|forEachExternalModule|autoImportProvider|export map|AutoImportProvider/i.test(l),
);
console.log('--- log highlights ---');
for (const line of interesting.slice(0, 40)) console.log(line.trim());
if (interesting.length > 40) console.log(`... +${interesting.length - 40} more`);

tsserver.kill?.();
