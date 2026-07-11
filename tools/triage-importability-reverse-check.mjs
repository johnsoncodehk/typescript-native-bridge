#!/usr/bin/env node
/** Reverse check: stock auto-import from declared vs undeclared packages at css.ts. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const checks = [
	{ label: 'declared volar-service-css', source: 'volar-service-css', name: 'create' },
	{ label: 'declared @vue/shared', source: '@vue/shared', name: 'camelize' },
	{ label: 'undeclared domain ambient', source: 'domain', name: 'create' },
	{ label: 'undeclared @vue/compiler-dom', source: '@vue/compiler-dom', name: 'createCommentVNode' },
];

const stock = await withTsserver({ tsserverPath: stockPath, args: harnessArgs, env: process.env }, async ({ send }) => {
	await send('configure', { preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } });
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }] });
	const comp = await send('completionInfo', { file: testFile, line, offset: col, includeExternalModuleExports: true, includeInsertTextCompletions: true });
	return comp?.body?.entries ?? [];
});

console.log('stock total auto:', stock.filter(e => e.source).length);
for (const c of checks) {
	const hit = stock.find(e => e.name === c.name && e.source === c.source);
	const anyFromSource = stock.filter(e => e.source === c.source);
	console.log(`\n${c.label}:`);
	console.log(`  exact ${c.name}@${c.source}:`, hit ? 'YES' : 'NO');
	console.log(`  any from ${c.source}:`, anyFromSource.length, anyFromSource.slice(0, 5).map(e => e.name).join(', '));
}

fs.writeFileSync('/tmp/tnb-importability-reverse-check.txt', [
	`stock auto total: ${stock.filter(e => e.source).length}`,
	...checks.map(c => {
		const hit = stock.find(e => e.name === c.name && e.source === c.source);
		const any = stock.filter(e => e.source === c.source);
		return `${c.label}: exact=${hit ? 'YES' : 'NO'} anyFromSource=${any.length} sample=${any.slice(0, 5).map(e => e.name).join(',')}`;
	}),
].join('\n') + '\n');
console.log('\nwritten /tmp/tnb-importability-reverse-check.txt');
