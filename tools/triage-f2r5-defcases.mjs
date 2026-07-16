#!/usr/bin/env node
/**
 * T3 witness f2r5-defcases: def cluster representatives, dual-side.
 *  - modspec      #2048/main.vue:7:31     TNB shared.d.ts|2|1 vs STOCK |1|1
 *  - extra-self   component-name-description/component.vue:12:4  TNB adds query loc
 *  - extra-import #5136/src.vue:5:14      TNB adds import-identifier 2|10
 *  - extra-stmt   #2709/main.vue:5:16     TNB adds statement-start 5|1
 *  - missing-dts  #2754/child.vue:4:9     STOCK has runtime-core.d.ts|71|5
 *  - missing-self script-setup-default-props.vue:8:3  STOCK has same-file 3|3
 *  - mixed-xfile  #3289/main.vue:5:8      TNB child.vue|1|1 vs STOCK main.vue|5|8
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

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const CASES = [
	['modspec', 'tsc/#2048/main.vue', 7, 31],
	['extra-self', 'component-meta/component-name-description/component.vue', 12, 4],
	['extra-import', 'tsc/#5136/src.vue', 5, 14],
	['extra-stmt', 'tsc/#2709/main.vue', 5, 16],
	['missing-dts', 'tsc/#2754/child.vue', 4, 9],
	['missing-self', 'tsc/components/script-setup-default-props.vue', 8, 3],
	['mixed-xfile', 'tsc/#3289/main.vue', 5, 8],
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

async function run(label, tsserverPath, env, absFile, line, offset) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: absFile, fileContent: fs.readFileSync(absFile, 'utf8'), projectRootPath: tw }] });
		const resp = await send('definitionAndBoundSpan', { file: absFile, line, offset });
		const locs = (resp?.body?.definitions ?? []).map((r) => `${r.file}|${r.start?.line}|${r.start?.offset}`);
		return { label, success: !!resp?.success, message: String(resp?.message ?? '').split('\n')[0], locs, norm: locs.map(norm).sort() };
	});
}

for (const [tag, rel, line, offset] of CASES) {
	const abs = path.join(tw, rel);
	const tnb = await run('TNB', tnbPath, tnbHarnessEnv(), abs, line, offset);
	const stock = await run('STOCK', stockPath, process.env, abs, line, offset);
	const tSet = new Set(tnb.norm), sSet = new Set(stock.norm);
	const onlyStock = [...sSet].filter((x) => !tSet.has(x));
	const onlyTnb = [...tSet].filter((x) => !sSet.has(x));
	const verdict = tnb.success === stock.success && onlyTnb.length === 0 && onlyStock.length === 0 ? 'MATCH' : 'DIFF';
	console.log(`=== ${tag} ${rel}:${line}:${offset} ===`);
	console.log(`verdict=${verdict} TNB n=${tnb.locs.length} STOCK n=${stock.locs.length}`);
	console.log('TNB  ', tnb.norm);
	console.log('STOCK', stock.norm);
}
