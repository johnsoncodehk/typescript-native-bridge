#!/usr/bin/env node
/** Run vueserver triage with tsserver verbose log + export map trace. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'triage-auto-import-vueserver.mjs');
const logFile = path.join(os.tmpdir(), `tnb-export-trace-${Date.now()}.log`);

const volarRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../volar/vue');
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

// Patch env into triage by running with verbose tsserver - reuse export-info-map approach inline
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volar = resolveVolarRoot();
const harnessEntry = path.join(volar, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const { PublishDiagnosticsNotification } = require('@volar/language-server');
const { startLanguageServer } = require('@volar/test-utils');
const { URI } = require('vscode-uri');

const testWorkspacePath = path.join(volar, 'test-workspace');
const pluginProbe = path.join(volar, 'packages/language-server');
const languageServerEntry = path.join(volar, 'packages/language-server/index.js');

let seq = 1;
const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--logVerbosity', 'verbose',
	'--logFile', logFile,
]);

await tsserver.message({
	seq: seq++,
	command: 'configure',
	arguments: {
		preferences: {
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
		},
	},
});

const vueserver = startLanguageServer(languageServerEntry, testWorkspacePath);
vueserver.connection.onNotification(PublishDiagnosticsNotification.method, () => {});
vueserver.connection.onRequest('workspace/configuration', ({ items }) =>
	items.map(({ section }) => (section?.startsWith('vue.inlayHints.') ? true : null)),
);
vueserver.connection.onNotification('tsserver/request', ([id, command, args]) => {
	tsserver.message({ seq: seq++, command, arguments: args }).then(
		res => vueserver.connection.sendNotification('tsserver/response', [id, res?.body]),
		() => vueserver.connection.sendNotification('tsserver/response', [id, undefined]),
	);
});
await vueserver.initialize(URI.file(testWorkspacePath).toString(), {}, { workspace: { configuration: true } });

const content = `<template><| /></template>`;
const offset = content.indexOf('|');
const fileContent = content.slice(0, offset) + content.slice(offset + 1);
const uri = URI.file(`${testWorkspacePath}/tsconfigProject/empty.vue`).toString();

await tsserver.message({
	seq: seq++,
	command: 'updateOpen',
	arguments: {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: URI.parse(uri).fsPath, fileContent }],
	},
});

const document = await vueserver.openInMemoryDocument(uri, 'vue', fileContent);
const position = document.positionAt(offset);
await vueserver.sendCompletionRequest(document.uri, position);
await tsserver.message({ seq: seq++, command: 'completions', arguments: { file: URI.parse(uri).fsPath, position: 0 } });

console.log('log:', logFile);
const log = fs.readFileSync(logFile, 'utf8');
for (const line of log.split('\n')) {
	if (line.includes('[export-map]') || line.includes('getExportInfoMap')) console.log(line.trim());
}

tsserver.kill?.();
