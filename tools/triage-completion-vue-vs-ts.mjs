/** Compare completions: .vue virtual TS vs plain .ts */
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

async function runCase(label, { file, content, offset, usePlugin }) {
	const args = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];
	if (usePlugin) {
		args.push('--globalPlugins', '@vue/typescript-plugin', '--pluginProbeLocations', pluginProbe);
	}
	const server = launchServer(tsserverPath, args, undefined, env);
	let seq = 1;
	const send = async (command, arguments_, timeoutMs = 45_000) => {
		const t0 = Date.now();
		try {
			const res = await Promise.race([
				server.message({ seq: seq++, type: 'request', command, arguments: arguments_ }),
				new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${command}`)), timeoutMs)),
			]);
			console.log(`[${label}] ${command}: ${Date.now() - t0}ms ok=${res.success}`);
			return res;
		} catch (e) {
			console.log(`[${label}] ${command}: ${Date.now() - t0}ms ${e.message}`);
			return undefined;
		}
	};
	await send('configure', {});
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: content }] });
	const comp = await send('completions', { file, position: offset });
	const entries = comp?.body?.entries ?? comp?.body ?? [];
	const names = Array.isArray(entries) ? entries.map(e => e.name) : [];
	console.log(`[${label}] entries=${names.length} sample=${JSON.stringify(names.slice(0, 5))}`);
	server.kill?.();
}

const vueFile = path.join(testWorkspacePath, 'fixture.vue');
const vueContent = `<template>{{ f| }}</template>\n<script lang="ts" setup>\nconst foo = 1;\n</script>\n`;
const vueOffset = vueContent.indexOf('|');
await runCase('vue+plugin', {
	file: vueFile,
	content: vueContent.replace('|', ''),
	offset: vueOffset,
	usePlugin: true,
});

const tsFile = path.join(testWorkspacePath, 'tsconfigProject/plain.ts');
const tsContent = 'const foo = 1;\nfoo.\n';
const tsOffset = tsContent.indexOf('foo.') + 4;
await runCase('plain-ts+plugin', { file: tsFile, content: tsContent, offset: tsOffset, usePlugin: true });
await runCase('plain-ts-no-plugin', { file: tsFile, content: tsContent, offset: tsOffset, usePlugin: false });
