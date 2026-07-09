/** Simulate IDE tsserver spawn (no GODEBUG in env) vs vitest (GODEBUG preset). */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');

async function run(label, env, usePlugin, fileName, content, offset) {
	const args = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];
	if (usePlugin) args.push('--globalPlugins', '@vue/typescript-plugin', '--pluginProbeLocations', pluginProbe);
	const server = launchServer(tsserverPath, args, undefined, env);
	let seq = 1;
	const send = async (command, arguments_, timeoutMs = 30_000) => {
		const t0 = Date.now();
		try {
			const res = await Promise.race([
				server.message({ seq: seq++, type: 'request', command, arguments: arguments_ }),
				new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
			]);
			console.log(`[${label}] ${command}: ${Date.now() - t0}ms ok=${res.success}`);
			return res;
		} catch (e) {
			console.log(`[${label}] ${command}: ${Date.now() - t0}ms ${e.message}`);
			return undefined;
		}
	};
	await send('configure', {});
	const file = path.join(testWorkspacePath, fileName);
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: content }] });
	const comp = await send('completions', { file, position: offset });
	const entries = comp?.body?.entries ?? comp?.body ?? [];
	const names = Array.isArray(entries) ? entries.map(e => e.name) : [];
	console.log(`[${label}] entries=${names.length} hasFoo=${names.includes('foo')} msg=${(comp?.message ?? '').slice(0, 120)}`);
	server.kill?.();
}

const vueContent = `
		<template>{{ f| }}</template>

		<script lang="ts" setup>
		const foo = 1;
		</script>
	`;
const vueOffset = vueContent.indexOf('|');
const vueBody = vueContent.replace('|', '');
const tsBody = 'const foo = 1;\nfo|\n';
const tsOffset = tsBody.indexOf('|');
const tsContent = tsBody.replace('|', '');

// IDE-like: no GODEBUG preset (tnb-godebug re-exec via spawnSync inside fork child)
await run('IDE-env vue', { ...process.env, GODEBUG: undefined, TNB_GODEBUG_REEXEC: undefined }, true, 'fixture.vue', vueBody, vueOffset);
await run('IDE-env plain-ts', { ...process.env, GODEBUG: undefined, TNB_GODEBUG_REEXEC: undefined }, false, 'tsconfigProject/plain.ts', tsContent, tsOffset);

// Vitest-like
const vitestEnv = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
await run('vitest-env vue', vitestEnv, true, 'fixture.vue', vueBody, vueOffset);
await run('vitest-env plain-ts', vitestEnv, false, 'tsconfigProject/plain.ts', tsContent, tsOffset);
