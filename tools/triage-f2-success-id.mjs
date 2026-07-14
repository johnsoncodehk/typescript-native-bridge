#!/usr/bin/env node
/**
 * F2 witness: references success-mismatch reading 'id'
 * Rep: tsc/#1886/main.vue — declare module 'vue' GlobalComponents (export/interface).
 * Minimal open: main.vue only (+ shared if needed for types).
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
const mainVue = path.join(tw, 'tsc/#1886/main.vue');
const sharedTs = path.join(tw, 'tsc/shared.ts');
const THROW_FILE = '/tmp/tnb-f2-id-throws.jsonl';

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const positions = [
	{ name: 'export', line: 5, offset: 2 },
	{ name: 'interface', line: 5, offset: 9 },
	{ name: 'GlobalComponents', line: 5, offset: 19 },
];

async function run(label, tsserverPath, env) {
	const mainContent = fs.readFileSync(mainVue, 'utf8');
	const openFiles = [{ file: mainVue, fileContent: mainContent, projectRootPath: tw }];
	if (fs.existsSync(sharedTs)) {
		openFiles.push({ file: sharedTs, fileContent: fs.readFileSync(sharedTs, 'utf8'), projectRootPath: tw });
	}
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const out = [];
		for (const p of positions) {
			const resp = await send('references', { file: mainVue, line: p.line, offset: p.offset });
			out.push({
				pos: p.name,
				success: !!resp?.success,
				message: String(resp?.message ?? '').slice(0, 3000),
				refN: (resp?.body?.refs ?? []).length,
				refs: (resp?.body?.refs ?? [])
					.slice(0, 8)
					.map((r) => `${r.file}|${r.start?.line}|${r.start?.offset}`),
			});
		}
		return { label, out };
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

console.log('=== WITNESS f2-success-id ===');
for (let i = 0; i < tnb.out.length; i++) {
	const a = tnb.out[i];
	const b = stock.out[i];
	const verdict = a.success === b.success && a.refN === b.refN ? 'MATCH' : 'DIFF';
	console.log(`\n--- ${a.pos} references → ${verdict} ---`);
	console.log(`TNB success=${a.success} refN=${a.refN}`);
	if (!a.success) console.log(`TNB msg:\n${a.message}`);
	console.log(`STOCK success=${b.success} refN=${b.refN}`);
	if (b.refs?.length) console.log('STOCK refs:', b.refs.slice(0, 5));
}

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
						.slice(0, 15)
						.join(' | '),
				}),
			);
		} catch {
			console.log(line.slice(0, 500));
		}
	}
}
