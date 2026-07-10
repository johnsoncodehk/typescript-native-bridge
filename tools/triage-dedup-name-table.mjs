#!/usr/bin/env node
/**
 * Q2: exhaustive per-name entry count diff (TNB vs stock) on css.ts completionInfo.
 *
 * Usage:
 *   node tools/triage-dedup-name-table.mjs
 *   node tools/triage-dedup-name-table.mjs --out /tmp/tnb-dedup-diag-name-table.txt
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const outPath = process.argv.includes('--out')
	? process.argv[process.argv.indexOf('--out') + 1]
	: '/tmp/tnb-dedup-diag-name-table.txt';

const volarRoot = resolveVolarRoot();
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);
const pluginProbe = path.join(volarRoot, 'packages/language-server');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function fetchEntries(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
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
		const entries = comp?.body?.entries ?? [];
		console.log(`${label}: total=${entries.length} auto=${entries.filter(e => e.source).length} local=${entries.filter(e => !e.source).length}`);
		return entries;
	});
}

function countByName(entries, autoOnly) {
	const m = new Map();
	for (const e of entries) {
		if (autoOnly ? !e.source : e.source) continue;
		m.set(e.name, (m.get(e.name) ?? 0) + 1);
	}
	return m;
}

const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const tnb = await fetchEntries('TNB', tnbPath, tnbHarnessEnv());
const stock = await fetchEntries('STOCK', stockPath, process.env);

for (const [kind, autoOnly] of [['auto', true], ['local', false]]) {
	const tnbMap = countByName(tnb, autoOnly);
	const stockMap = countByName(stock, autoOnly);
	const allNames = new Set([...tnbMap.keys(), ...stockMap.keys()]);
	const rows = [];
	let sumDelta = 0;
	for (const name of allNames) {
		const tnbCount = tnbMap.get(name) ?? 0;
		const stockCount = stockMap.get(name) ?? 0;
		if (tnbCount !== stockCount) {
			const delta = tnbCount - stockCount;
			sumDelta += delta;
			rows.push({ name, tnbCount, stockCount, delta });
		}
	}
	rows.sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name));

	const lines = [`# ${kind} entries where TNB count != stock count`, `# columns: name | tnbCount | stockCount | delta`, ''];
	for (const r of rows) {
		lines.push(`${r.name} | ${r.tnbCount} | ${r.stockCount} | ${r.delta}`);
	}
	lines.push('');
	lines.push(`# total rows: ${rows.length}`);
	lines.push(`# sum delta: ${sumDelta}`);

	const sectionPath = outPath.replace(/\.txt$/, '') + `-${kind}.txt`;
	fs.writeFileSync(sectionPath, lines.join('\n') + '\n');
	console.log(`\n=== ${kind} ===`);
	console.log(`rows=${rows.length} sumDelta=${sumDelta}`);
	console.log(`written: ${sectionPath}`);
}

// Combined file for handout reference
const autoText = fs.readFileSync(outPath.replace(/\.txt$/, '') + '-auto.txt', 'utf8');
const localText = fs.readFileSync(outPath.replace(/\.txt$/, '') + '-local.txt', 'utf8');
fs.writeFileSync(outPath, autoText + '\n' + localText);
console.log(`\ncombined: ${outPath}`);
