#!/usr/bin/env node
/**
 * Witness for the issue #11 idle drain (C-2 + shell decode drop): results
 * served AFTER the 5s idle eviction must equal results served before it.
 * The drain clears per-generation node indexes and resets decoded-node
 * populations on cross-generation RemoteSourceFile shells; every query here
 * then re-decodes/re-indexes on demand. Any stale handle, lost identity, or
 * decode mismatch shows up as a pre/post diff.
 *
 * Exit 0: pre-idle and post-idle responses are byte-equal (and non-empty).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const fixture = '/tmp/tnb-triage-idle-drain';

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
];

function write(rel, content) {
	const file = path.join(fixture, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

fs.rmSync(fixture, { recursive: true, force: true });
fs.cpSync(path.join(volarRoot, 'test-workspace/node_modules/vue'), path.join(fixture, 'node_modules/vue'), { recursive: true });
write('src/A.vue', `<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
	<span>{{ label }}</span>
</template>
`);
write('src/B.vue', `<script setup lang="ts">
import A from './A.vue';
const x: string = 'hi';
</script>

<template>
	<A :label="x" />
</template>
`);
write('tsconfig.json', JSON.stringify({
	compilerOptions: {
		lib: ['esnext', 'dom'],
		target: 'esnext',
		module: 'esnext',
		moduleResolution: 'bundler',
		strict: true,
		skipLibCheck: true,
		noEmit: true,
		jsx: 'preserve',
		types: [],
	},
	include: ['src'],
}, null, 2));

const aVue = path.join(fixture, 'src/A.vue');
const bVue = path.join(fixture, 'src/B.vue');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(send) {
	const out = [];
	const diags = await send('semanticDiagnosticsSync', { file: bVue, includeLinePosition: true });
	out.push(['diags', (diags?.body ?? []).map((d) => `${d.code}@${d.startLocation?.line}:${d.startLocation?.offset}`)]);
	const qi = await send('quickinfo', { file: bVue, line: 2, offset: 8 });
	out.push(['quickinfo', qi?.body?.displayString ?? String(qi?.success)]);
	const refs = await send('references', { file: aVue, line: 2, offset: 16 });
	out.push(['references', JSON.stringify((refs?.body?.refs ?? []).map((r) => `${path.basename(r.file)}:${r.start.line}:${r.start.offset}`))]);
	const nav = await send('navto', { searchValue: 'label', maxResultCount: 20 });
	out.push(['navto', JSON.stringify((nav?.body ?? []).map((e) => `${e.name}@${path.basename(e.file)}`))]);
	return JSON.stringify(out);
}

console.log('=== WITNESS issue-11 idle drain (pre/post-idle consistency) ===');
await withTsserver({ tsserverPath: tnbPath, args: harnessArgs, env: tnbHarnessEnv(), deadlineMs: 120_000 }, async ({ send }) => {
	await send('configure', { preferences: {} });
	await send('updateOpen', {
		changedFiles: [], closedFiles: [],
		openFiles: [
			{ file: aVue, fileContent: fs.readFileSync(aVue, 'utf8'), projectRootPath: fixture },
			{ file: bVue, fileContent: fs.readFileSync(bVue, 'utf8'), projectRootPath: fixture },
		],
	});
	const pre = await probe(send);
	if (pre.includes('undefined') || pre.includes('[]"')) {
		console.log('FAIL: pre-idle probe came back empty — fixture/probe is vacuous');
		console.log(pre);
		process.exit(1);
	}
	// Park the session past the 5s eviction debounce; the drain fires between
	// requests, then every probe below re-decodes on demand.
	await sleep(7000);
	const post = await probe(send);
	const match = pre === post;
	console.log(`-- pre/post idle verdict=${match ? 'MATCH' : 'DIFF'}`);
	if (!match) {
		console.log(`   PRE  ${pre}`);
		console.log(`   POST ${post}`);
	}
	console.log(match ? 'VERDICT: PASS' : 'VERDICT: FAIL');
	process.exit(match ? 0 : 1);
});
