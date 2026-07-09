/**
 * Replicate volar completions.spec.ts requestCompletionListToTsServer path.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');

const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
], undefined, env);

let seq = 1;
const send = async (command, args, timeoutMs = 60_000) => {
	const t0 = Date.now();
	const res = await Promise.race([
		tsserver.message({ seq: seq++, type: 'request', command, arguments: args }),
		new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${command}`)), timeoutMs)),
	]);
	console.log(`${command}: ${Date.now() - t0}ms success=${res.success}`);
	return res;
};

await send('configure', { preferences: {} });

const fileName = 'fixture.vue';
const content = `
		<template>{{ f| }}</template>

		<script lang="ts" setup>
		const foo = 1;
		</script>
	`;
const offset = content.indexOf('|');
const body = content.slice(0, offset) + content.slice(offset + 1);
const file = path.join(testWorkspacePath, fileName);

await send('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [{ file, fileContent: body }],
});

const comp = await send('completions', { file, position: offset });
const entries = comp.body ?? [];
const names = entries.map(e => e.name);
console.log('entries:', names.length);
console.log('has foo:', names.includes('foo'));
console.log('sample:', names.slice(0, 10));

tsserver.kill?.();
