#!/usr/bin/env node
/**
 * quickinfo residue: hovering `export default ...` shows
 * `(property) default: any` in TNB while stock shows the real type.
 * Witness sites: component-meta/component-name-description/component-ts.ts:6:1
 * and component-meta/non-component/component.ts:1:1.
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

const SITES = [
	{ file: path.join(tw, 'component-meta/component-name-description/component-ts.ts'), line: 6, offset: 1 },
	{ file: path.join(tw, 'component-meta/component-name-description/component-ts.ts'), line: 6, offset: 8 },
	{ file: path.join(tw, 'component-meta/non-component/component.ts'), line: 1, offset: 1 },
];

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function run(label, serverPath, env) {
	return withTsserver({ tsserverPath: serverPath, args: harnessArgs, env, deadlineMs: 180_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		for (const site of SITES) {
			await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: site.file, fileContent: fs.readFileSync(site.file, 'utf8'), projectRootPath: tw }] });
			const r = await send('quickinfo', { file: site.file, line: site.line, offset: site.offset }, 30_000);
			const disp = String(r?.body?.displayString ?? '').replace(/\s+/g, ' ').slice(0, 120);
			console.log(`${label} ${path.basename(path.dirname(site.file))}/${path.basename(site.file)}:${site.line}:${site.offset} success=${!!r?.success} kind=${r?.body?.kind} display=${JSON.stringify(disp)}`);
			await send('updateOpen', { changedFiles: [], closedFiles: [site.file], openFiles: [] });
		}
	});
}

await run('TNB  ', tnbPath, tnbHarnessEnv());
if (fs.existsSync(stockPath)) await run('STOCK', stockPath, process.env);
