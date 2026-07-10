#!/usr/bin/env node
/** Count export-map entries per module for css.ts (TNB batch path). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const label = process.argv[2] ?? 'TNB';
const tsserverPath = label === 'STOCK'
	? (process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js')
	: path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);
const logFile = `/tmp/tnb-export-count-${label}.log`;

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
	'--logVerbosity', 'verbose',
	'--logFile', logFile,
];

const env = label === 'TNB' ? tnbHarnessEnv() : process.env;

await withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
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
	await send('completionInfo', {
		file: testFile,
		line,
		offset: col,
		includeExternalModuleExports: true,
		includeInsertTextCompletions: true,
	});
	const log = fs.readFileSync(logFile, 'utf8');
	const batchLine = log.split('\n').find(l => /populateExportInfoMapFromModuleExportMapBatch|getModuleExportMap|usedBatch/i.test(l));
	const mapDone = log.split('\n').filter(l => /getExportInfoMap:/.test(l));
	console.log(label, 'log:', logFile);
	for (const l of mapDone) console.log(l.trim());
	if (batchLine) console.log('batch:', batchLine.trim());
});
