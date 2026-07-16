#!/usr/bin/env node
/**
 * T2 witness f2r6-xvue: cross-.vue refs missing (T2 sub-cluster 2, 108 visible).
 * Rep: tsc/components/main.vue:62:15 — misses script-setup-expose.vue|2|22,
 * script-setup-generic.vue|2|22.
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
const dir = path.join(tw, 'tsc/components');
const mainVue = path.join(dir, 'main.vue');
const openList = [mainVue, path.join(dir, 'script-setup-expose.vue'), path.join(dir, 'script-setup-generic.vue')];

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
	const openFiles = openList.filter((f) => fs.existsSync(f)).map((f) => ({ file: f, fileContent: fs.readFileSync(f, 'utf8'), projectRootPath: tw }));
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const resp = await send('references', { file: mainVue, line, offset });
		const locs = (resp?.body?.refs ?? []).map((r) => `${r.file}|${r.start?.line}|${r.start?.offset}`);
		return { label, success: !!resp?.success, message: String(resp?.message ?? '').split('\n')[0], locs, norm: locs.map(norm).sort() };
	});
}

for (const [line, offset] of [[62, 15]]) {
	const tnb = await run('TNB', tnbPath, tnbHarnessEnv(), line, offset);
	const stock = await run('STOCK', stockPath, process.env, line, offset);
	const tSet = new Set(tnb.norm), sSet = new Set(stock.norm);
	const onlyStock = [...sSet].filter((x) => !tSet.has(x));
	const onlyTnb = [...tSet].filter((x) => !sSet.has(x));
	const verdict = tnb.success === stock.success && onlyTnb.length === 0 && onlyStock.length === 0 ? 'MATCH' : 'DIFF';
	console.log(`=== WITNESS f2r6-xvue components/main.vue:${line}:${offset} ===`);
	console.log(`verdict=${verdict} TNB n=${tnb.locs.length} STOCK n=${stock.locs.length} msg=${tnb.message}`);
	console.log('onlyStock', onlyStock);
	console.log('onlyTnb', onlyTnb);
	console.log('TNB norm', tnb.norm);
	console.log('STOCK norm', stock.norm);
}
