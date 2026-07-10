#!/usr/bin/env node
/** Probe cwd/process in export map vs completionInfo (Vue plugin harness). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);
const logFile = '/tmp/tnb-cwd-probe.log';

const harnessArgs = (verbose) => [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', path.join(volarRoot, 'packages/language-server'),
	'--suppressDiagnosticEvents',
	...(verbose ? ['--logVerbosity', 'verbose', '--logFile', logFile] : []),
];

async function run(label, tsserverPath, env, verbose = false) {
	await withTsserver({
		tsserverPath,
		args: harnessArgs(verbose),
		env,
	}, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
			},
		});
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }],
		});
		const comp = await send('completionInfo', {
			file: testFile,
			line,
			offset: col,
			includeExternalModuleExports: true,
			includeInsertTextCompletions: true,
		});
		const entries = comp.body?.entries ?? [];
		for (const name of ['cwd', 'abort', 'BASE_TRANSITION', 'ref']) {
			const e = entries.find(x => x.name === name);
			console.log(`${label} ${name}:`, e?.source ?? 'MISSING');
			const all = entries.filter(x => x.name === name);
			if (all.length > 1 || (all.length === 1 && !e?.source)) {
				console.log(`${label} ${name} all:`, all.map(x => x.source ?? '(local)'));
			}
		}
		const proc = entries.filter(e => e.source === 'process' || e.source === 'node:process');
		console.log(`${label} process-sourced:`, proc.length);
		if (verbose) {
			const log = fs.readFileSync(logFile, 'utf8');
			const collect = log.split('\n').filter(l => /collectAutoImports/.test(l));
			console.log(`${label} collectAutoImports logs:`, collect.slice(-4).join(' | '));
		}
	});
}

const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

await run('TNB', tnbPath, tnbHarnessEnv(), true);
await run('STOCK', stockPath, process.env, true);
