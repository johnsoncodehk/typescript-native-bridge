#!/usr/bin/env node
/**
 * F2 witness: definitionAndBoundSpan loc-set — absolute path artifact vs semantic.
 * Rep: component-meta/component-name-description/component-ts.ts L13:10
 * Shows raw abs paths differ (TNB lib/ vs stock lib/) but basename|line|offset may match.
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
const file = path.join(tw, 'component-meta/component-name-description/component-ts.ts');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

/** Same LIB:basename canonicalize as triage-sim-nav.mjs (RC4). */
function canonicalizeLocFile(file) {
	const f = String(file ?? '');
	const base = f.split(/[/\\]/).pop() || f;
	if (/^lib\..+\.d\.ts$/i.test(base)) return `LIB:${base}`;
	return f;
}

function locKey(fileLineOffset) {
	const [f, l, o] = String(fileLineOffset).split('|');
	return `${canonicalizeLocFile(f)}|${l}|${o}`;
}

function basify(k) {
	const [f, l, o] = String(k).split('|');
	return `${(f || '').split('/').pop()}|${l}|${o}`;
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
		const resp = await send('definitionAndBoundSpan', { file, line: 13, offset: 10 });
		const locs = (resp?.body?.definitions ?? []).map((d) => `${d.file}|${d.start?.line}|${d.start?.offset}`);
		return { label, success: !!resp?.success, locs, base: locs.map(basify).sort() };
	});
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = await run('STOCK', stockPath, process.env);
const rawEq = JSON.stringify(tnb.locs.slice().sort()) === JSON.stringify(stock.locs.slice().sort());
const baseEq = JSON.stringify(tnb.base) === JSON.stringify(stock.base);
const canonTnb = tnb.locs.map(locKey).sort();
const canonStock = stock.locs.map(locKey).sort();
const canonEq = JSON.stringify(canonTnb) === JSON.stringify(canonStock);
console.log('=== WITNESS f2-loc-pathonly ===');
console.log(
	`rawEqual=${rawEq} baseEqual=${baseEq} canonEqual=${canonEq} → ${
		canonEq ? 'MATCH' : !rawEq && baseEq ? 'PATH-ARTIFACT' : 'SEMANTIC-DIFF'
	}`,
);
console.log('TNB locs', tnb.locs.slice(0, 8));
console.log('STOCK locs', stock.locs.slice(0, 8));
console.log('TNB canon', canonTnb.slice(0, 8));
console.log('STOCK canon', canonStock.slice(0, 8));
console.log('TNB base', tnb.base.slice(0, 8));
console.log('STOCK base', stock.base.slice(0, 8));
