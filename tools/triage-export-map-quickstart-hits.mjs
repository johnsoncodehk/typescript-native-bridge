#!/usr/bin/env node
/**
 * Diagnose export map hits for quickstart symbols after css.ts warm completion.
 * Uses withTsserver only (stock vs TNB).
 *
 * Usage: node tools/triage-export-map-quickstart-hits.mjs [stock|tnb|both]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const TARGETS = ['createLanguageCommon', 'externalFiles', 'typescriptPlugin'];

const volarRoot = resolveVolarRoot();
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);

const mode = process.argv[2] ?? 'both';
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

const PREFERENCES = {
	includePackageJsonAutoImports: 'auto',
	includeCompletionsForModuleExports: true,
	includeCompletionsWithInsertText: true,
};

function searchExportMap(map, sfPath, ts, name) {
	const hits = [];
	map.search(sfPath, false, (n, flags) => n === name && !!(flags & ts.SymbolFlags.Value), info => {
		for (const i of info) {
			hits.push({
				moduleName: i.moduleName ?? null,
				moduleFileName: i.moduleFileName?.slice(-72) ?? null,
				isFromPackageJson: i.isFromPackageJson,
				exportKind: i.exportKind,
			});
		}
	});
	return hits;
}

async function run(label, tsserverPath, env) {
	const logFile = path.join(os.tmpdir(), `tnb-quickstart-hits-${label}-${Date.now()}.log`);
	const tsLib = path.join(path.dirname(tsserverPath), 'typescript.js');
	const require = createRequire(tsLib);
	const ts = require(tsLib);
	const getExportInfoMap = ts.getExportInfoMap;

	const harnessResult = await withTsserver({
		tsserverPath,
		args: [
			'--disableAutomaticTypingAcquisition',
			'--globalPlugins', '@vue/typescript-plugin',
			'--pluginProbeLocations', pluginProbe,
			'--suppressDiagnosticEvents',
			'--logVerbosity', 'verbose',
			'--logFile', logFile,
		],
		env,
	}, async ({ send }) => {
		await send('configure', { preferences: PREFERENCES });
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
		return comp;
	});

	const log = fs.readFileSync(logFile, 'utf8');
	const logLines = log.split('\n');
	const exportMapDone = logLines.find(l => l.includes('getExportInfoMap: done'))?.trim() ?? 'n/a';
	const providerFound = logLines.find(l => l.includes('AutoImportProviderProject: found'))?.trim() ?? 'n/a';
	const supplementMs = logLines.find(l => l.includes('forEachExternalModuleToImportFrom autoImportProvider'))?.trim() ?? 'n/a';

	// In-process export map with same ts build + volar tsconfig (no tsserver project graph).
	const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');
	const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
		...ts.sys,
		getCurrentDirectory: () => volarRoot,
		onUnRecoverableConfigFileDiagnostic: () => { throw new Error('bad tsconfig'); },
	});
	const host = {
		getCompilationSettings: () => parsed.options,
		getCurrentDirectory: () => volarRoot,
		getScriptFileNames: () => [...new Set([...parsed.fileNames, testFile])],
		getProjectVersion: () => '1',
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		getCanonicalFileName: f => f,
		useCaseSensitiveFileNames: () => true,
		getDefaultLibFileName: o => ts.getDefaultLibFileName(o),
		getScriptVersion: () => '1',
		getScriptSnapshot: f => {
			const text = f === testFile ? content : ts.sys.readFile(f);
			return text != null ? ts.ScriptSnapshot.fromString(text) : undefined;
		},
	};
	const ls = ts.createLanguageService(host);
	const program = ls.getProgram();
	const sf = program.getSourceFile(testFile);
	ls.getCompletionsAtPosition(testFile, offset, PREFERENCES);
	const mapHits = {};
	if (getExportInfoMap && sf) {
		const map = getExportInfoMap(sf, host, program, PREFERENCES, undefined);
		for (const name of TARGETS) {
			mapHits[name] = searchExportMap(map, sf.path, ts, name);
		}
	}

	const compEntries = harnessResult.body?.entries ?? [];
	const completionHits = Object.fromEntries(TARGETS.map(name => {
		const e = compEntries.find(x => x.name === name);
		return [name, e ? { source: e.source ?? null, isPackageJsonImport: e.isPackageJsonImport ?? null } : null];
	}));

	return {
		label,
		exportMapDone,
		providerFound,
		supplementMs,
		mapHits,
		completionHits,
		logFile,
	};
}

const runs = [];
if (mode === 'stock' || mode === 'both') runs.push(await run('stock', stockPath, process.env));
if (mode === 'tnb' || mode === 'both') runs.push(await run('tnb', tnbPath, tnbHarnessEnv()));

console.log('\n=== Diagnosis table ===');
console.log('label | target | mapHits | completion | map moduleName (first) | isFromPackageJson');
for (const r of runs) {
	for (const name of TARGETS) {
		const hits = r.mapHits[name] ?? [];
		const comp = r.completionHits[name];
		const first = hits[0];
		console.log([
			r.label,
			name,
			hits.length,
			comp ? 'Y' : '-',
			first?.moduleName ?? '',
			first?.isFromPackageJson ?? '',
		].join(' | '));
	}
	console.log(`${r.label} log: ${r.logFile}`);
	console.log(`  ${r.providerFound}`);
	console.log(`  ${r.exportMapDone}`);
	console.log(`  ${r.supplementMs}`);
}

console.log('\n--- JSON ---');
console.log(JSON.stringify(runs, null, 2));
