#!/usr/bin/env node
/**
 * Q2 LSP layer: vueserver completion labels for Auto import repro (TNB only baseline).
 * Uses withTsserver for tsserver child; vueserver is in-process LSP client.
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const require = createRequire(path.join(volarRoot, 'packages/language-server/package.json'));
const { PublishDiagnosticsNotification } = require('@volar/language-server');
const { startLanguageServer } = require('@volar/test-utils');
const { URI } = require('vscode-uri');

const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const languageServerEntry = path.join(volarRoot, 'packages/language-server/index.js');

const content = `<template><| /></template>`;
const offset = content.indexOf('|');
const fileContent = content.replace('|', '');
const fileName = 'tsconfigProject/empty.vue';
const uri = URI.file(`${testWorkspacePath}/${fileName}`).toString();

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const SAMPLE = ['BaseTransition', 'computed', 'withScopeId', 'defineComponent', 'Fixture'];

await withTsserver({
	tsserverPath: tnbPath,
	args: harnessArgs,
	env: tnbHarnessEnv(),
}, async ({ send, server }) => {
	let seq = 2;
	await send('configure', {
		preferences: {
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
		},
	});

	const vueserver = startLanguageServer(languageServerEntry, testWorkspacePath);
	vueserver.connection.onNotification(PublishDiagnosticsNotification.method, () => {});
	vueserver.connection.onRequest('workspace/configuration', ({ items }) =>
		items.map(({ section }) => (section?.startsWith('vue.inlayHints.') ? true : null)),
	);
	vueserver.connection.onNotification('tsserver/request', ([id, command, args]) => {
		server.message({ seq: seq++, command, arguments: args }).then(
			res => vueserver.connection.sendNotification('tsserver/response', [id, res?.body]),
			() => vueserver.connection.sendNotification('tsserver/response', [id, undefined]),
		);
	});
	await vueserver.initialize(URI.file(testWorkspacePath).toString(), {}, { workspace: { configuration: true } });

	await send('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: URI.parse(uri).fsPath, fileContent }],
	});

	const document = await vueserver.openInMemoryDocument(uri, 'vue', fileContent);
	const position = document.positionAt(offset);
	const completions = await vueserver.sendCompletionRequest(document.uri, position);
	const labels = (completions?.items ?? []).map(i => i.label);

	const comp0 = await send('completions', { file: URI.parse(uri).fsPath, position: 0 });
	const entries0 = Array.isArray(comp0?.body) ? comp0.body : comp0?.body?.entries ?? [];
	const vue0 = entries0.filter(e => e.source && String(e.source).includes('vue'));

	console.log('=== LSP (vueserver) ===');
	console.log('total labels:', labels.length);
	for (const key of SAMPLE) {
		console.log(`LSP has ${key}:`, labels.includes(key));
	}

	console.log('\n=== tsserver completions@0 (auto-import path) ===');
	console.log('success:', comp0?.success, 'entries:', entries0.length, 'vue-sourced:', vue0.length);
	for (const key of SAMPLE) {
		const e = entries0.find(x => x.name === key);
		console.log(`@0 ${key}:`, e ? `kind=${e.kind} source=${e.source}` : 'MISSING');
	}

	const lspMissing = SAMPLE.filter(k => !labels.includes(k));
	const tsMissing = SAMPLE.filter(k => !entries0.some(e => e.name === k));
	console.log('\n=== layer hint ===');
	if (tsMissing.length === 0 && lspMissing.length > 0) {
		console.log('(b) tsserver has entries but LSP missing');
	} else if (tsMissing.length > 0) {
		console.log('(a) TNB tsserver layer missing at completions@0');
	} else {
		console.log('both layers present for sample set');
	}
});
