#!/usr/bin/env node
/**
 * T2 witness f2r6-samevue: same-file .vue refs missing (T2 sub-cluster 3, 43 visible).
 * Rep: tsc/#5106/main.vue:4:21 / :4:27 / :7:1 — miss main.vue|7|17 etc.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const tw = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(tw, 'tsc/#5106/main.vue');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

function norm(k) {
	const [f, l, o] = String(k).split('|');
	let file = f || '';
	const i = file.indexOf('/test-workspace/');
	if (i >= 0) file = 'TW:' + file.slice(i + '/test-workspace/'.length);
	else if (file.includes('/node_modules/')) {
		const j = file.lastIndexOf('/node_modules/');
		file = 'NM:' + file.slice(j + '/node_modules/'.length).replace(/^\.pnpm\/[^/]+\/node_modules\//, '');
	} else file = 'ABS:' + file.split('/').slice(-2).join('/');
	return `${file}|${l}|${o}`;
}

async function run(label, tsserverPath, env, line, offset) {
	const openFiles = [{ file: mainVue, fileContent: fs.readFileSync(mainVue, 'utf8'), projectRootPath: tw }];
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const resp = await send('references', { file: mainVue, line, offset });
		const locs = (resp?.body?.refs ?? []).map((r) => `${r.file}|${r.start?.line}|${r.start?.offset}`);
		return { label, success: !!resp?.success, message: String(resp?.message ?? '').split('\n')[0], locs, norm: locs.map(norm).sort() };
	});
}

console.log('=== WITNESS f2r6-samevue #5106/main.vue ===');
for (const [line, offset] of [[4, 21], [4, 27], [7, 1]]) {
	const tnb = await run('TNB', tnbPath, tnbHarnessEnv(), line, offset);
	const stock = await run('STOCK', stockPath, process.env, line, offset);
	const tSet = new Set(tnb.norm), sSet = new Set(stock.norm);
	const onlyStock = [...sSet].filter((x) => !tSet.has(x));
	const onlyTnb = [...tSet].filter((x) => !sSet.has(x));
	const verdict = tnb.success === stock.success && onlyTnb.length === 0 && onlyStock.length === 0 ? 'MATCH' : 'DIFF';
	console.log(`-- ${line}:${offset} verdict=${verdict} TNB n=${tnb.locs.length} STOCK n=${stock.locs.length} msg=${tnb.message}`);
	console.log('  onlyStock', onlyStock);
	console.log('  onlyTnb', onlyTnb);
}

// Fix B diagnosis: what does definitionAndBoundSpan at the augmentation literal (7:17)
// resolve to on each side? Divergent target ⇒ symbol-resolution divergence for
// `declare module 'vue'` names (identity mismatch in FAR's === comparison).
async function runDef(label, tsserverPath, env, line, offset) {
	const openFiles = [{ file: mainVue, fileContent: fs.readFileSync(mainVue, 'utf8'), projectRootPath: tw }];
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const resp = await send('definitionAndBoundSpan', { file: mainVue, line, offset });
		const defs = (resp?.body?.definitions ?? []).map((d) => norm(`${d.file}|${d.start?.line}|${d.start?.offset}`));
		return { label, success: !!resp?.success, defs };
	});
}
console.log('=== DEF at augmentation literal 7:17 ===');
for (const [line, offset] of [[7, 17], [4, 27]]) {
	const tnb = await runDef('TNB', tnbPath, tnbHarnessEnv(), line, offset);
	const stock = await runDef('STOCK', stockPath, process.env, line, offset);
	console.log(`-- def ${line}:${offset} TNB ${JSON.stringify(tnb.defs)}`);
	console.log(`   def ${line}:${offset} STOCK ${JSON.stringify(stock.defs)}`);
}
