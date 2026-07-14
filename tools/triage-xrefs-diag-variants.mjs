#!/usr/bin/env node
/**
 * Variants to pin export→import miss:
 * V1: in-memory value export/import (no type-only) under component-meta paths
 * V2: same files WITHOUT vue plugin
 * V3: /tmp minimal two-file project, no plugin
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const cm = path.join(volarRoot, 'test-workspace/component-meta');
const defFile = path.join(cm, 'ts-component/PropDefinitions.ts');
const useFile = path.join(cm, 'ts-component/component.ts');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-xrefs-'));
const tmpA = path.join(tmpRoot, 'a.ts');
const tmpB = path.join(tmpRoot, 'b.ts');
const tmpTsconfig = path.join(tmpRoot, 'tsconfig.json');
fs.writeFileSync(tmpA, 'export interface MyProps { foo: string }\n');
fs.writeFileSync(tmpB, "import { type MyProps } from './a';\nexport const x: MyProps = { foo: 'a' };\n");
fs.writeFileSync(tmpTsconfig, JSON.stringify({ files: ['a.ts', 'b.ts'] }, null, 2));

const memA = path.join(cm, 'ts-component/PropDefinitions.ts');
const memB = path.join(cm, 'ts-component/component.ts');
const memAContent = 'export function myPropsFn(): number { return 1; }\nexport interface MyProps { foo: string }\n';
const memBContentType = "import { type MyProps } from './PropDefinitions';\nexport const c: MyProps = { foo: 'x' };\n";
const memBContentValue = "import { myPropsFn } from './PropDefinitions';\nexport const c = myPropsFn();\n";

function locsFromRefs(body) {
	const refs = body?.refs ?? [];
	return (refs ?? []).map(r => `${path.basename(r.file)}:${r.start?.line}:${r.start?.offset}`);
}

async function runCase(label, tsserverPath, env, { args, openFiles, refs }) {
	const results = {};
	await withTsserver({ tsserverPath, args, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		for (const [name, arg] of Object.entries(refs)) {
			const r = await send('references', arg, 30_000);
			results[name] = { n: locsFromRefs(r?.body).length, locs: locsFromRefs(r?.body), success: !!r?.success };
		}
	});
	return { label, results };
}

const vueArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
];
const plainArgs = ['--disableAutomaticTypingAcquisition'];

const cases = [];

async function bothSides(name, factory) {
	const stock = await factory('STOCK', stockPath, process.env);
	const tnb = await factory('TNB', tnbPath, tnbHarnessEnv());
	cases.push({ name, stock: stock.results, tnb: tnb.results });
	console.log(`\n=== ${name} ===`);
	console.log('STOCK', JSON.stringify(stock.results, null, 2));
	console.log('TNB  ', JSON.stringify(tnb.results, null, 2));
}

// V1: in-memory value export under component-meta + vue plugin; both open
await bothSides('V1_valueFn_vue_bothOpen', (label, tsserverPath, env) =>
	runCase(label, tsserverPath, env, {
		args: vueArgs,
		openFiles: [
			{ file: memA, projectRootPath: cm, fileContent: memAContent },
			{ file: memB, projectRootPath: cm, fileContent: memBContentValue },
		],
		refs: {
			fromDef: { file: memA, line: 1, offset: 17 }, // myPropsFn
			fromUse: { file: memB, line: 1, offset: 10 },
		},
	}));

// V1b: in-memory type-only interface under component-meta + vue; both open
await bothSides('V1b_typeOnlyIface_vue_bothOpen', (label, tsserverPath, env) =>
	runCase(label, tsserverPath, env, {
		args: vueArgs,
		openFiles: [
			{ file: memA, projectRootPath: cm, fileContent: memAContent },
			{ file: memB, projectRootPath: cm, fileContent: memBContentType },
		],
		refs: {
			fromDef: { file: memA, line: 2, offset: 18 }, // MyProps
			fromUse: { file: memB, line: 1, offset: 15 },
		},
	}));

// V2: real disk MyProps, NO vue plugin, both open
await bothSides('V2_diskMyProps_noPlugin_bothOpen', (label, tsserverPath, env) =>
	runCase(label, tsserverPath, env, {
		args: plainArgs,
		openFiles: [
			{ file: defFile, projectRootPath: cm },
			{ file: useFile, projectRootPath: cm },
		],
		refs: {
			fromDef: { file: defFile, line: 1, offset: 18 },
			fromUse: { file: useFile, line: 2, offset: 15 },
		},
	}));

// V3: /tmp minimal a.ts/b.ts type-only, no plugin, both open
await bothSides('V3_tmpMinimal_typeOnly_bothOpen', (label, tsserverPath, env) =>
	runCase(label, tsserverPath, env, {
		args: plainArgs,
		openFiles: [
			{ file: tmpA, projectRootPath: tmpRoot },
			{ file: tmpB, projectRootPath: tmpRoot },
		],
		refs: {
			fromDef: { file: tmpA, line: 1, offset: 18 },
			fromUse: { file: tmpB, line: 1, offset: 15 },
		},
	}));

// V4: disk MyProps vue, def-only open (baseline)
await bothSides('V4_diskMyProps_vue_defOnly', (label, tsserverPath, env) =>
	runCase(label, tsserverPath, env, {
		args: vueArgs,
		openFiles: [{ file: defFile, projectRootPath: cm }],
		refs: {
			fromDef: { file: defFile, line: 1, offset: 18 },
		},
	}));

fs.writeFileSync('/tmp/tnb-xrefs-diag-variants.json', JSON.stringify({ tmpRoot, cases }, null, 2));
console.log('\nwrote /tmp/tnb-xrefs-diag-variants.json tmpRoot=', tmpRoot);
