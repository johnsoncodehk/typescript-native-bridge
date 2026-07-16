#!/usr/bin/env node
/**
 * F2 witness (79330f7 residue): def/refs success-mismatch
 * "Cannot read properties of undefined" — reps from fresh cluster:
 *   tsc/#4878/main.vue:16:16, tsc/defineExpose/main.vue:5:15
 * Prints the full TNB error stack for each site plus stock verdicts.
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

const ALL_SITES = [
	{ file: path.join(tw, 'tsc/#4878/main.vue'), line: 16, offset: 16 },
	{ file: path.join(tw, 'tsc/defineExpose/main.vue'), line: 5, offset: 15 },
];
// ONLY=defineExpose / ONLY=4878 to isolate cross-project interference.
const only = process.env.ONLY;
const SITES = only ? ALL_SITES.filter(s => s.file.includes(only)) : ALL_SITES;

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function run(label, tsserverPath, env) {
	const out = [];
	await withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 180_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		const openFiles = SITES.map(s => ({ file: s.file, fileContent: fs.readFileSync(s.file, 'utf8'), projectRootPath: tw }));
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		for (const s of SITES) {
			try {
				const pi = await send('projectInfo', { file: s.file, needFileNameList: true }, 15_000);
				const files = (pi?.body?.fileNames ?? []).filter(f => f.endsWith('.vue'));
				out.push({ site: `${path.basename(path.dirname(s.file))}/${path.basename(s.file)}`, cmd: 'projectInfo', success: !!pi?.success, n: 0, message: `${pi?.body?.configFileName} vueFiles=${JSON.stringify(files)}` });
			} catch { /* ok */ }
		}
		for (const s of SITES) {
			for (const cmd of ['definitionAndBoundSpan', 'references']) {
				const r = await send(cmd, { file: s.file, line: s.line, offset: s.offset }, 30_000);
				const locs = cmd === 'references'
					? (r?.body?.refs ?? []).map(x => `${path.basename(x.file)}|${x.start?.line}|${x.start?.offset}`)
					: (r?.body?.definitions ?? []).map(x => `${path.basename(x.file)}|${x.start?.line}|${x.start?.offset}`);
				out.push({
					site: `${path.basename(path.dirname(s.file))}/${path.basename(s.file)}:${s.line}:${s.offset}`,
					cmd,
					success: !!r?.success,
					message: r?.success ? `locs=${JSON.stringify(locs)}` : String(r?.message ?? ''),
					n: locs.length,
				});
			}
		}
	});
	return { label, out };
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = await run('STOCK', stockPath, process.env);

for (const side of [tnb, stock]) {
	console.log(`\n=== ${side.label} ===`);
	for (const r of side.out) {
		console.log(`${r.site} ${r.cmd} success=${r.success} n=${r.n}`);
		if (r.message) console.log(r.message.split('\n').slice(0, 10).join('\n'));
	}
}
