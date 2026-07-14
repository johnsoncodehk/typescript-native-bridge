#!/usr/bin/env node
// Witness: TNB vs stock completionInfo parity on name/kind/kindModifiers/sortText.
// Sites: main.vue script global, plain .ts global, import-specifier.
// BASELINE_OUT=/tmp/... writes a snapshot; COMPARE_BASELINE=/tmp/... fails on regression.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(testWorkspacePath, 'component-meta/#4577/main.vue');
const fixtureTs = path.join(testWorkspacePath, 'tsconfigProject/fixture.ts');
const projectRootTs = path.join(testWorkspacePath, 'tsconfigProject');

const OUT = process.env.BASELINE_OUT || process.env.COMPARE_OUT || '';
const COMPARE = process.env.COMPARE_BASELINE || '';
const ALLOWLIST = new Set(
	(process.env.PARITY_ALLOWLIST || '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean),
);

const harnessArgsVue = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];
const harnessArgsTs = [
	'--disableAutomaticTypingAcquisition',
	'--suppressDiagnosticEvents',
];

const prefs = {
	includeCompletionsForModuleExports: true,
	includeCompletionsForImportStatements: true,
	includeCompletionsWithInsertText: true,
	includePackageJsonAutoImports: 'auto',
};

function entryKey(e) {
	return `${e.name}\x1f${e.kind}\x1f${e.kindModifiers ?? ''}\x1f${e.sortText ?? ''}`;
}

function normalizeEntries(body) {
	const entries = body?.entries ?? (Array.isArray(body) ? body : []);
	return entries
		.map(e => ({
			name: e.name,
			kind: e.kind,
			kindModifiers: e.kindModifiers ?? '',
			sortText: e.sortText ?? '',
		}))
		.sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
}

function setDiff(aKeys, bKeys) {
	const A = new Set(aKeys);
	const B = new Set(bKeys);
	const onlyA = [...A].filter(k => !B.has(k));
	const onlyB = [...B].filter(k => !A.has(k));
	return { onlyA, onlyB };
}

async function completionAt(label, tsserverPath, env, args, openFile, line, offset, fileContent) {
	return withTsserver({ tsserverPath, args, env }, async ({ send }) => {
		await send('configure', { preferences: prefs });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{
				file: openFile,
				fileContent: fileContent ?? fs.readFileSync(openFile, 'utf8'),
				projectRootPath: openFile.endsWith('.vue') ? testWorkspacePath : projectRootTs,
			}],
		});
		const warm = await send('completionInfo', { file: openFile, line, offset });
		const res = await send('completionInfo', { file: openFile, line, offset });
		return {
			label,
			success: !!res?.success,
			warmEntries: warm?.body?.entries?.length ?? 0,
			entries: normalizeEntries(res?.body),
		};
	});
}

const mainVueContent = fs.readFileSync(mainVue, 'utf8');
const tsGlobalContent = 'const localFoo = 1;\n\n';
const tsImportContent = "import {  } from 'vue';\n";

const sites = [
	{
		id: 'vue-script-global',
		file: mainVue,
		line: 12,
		offset: 1,
		content: mainVueContent,
		args: harnessArgsVue,
	},
	{
		id: 'ts-global',
		file: fixtureTs,
		line: 2,
		offset: 1,
		content: tsGlobalContent,
		args: harnessArgsTs,
	},
	{
		id: 'ts-import-specifier',
		file: fixtureTs,
		line: 1,
		offset: 10, // after "import { "
		content: tsImportContent,
		args: harnessArgsTs,
	},
];

const report = { sites: [], ok: true, allowlist: [...ALLOWLIST] };

for (const site of sites) {
	const tnb = await completionAt(
		`TNB/${site.id}`,
		tnbPath,
		tnbHarnessEnv(),
		site.args,
		site.file,
		site.line,
		site.offset,
		site.content,
	);
	const stock = await completionAt(
		`STOCK/${site.id}`,
		stockPath,
		process.env,
		site.args,
		site.file,
		site.line,
		site.offset,
		site.content,
	);
	const tnbKeys = tnb.entries.map(entryKey);
	const stockKeys = stock.entries.map(entryKey);
	const { onlyA: onlyTnb, onlyB: onlyStock } = setDiff(tnbKeys, stockKeys);
	const filteredTnb = onlyTnb.filter(k => !ALLOWLIST.has(`${site.id}|${k}`) && !ALLOWLIST.has(k));
	const filteredStock = onlyStock.filter(k => !ALLOWLIST.has(`${site.id}|${k}`) && !ALLOWLIST.has(k));
	const match = filteredTnb.length === 0 && filteredStock.length === 0;
	if (!match) report.ok = false;
	const siteReport = {
		id: site.id,
		match,
		tnbCount: tnb.entries.length,
		stockCount: stock.entries.length,
		onlyTnb: onlyTnb.slice(0, 40),
		onlyStock: onlyStock.slice(0, 40),
		onlyTnbTotal: onlyTnb.length,
		onlyStockTotal: onlyStock.length,
		filteredMismatch: { onlyTnb: filteredTnb.length, onlyStock: filteredStock.length },
	};
	report.sites.push(siteReport);
	console.log(
		`\n=== ${site.id}: ${match ? 'MATCH' : 'DIFF'} tnb=${tnb.entries.length} stock=${stock.entries.length} `
		+ `onlyTnb=${onlyTnb.length} onlyStock=${onlyStock.length} ===`,
	);
	if (!match) {
		for (const k of filteredTnb.slice(0, 15)) console.log(`  onlyTNB: ${k.replace(/\x1f/g, ' | ')}`);
		for (const k of filteredStock.slice(0, 15)) console.log(`  onlySTOCK: ${k.replace(/\x1f/g, ' | ')}`);
	}
}

if (OUT) {
	fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
	console.log(`\nwrote ${OUT}`);
}

if (COMPARE) {
	const base = JSON.parse(fs.readFileSync(COMPARE, 'utf8'));
	let regressed = false;
	for (const site of report.sites) {
		const b = (base.sites || []).find(s => s.id === site.id);
		if (!b) continue;
		const worse =
			site.filteredMismatch.onlyTnb + site.filteredMismatch.onlyStock
			> (b.filteredMismatch?.onlyTnb ?? b.onlyTnbTotal ?? 0)
				+ (b.filteredMismatch?.onlyStock ?? b.onlyStockTotal ?? 0);
		if (worse || (b.match && !site.match)) {
			regressed = true;
			console.log(`REGRESS ${site.id}: baseline match=${b.match} now match=${site.match}`);
		}
	}
	if (regressed) {
		console.log('\nPARITY REGRESSION vs baseline');
		process.exit(2);
	}
}

console.log(`\nparity: ${report.ok ? 'PASS' : 'FAIL'} sites=${report.sites.length}`);
process.exit(report.ok ? 0 : 1);
