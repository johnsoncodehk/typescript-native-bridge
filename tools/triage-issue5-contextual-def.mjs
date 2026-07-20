#!/usr/bin/env node
/**
 * Issue #5 family witnesses: dual-side (TNB vs STOCK) definitionAndBoundSpan /
 * references on the issue's confirmed examples.
 *  1. reference-type-props/component.vue:5:2   — was missing my-props.ts|55|2
 *  2. tsc/#2399/main.vue:12:3                  — was missing main.vue|9|3
 *  3. tsc/#2754/child.vue:4:9                  — was missing runtime-core.d.ts|71|5
 *  4. component-name-description/comp.vue:12:4 — was extra self-site dup
 *  5. tsc/v-for/generic.vue:3:6 references     — was TNB-only error
 * Exit-coded: 0 = all five families match stock.
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
	['reftype-props', 'component-meta/reference-type-props/component.vue', 5, 2, 'definitionAndBoundSpan'],
	['withdefaults-2399', 'tsc/#2399/main.vue', 12, 3, 'definitionAndBoundSpan'],
	['node-modules-2754', 'tsc/#2754/child.vue', 4, 9, 'definitionAndBoundSpan'],
	['extra-self-dup', 'component-meta/component-name-description/component.vue', 12, 4, 'definitionAndBoundSpan'],
	['vfor-generic-refs', 'tsc/v-for/generic.vue', 3, 6, 'references'],
];

function normLoc(l) {
	let f = String(l.file ?? '');
	const t = f.indexOf('/test-workspace/');
	if (t >= 0) f = 'TW:' + f.slice(t + '/test-workspace/'.length);
	else if (f.includes('/node_modules/')) {
		const j = f.lastIndexOf('/node_modules/');
		f = 'NM:' + f.slice(j + '/node_modules/'.length).replace(/^\.pnpm\/[^/]+\/node_modules\//, '');
	}
	return `${f}|${l.line ?? l.start?.line}|${l.offset ?? l.start?.offset}`;
}

async function run(tsserverPath, env, abs, line, offset, cmd) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 180_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: abs, fileContent: fs.readFileSync(abs, 'utf8'), projectRootPath: tw }] });
		const resp = await send(cmd, { file: abs, line, offset });
		if (cmd === 'references') {
			return (resp?.body?.refs ?? []).map((r) => normLoc(r.start)).sort();
		}
		return (resp?.body?.definitions ?? []).map((d) => normLoc(d.start)).sort();
	});
}

let failed = 0;
for (const [tag, rel, line, offset, cmd] of CASES) {
	const abs = path.join(tw, rel);
	const [tnb, stock] = await Promise.all([
		run(tnbPath, tnbHarnessEnv(), abs, line, offset, cmd),
		run(stockPath, {}, abs, line, offset, cmd),
	]);
	const tSet = new Set(tnb);
	const sSet = new Set(stock);
	const onlyStock = [...sSet].filter((x) => !tSet.has(x));
	const onlyTnb = [...tSet].filter((x) => !sSet.has(x));
	const ok = onlyStock.length === 0 && onlyTnb.length === 0;
	if (!ok) failed++;
	console.log(`${ok ? 'MATCH' : 'DIFF '} ${tag}`);
	if (!ok) {
		if (onlyStock.length) console.log(`  missing in TNB: ${JSON.stringify(onlyStock)}`);
		if (onlyTnb.length) console.log(`  extra in TNB:   ${JSON.stringify(onlyTnb)}`);
	}
}
console.log(failed === 0 ? 'VERDICT: PASS (5/5 families match stock)' : `VERDICT: FAIL (${failed}/5)`);
process.exit(failed === 0 ? 0 : 1);
