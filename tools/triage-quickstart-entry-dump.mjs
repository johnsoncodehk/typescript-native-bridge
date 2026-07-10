#!/usr/bin/env node
/**
 * P0 forensic: dump onlyStock quickstart completion entries (pass1 vs pass2).
 *
 * Usage:
 *   node tools/triage-quickstart-entry-dump.mjs stock|tnb|both
 *   node tools/triage-quickstart-entry-dump.mjs stock --log /tmp/tsserver-stock-p0.log
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const TARGET_NAMES = [
	'createLanguageCommon',
	'createLanguageServicePlugin',
	'decoratedLanguageServiceHosts',
	'decoratedLanguageServices',
	'externalFiles',
	'isHasAlreadyDecoratedLanguageService',
	'makeGetExternalFiles',
	'makeGetScriptInfoWithLargeFileFailsafe',
	'projectExternalFileExtensions',
	'css',
	'typescriptPlugin',
];

const volarRoot = resolveVolarRoot();
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);

const PREFERENCES = {
	includePackageJsonAutoImports: 'auto',
	includeCompletionsForModuleExports: true,
	includeCompletionsWithInsertText: true,
};

const harnessArgsBase = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

function parseCli(argv) {
	let mode = 'both';
	let logFile;
	for (const arg of argv) {
		if (arg === 'stock' || arg === 'tnb' || arg === 'both') {
			mode = arg;
		} else if (arg === '--log') {
			// consumed below
		} else if (argv[argv.indexOf('--log') + 1] === arg && argv[argv.indexOf('--log')] === '--log') {
			logFile = arg;
		}
	}
	const logIdx = argv.indexOf('--log');
	if (logIdx >= 0 && argv[logIdx + 1]) {
		logFile = argv[logIdx + 1];
	}
	return { mode, logFile };
}

/** @param {unknown[]} entries */
function pickTargets(entries) {
	const byName = new Map();
	for (const e of entries) {
		if (TARGET_NAMES.includes(e.name) && !byName.has(e.name)) {
			byName.set(e.name, e);
		}
	}
	return Object.fromEntries(TARGET_NAMES.map(name => [name, byName.get(name) ?? null]));
}

/** @param {unknown} entry */
function entrySummary(entry) {
	if (!entry) return { present: false };
	return {
		present: true,
		kind: entry.kind,
		source: entry.source ?? null,
		hasData: entry.data != null,
		dataFileName: entry.data?.fileName ?? null,
		hasSourceDisplayName: entry.sourceDisplayName != null,
		sortText: entry.sortText ?? null,
	};
}

async function runDump(label, tsserverPath, env, logFile) {
	const args = [...harnessArgsBase];
	if (logFile) {
		args.push('--logVerbosity', 'verbose', '--logFile', logFile);
	}

	return withTsserver({ tsserverPath, args, env }, async ({ send }) => {
		const configureRes = await send('configure', { preferences: PREFERENCES });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }],
		});

		const completionArgs = {
			file: testFile,
			line,
			offset: col,
			includeExternalModuleExports: true,
			includeInsertTextCompletions: true,
		};

		const pass1 = await send('completionInfo', completionArgs);
		const pass2 = await send('completionInfo', completionArgs);

		const entries1 = pass1.body?.entries ?? [];
		const entries2 = pass2.body?.entries ?? [];
		const picked1 = pickTargets(entries1);
		const picked2 = pickTargets(entries2);

		const result = {
			label,
			tsserverPath,
			preferences: PREFERENCES,
			configureSuccess: configureRes.success,
			pass1: {
				totalEntries: entries1.length,
				summary: Object.fromEntries(TARGET_NAMES.map(n => [n, entrySummary(picked1[n])])),
				entries: picked1,
			},
			pass2: {
				totalEntries: entries2.length,
				summary: Object.fromEntries(TARGET_NAMES.map(n => [n, entrySummary(picked2[n])])),
				entries: picked2,
			},
			logFile: logFile ?? null,
		};

		// Optional: completionEntryDetails for first entry with data
		const sampleWithData = TARGET_NAMES.map(n => picked2[n]).find(e => e?.data != null);
		if (sampleWithData) {
			const details = await send('completionEntryDetails', {
				file: testFile,
				entryName: sampleWithData.name,
				source: sampleWithData.source,
				data: sampleWithData.data,
			});
			result.completionEntryDetails = {
				entryName: sampleWithData.name,
				success: details.success,
				codeActions: details.body?.codeActions?.map(a => ({
					description: a.description,
					changes: a.changes?.map(c => ({
						fileName: c.fileName,
						textChanges: c.textChanges?.length ?? 0,
					})),
				})) ?? [],
			};
		}

		return result;
	});
}

function printResult(result) {
	console.log(`\n=== ${result.label} ===`);
	console.log('tsserver:', result.tsserverPath);
	console.log('preferences:', JSON.stringify(result.preferences));
	if (result.logFile) console.log('log:', result.logFile);
	console.log(`pass1 total=${result.pass1.totalEntries}  pass2 total=${result.pass2.totalEntries}`);
	console.log('\nname | pass1 | pass2 | source | hasData | data.fileName');
	for (const name of TARGET_NAMES) {
		const s1 = result.pass1.summary[name];
		const s2 = result.pass2.summary[name];
		const p1 = s1.present ? 'Y' : '-';
		const p2 = s2.present ? 'Y' : '-';
		const src = s2.source ?? s1.source ?? '';
		const data = s2.hasData || s1.hasData ? 'Y' : '-';
		const fn = s2.dataFileName ?? s1.dataFileName ?? '';
		console.log(`${name} | ${p1} | ${p2} | ${src} | ${data} | ${fn}`);
	}
	console.log('\n--- pass2 full entries ---');
	for (const name of TARGET_NAMES) {
		const e = result.pass2.entries[name];
		if (e) console.log(`${name}:`, JSON.stringify(e, null, 2));
	}
	if (result.completionEntryDetails) {
		console.log('\n--- completionEntryDetails sample ---');
		console.log(JSON.stringify(result.completionEntryDetails, null, 2));
	}
}

const { mode, logFile } = parseCli(process.argv.slice(2));

const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

const results = [];

if (mode === 'stock' || mode === 'both') {
	results.push(await runDump('stock', stockPath, process.env, mode === 'stock' ? logFile : undefined));
}
if (mode === 'tnb' || mode === 'both') {
	results.push(await runDump('tnb', tnbPath, tnbHarnessEnv(), mode === 'tnb' ? logFile : undefined));
}

for (const r of results) printResult(r);

if (results.length === 2) {
	console.log('\n=== pass1 vs pass2 timing (H4) ===');
	for (const r of results) {
		const onlyPass2 = TARGET_NAMES.filter(n => !r.pass1.summary[n].present && r.pass2.summary[n].present);
		const onlyPass1 = TARGET_NAMES.filter(n => r.pass1.summary[n].present && !r.pass2.summary[n].present);
		const inBoth = TARGET_NAMES.filter(n => r.pass1.summary[n].present && r.pass2.summary[n].present);
		console.log(`${r.label}: inBoth=${inBoth.length} onlyPass1=${onlyPass1.length} onlyPass2=${onlyPass2.length}`);
		if (onlyPass2.length) console.log(`  onlyPass2: ${onlyPass2.join(', ')}`);
	}
}

console.log('\n--- JSON ---');
console.log(JSON.stringify(results, null, 2));
