#!/usr/bin/env node
/**
 * F2 residue: #4878/main.vue self-import refs return [] when a second
 * configured project's .vue is also open (isolated run returns 2).
 * Matrix: open only #4878 vs open both, query only #4878 refs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const tw = path.join(volarRoot, 'test-workspace');
const site = { file: path.join(tw, 'tsc/#4878/main.vue'), line: 16, offset: 16 };
const sibling = path.join(tw, 'tsc/defineExpose/main.vue');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function run(label, files, serverPath = tnbPath, env = tnbHarnessEnv()) {
	return withTsserver({ tsserverPath: serverPath, args: harnessArgs, env, deadlineMs: 180_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: files.map(f => ({ file: f, fileContent: fs.readFileSync(f, 'utf8'), projectRootPath: tw })) });
		const r = await send('references', { file: site.file, line: site.line, offset: site.offset }, 30_000);
		const locs = (r?.body?.refs ?? []).map(x => `${path.basename(x.file)}|${x.start?.line}|${x.start?.offset}`);
		console.log(`${label}: success=${!!r?.success} n=${locs.length} locs=${JSON.stringify(locs)} msg=${r?.success ? '' : String(r?.message ?? '').split('\n')[0]}`);
	});
}

await run('ONLY-4878', [site.file]);
await run('BOTH-OPEN', [site.file, sibling]);
if (fs.existsSync(stockPath)) {
	await run('STOCK-ONLY-4878', [site.file], stockPath, process.env);
	await run('STOCK-BOTH-OPEN', [site.file, sibling], stockPath, process.env);
}
