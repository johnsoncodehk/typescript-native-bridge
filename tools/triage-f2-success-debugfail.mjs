#!/usr/bin/env node
/**
 * F2 witness: references/documentHighlights success-mismatch "Debug Failure."
 * Rep: component-meta/generic/main.vue — import/ref positions.
 * Opens only the target .vue (+ sibling component.vue which it imports).
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
const mainVue = path.join(tw, 'component-meta/generic/main.vue');
const compVue = path.join(tw, 'component-meta/generic/component.vue');
const THROW_FILE = '/tmp/tnb-f2-debugfail-throws.jsonl';

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const positions = [
	{ name: 'import', line: 2, offset: 1, cmds: ['references'] },
	{ name: 'ref-import', line: 2, offset: 10, cmds: ['references', 'documentHighlights'] },
	{ name: 'ref-call', line: 5, offset: 15, cmds: ['references', 'documentHighlights'] },
];

function summarize(cmd, resp) {
	const success = !!resp?.success;
	const message = resp?.message ? String(resp.message) : '';
	let locs = [];
	if (cmd === 'references') {
		locs = (resp?.body?.refs ?? []).map((r) => `${r.file}|${r.start?.line}|${r.start?.offset}`);
	} else if (cmd === 'documentHighlights') {
		for (const item of resp?.body ?? []) {
			for (const sp of item.highlightSpans ?? []) {
				locs.push(`${item.file}|${sp.start?.line}|${sp.start?.offset}`);
			}
		}
	}
	return {
		success,
		messageHead: message.split('\n')[0],
		messageFull: message.slice(0, 2500),
		locN: locs.length,
		locs: locs.slice(0, 20),
	};
}

async function run(label, tsserverPath, env) {
	const mainContent = fs.readFileSync(mainVue, 'utf8');
	const compContent = fs.readFileSync(compVue, 'utf8');
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [
				{ file: mainVue, fileContent: mainContent, projectRootPath: tw },
				{ file: compVue, fileContent: compContent, projectRootPath: tw },
			],
		});
		const out = [];
		for (const p of positions) {
			for (const cmd of p.cmds) {
				const args =
					cmd === 'documentHighlights'
						? { file: mainVue, line: p.line, offset: p.offset, filesToSearch: [mainVue] }
						: { file: mainVue, line: p.line, offset: p.offset };
				const resp = await send(cmd, args);
				out.push({ pos: p.name, cmd, ...summarize(cmd, resp) });
			}
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

console.log('=== WITNESS f2-success-debugfail ===');
for (let i = 0; i < tnb.out.length; i++) {
	const a = tnb.out[i];
	const b = stock.out[i];
	const verdict =
		a.success === b.success && JSON.stringify(a.locs) === JSON.stringify(b.locs) ? 'MATCH' : 'DIFF';
	console.log(`\n--- ${a.pos} ${a.cmd} → ${verdict} ---`);
	console.log(`TNB success=${a.success} locN=${a.locN} msg=${a.messageHead}`);
	if (!a.success) console.log(`TNB msgFull:\n${a.messageFull}`);
	console.log(`STOCK success=${b.success} locN=${b.locN} msg=${b.messageHead}`);
	if (a.locs.length) console.log('TNB locs sample:', a.locs.slice(0, 5));
	if (b.locs.length) console.log('STOCK locs sample:', b.locs.slice(0, 5));
}

if (fs.existsSync(THROW_FILE)) {
	const lines = fs.readFileSync(THROW_FILE, 'utf8').trim().split('\n').filter(Boolean);
	console.log(`\n=== TNB_TRACE_THROW hits=${lines.length} ===`);
	for (const line of lines.slice(0, 8)) {
		try {
			const j = JSON.parse(line);
			console.log(
				JSON.stringify({
					message: String(j.message ?? j.err ?? '').slice(0, 200),
					stack: String(j.stack ?? '')
						.split('\n')
						.slice(0, 12)
						.join(' | '),
				}),
			);
		} catch {
			console.log(line.slice(0, 400));
		}
	}
} else {
	console.log('\n=== TNB_TRACE_THROW: no file ===');
}
