/**
 * Mimics volar server.ts + completions.spec load, then probes updateOpen message.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const volarRoot = resolveVolarRoot();
const lsPkg = path.join(volarRoot, 'packages/language-server');
const require = createRequire(path.join(lsPkg, 'package.json'));

const { launchServer } = require('@typescript/server-harness');
const { startLanguageServer } = require('@volar/test-utils');
const { URI } = require('vscode-uri');

const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

let seq = 1;
const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', lsPkg,
	'--suppressDiagnosticEvents',
]);

tsserver.on('exit', code => console.log('tsserver exit', code));

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

const serverHandle = startLanguageServer(path.join(lsPkg, 'index.js'), testWorkspacePath);
serverHandle.connection.onNotification('textDocument/publishDiagnostics', () => {});
serverHandle.connection.onRequest('workspace/configuration', params =>
	params.items.map(({ section }) => (section?.startsWith('vue.inlayHints.') ? true : null)),
);
serverHandle.connection.onNotification('tsserver/request', ([id, command, args]) => {
	tsserver.message({ seq: seq++, command, arguments: args }).then(
		res => serverHandle.connection.sendNotification('tsserver/response', [id, res?.body]),
		() => serverHandle.connection.sendNotification('tsserver/response', [id, undefined]),
	);
});

await serverHandle.initialize(URI.file(testWorkspacePath).toString(), {}, {
	workspace: { configuration: true },
});

async function probeUpdateOpen(label, fileName, content) {
	const file = path.join(testWorkspacePath, fileName);
	const res = await tsserver.message({
		seq: seq++,
		type: 'request',
		command: 'updateOpen',
		arguments: {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file, fileContent: content }],
		},
	});
	console.log(`\n[${label}] success=${res?.success} message=${JSON.stringify(res?.message)} body=${JSON.stringify(res?.body)}`);
	return res;
}

async function openViaHelper(uri, languageId, content) {
	const res = await tsserver.message({
		seq: seq++,
		type: 'request',
		command: 'updateOpen',
		arguments: {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: URI.parse(uri).fsPath, fileContent: content }],
		},
	});
	if (!res.success) {
		console.log('openViaHelper FAILED', res.message, res.body);
		throw new Error(res.message || String(res.body));
	}
	return serverHandle.openInMemoryDocument(uri, languageId, content);
}

// Run several completions-like opens (vue server path)
const fixtureUri = URI.file(path.join(testWorkspacePath, 'fixture.vue')).toString();
for (const content of [
	`<|`,
	`<template><| /></template>`,
	`<script setup lang="ts">\nimport Component from '@/|;\n</script>`,
]) {
	const offset = content.indexOf('|');
	const text = content.slice(0, offset) + content.slice(offset + 1);
	const doc = await openViaHelper(fixtureUri, 'vue', text);
	const pos = doc.positionAt(offset);
	await serverHandle.sendCompletionRequest(doc.uri, pos);
}

// definitions-like open (fails after completions suite)
const defFile = path.join(testWorkspacePath, 'tsconfigProject/fixture1.ts');
await probeUpdateOpen('definitions fixture1.ts', 'tsconfigProject/fixture1.ts', `import Component from './empty.vue';`);

tsserver.kill();
serverHandle.connection.dispose();
