#!/usr/bin/env node
/** Dump whether cwd appears anywhere in TNB completionInfo response. */
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

await withTsserver({
	tsserverPath: path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js'),
	args: [
		'--disableAutomaticTypingAcquisition',
		'--globalPlugins', '@vue/typescript-plugin',
		'--pluginProbeLocations', path.join(volarRoot, 'packages/language-server'),
		'--suppressDiagnosticEvents',
	],
	env: tnbHarnessEnv(),
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
	const cwd = entries.filter(e => e.name === 'cwd');
	console.log('cwd entries:', cwd.length);
	for (const e of cwd) console.log(JSON.stringify(e));
	const proc = entries.filter(e => (e.source ?? '').includes('process'));
	console.log('process-sourced total:', proc.length, 'sample:', proc.slice(0, 5).map(e => e.name));
});
