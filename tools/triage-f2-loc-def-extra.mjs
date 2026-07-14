#!/usr/bin/env node
/**
 * F2 witness: definitionAndBoundSpan tnb-extra:vue / both:vue
 * Rep: component-meta/component-name-description/component.vue L12:4
 * Often TNB returns 2 defs (self+decl) vs stock 1.
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
const file = path.join(tw, 'component-meta/component-name-description/component.vue');

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
	else file = 'ABS:' + file.split('/').pop();
	return `${file}|${l}|${o}`;
}

async function run(label, tsserverPath, env) {
	const content = fs.readFileSync(file, 'utf8');
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file, fileContent: content, projectRootPath: tw }],
		});
		const resp = await send('definitionAndBoundSpan', { file, line: 12, offset: 4 });
		const locs = (resp?.body?.definitions ?? []).map((d) => `${d.file}|${d.start?.line}|${d.start?.offset}`);
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
console.log('=== WITNESS f2-loc-def-extra ===');
console.log(`verdict=${onlyTnb.length || onlyStock.length ? 'DIFF' : 'MATCH'}`);
console.log(`TNB n=${tnb.locs.length}`, tnb.norm);
console.log(`STOCK n=${stock.locs.length}`, stock.norm);
console.log('onlyTnb', onlyTnb);
console.log('onlyStock', onlyStock);
