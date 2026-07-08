/**
 * Triage: run completions-like opens then check updateOpen (mimics volar test pollution).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const volarRoot = resolveVolarRoot();
const lsPkg = path.join(volarRoot, 'packages/language-server');
const harnessPath = path.join(lsPkg, 'node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessPath).href);
const tsserver = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const testWorkspace = path.join(volarRoot, 'test-workspace');

const tnbEnv = { ...process.env };
if (tnbEnv.TNB_SKIP_ASYNC_PREEMPT_OFF !== '1' && !/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(tnbEnv.GODEBUG ?? '')) {
	tnbEnv.GODEBUG = tnbEnv.GODEBUG ? `${tnbEnv.GODEBUG},asyncpreemptoff=1` : 'asyncpreemptoff=1';
}

const server = launchServer(tsserver, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', lsPkg,
	'--suppressDiagnosticEvents',
], undefined, tnbEnv);

let seq = 1;
async function msg(command, args) {
	const res = await server.message({ seq: seq++, type: 'request', command, arguments: args });
	return res;
}

await msg('configure', { preferences: {} });

const fixture = path.join(testWorkspace, 'tsconfigProject/fixture.vue');
const content = '<script setup lang="ts"></script>\n<template><div></div></template>\n';

// Open several times like completions tests
for (let i = 0; i < 5; i++) {
	const res = await msg('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: fixture, fileContent: content }],
	});
	console.log(`open ${i}: success=${res.success} message=${(res.message || '').slice(0, 120)}`);
}

// Simulate references command
const resRef = await msg('references', {
	file: fixture,
	position: 10,
	includeDeclaration: false,
});
console.log(`references: success=${resRef.success} refs=${resRef.body?.refs?.length ?? 'n/a'}`);

// Try open new file like definitions test
const foo = path.join(testWorkspace, 'tsconfigProject/foo.vue');
const res2 = await msg('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [{ file: foo, fileContent: '<script setup lang="ts"></script>\n<template></template>\n' }],
});
console.log(`open foo: success=${res2.success} message=${(res2.message || '').slice(0, 500)}`);

server.kill();
