#!/usr/bin/env node
/**
 * F2 witness: references loc-set-mismatch — TNB missing cross-.vue refs.
 * Rep: component-meta/reference-type-props/component-js.vue L3:10 StringEmpty
 * Opens: component-js.vue + component-js-setup.vue + my-props.ts
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
const dir = path.join(tw, 'component-meta/reference-type-props');
const mainVue = path.join(dir, 'component-js.vue');
const setupVue = path.join(dir, 'component-js-setup.vue');
const propsTs = path.join(dir, 'my-props.ts');

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
	} else file = 'ABS:' + file.split('/').pop();
	return `${file}|${l}|${o}`;
}

async function run(label, tsserverPath, env) {
	const openFiles = [mainVue, setupVue, propsTs]
		.filter((f) => fs.existsSync(f))
		.map((f) => ({ file: f, fileContent: fs.readFileSync(f, 'utf8'), projectRootPath: tw }));
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const resp = await send('references', { file: mainVue, line: 3, offset: 10 });
		const locs = (resp?.body?.refs ?? []).map((r) => `${r.file}|${r.start?.line}|${r.start?.offset}`);
		return {
			label,
			success: !!resp?.success,
			message: String(resp?.message ?? '').split('\n')[0],
			locs,
			norm: locs.map(norm).sort(),
		};
	});
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = await run('STOCK', stockPath, process.env);
const tSet = new Set(tnb.norm);
const sSet = new Set(stock.norm);
const onlyTnb = [...tSet].filter((x) => !sSet.has(x));
const onlyStock = [...sSet].filter((x) => !tSet.has(x));
const verdict = tnb.success === stock.success && onlyTnb.length === 0 && onlyStock.length === 0 ? 'MATCH' : 'DIFF';

console.log('=== WITNESS f2-loc-xvue ===');
console.log(`verdict=${verdict}`);
console.log(`TNB success=${tnb.success} n=${tnb.locs.length} msg=${tnb.message}`);
console.log(`STOCK success=${stock.success} n=${stock.locs.length}`);
console.log('onlyStock', onlyStock);
console.log('onlyTnb', onlyTnb);
console.log('TNB norm', tnb.norm);
console.log('STOCK norm', stock.norm);
