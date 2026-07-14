#!/usr/bin/env node
/**
 * F2 witness: definitionAndBoundSpan/references success-mismatch reading 'exportSymbol'
 * Rep: tsc/#2472/main.vue L11 Generic JSX tag.
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
const mainVue = path.join(tw, 'tsc/#2472/main.vue');
const childVue = path.join(tw, 'tsc/#2472/child.vue');
const genericVue = path.join(tw, 'tsc/#2472/generic.vue');
const sharedTs = path.join(tw, 'tsc/shared.ts');
const THROW_FILE = '/tmp/tnb-f2-exportsymbol-throws.jsonl';

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function run(label, tsserverPath, env) {
	const openFiles = [];
	for (const f of [mainVue, childVue, genericVue, sharedTs]) {
		if (fs.existsSync(f)) {
			openFiles.push({ file: f, fileContent: fs.readFileSync(f, 'utf8'), projectRootPath: tw });
		}
	}
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const line = 11;
		const offset = 3; // Generic
		const def = await send('definitionAndBoundSpan', { file: mainVue, line, offset });
		const refs = await send('references', { file: mainVue, line, offset });
		return {
			label,
			def: {
				success: !!def?.success,
				message: String(def?.message ?? '').slice(0, 3000),
				defs: (def?.body?.definitions ?? []).map((d) => `${d.file}|${d.start?.line}|${d.start?.offset}`),
			},
			refs: {
				success: !!refs?.success,
				message: String(refs?.message ?? '').slice(0, 3000),
				refs: (refs?.body?.refs ?? []).map((r) => `${r.file}|${r.start?.line}|${r.start?.offset}`),
			},
		};
	});
}

try {
	fs.unlinkSync(THROW_FILE);
} catch {
	/* ok */
}

const tnb = await run(
	'TNB',
	tnbPath,
	tnbHarnessEnv({ TNB_TRACE_THROW: '1', TNB_TRACE_THROW_FILE: THROW_FILE }),
);
const stock = await run('STOCK', stockPath, process.env);

console.log('=== WITNESS f2-success-exportsymbol ===');
for (const side of [tnb, stock]) {
	console.log(`\n--- ${side.label} ---`);
	console.log(`def success=${side.def.success} n=${side.def.defs.length}`);
	if (!side.def.success) console.log(side.def.message);
	else console.log('defs', side.def.defs.slice(0, 8));
	console.log(`refs success=${side.refs.success} n=${side.refs.refs.length}`);
	if (!side.refs.success) console.log(side.refs.message);
	else console.log('refs', side.refs.refs.slice(0, 8));
}
const verdict =
	tnb.def.success === stock.def.success && tnb.refs.success === stock.refs.success ? 'MATCH?' : 'DIFF';
console.log(`\nverdict: ${verdict}`);

if (fs.existsSync(THROW_FILE)) {
	const lines = fs.readFileSync(THROW_FILE, 'utf8').trim().split('\n').filter(Boolean);
	console.log(`\n=== TNB_TRACE_THROW hits=${lines.length} ===`);
	for (const line of lines.slice(0, 10)) {
		try {
			const j = JSON.parse(line);
			console.log(
				JSON.stringify({
					message: String(j.message ?? '').slice(0, 200),
					stack: String(j.stack ?? '')
						.split('\n')
						.slice(0, 18)
						.join(' | '),
				}),
			);
		} catch {
			console.log(line.slice(0, 500));
		}
	}
}
