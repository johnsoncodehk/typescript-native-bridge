/**
 * Triage: tsserver rename on CSS module class (renaming.spec CSS case).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const lsPkg = path.join(volarRoot, 'packages/language-server');
const harnessPath = path.join(lsPkg, 'node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessPath).href);
const tsserver = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

const tnbEnv = { ...process.env };
if (tnbEnv.TNB_SKIP_ASYNC_PREEMPT_OFF !== '1' && !/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(tnbEnv.GODEBUG ?? '')) {
	tnbEnv.GODEBUG = tnbEnv.GODEBUG ? `${tnbEnv.GODEBUG},asyncpreemptoff=1` : 'asyncpreemptoff=1';
}

const content = `
<template>
	<div :class="$style.foo"></div>
</template>

<style module>
/* .foo { } */
.foo { }
</style>

<style module lang="scss">
// .foo { }
</style>
`.trimStart();

const offset = content.indexOf('foo');
const fixture = path.join(volarRoot, 'test-workspace/fixture.vue');

const server = launchServer(tsserver, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', lsPkg,
	'--suppressDiagnosticEvents',
], undefined, tnbEnv);

let seq = 1;
async function msg(command, args) {
	return server.message({ seq: seq++, type: 'request', command, arguments: args });
}

await msg('configure', { preferences: {} });
const openRes = await msg('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [{ file: fixture, fileContent: content }],
});
console.log('updateOpen:', openRes.success, openRes.message?.slice?.(0, 120));

const renameRes = await msg('rename', {
	file: fixture,
	position: offset,
	findInStrings: false,
	findInComments: false,
});
console.log('rename success:', renameRes.success);
console.log('rename body:', JSON.stringify(renameRes.body, null, 2));

server.kill();
