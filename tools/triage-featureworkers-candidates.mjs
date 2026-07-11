#!/usr/bin/env node
/**
 * Dump ExportInfoMap candidates for featureWorkers-related auto-import names.
 * Usage: node tools/triage-featureworkers-candidates.mjs [--stock]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const useStock = process.argv.includes('--stock');
const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const tsPath = useStock
	? '/tmp/stock-ts-p3/package'
	: path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);

const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(cssTs, 'utf8');
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
	...ts.sys,
	getCurrentDirectory: () => volarRoot,
	onUnRecoverableConfigFileDiagnostic: d => {
		throw new Error(ts.formatDiagnostic(d, {
			getCanonicalFileName: f => f,
			getCurrentDirectory: () => volarRoot,
			getNewLine: () => '\n',
		}));
	},
});

const rootNames = [...new Set([...parsed.fileNames, cssTs])];
const host = {
	getCompilationSettings: () => parsed.options,
	getCurrentDirectory: () => volarRoot,
	getScriptFileNames: () => rootNames,
	getProjectVersion: () => '1',
	fileExists: ts.sys.fileExists,
	readFile: ts.sys.readFile,
	getCanonicalFileName: f => f,
	useCaseSensitiveFileNames: () => true,
	getDefaultLibFileName: o => ts.getDefaultLibFileName(o),
	getScriptVersion: () => '1',
	getScriptSnapshot: f => {
		const text = f === cssTs ? content : ts.sys.readFile(f);
		return text != null ? ts.ScriptSnapshot.fromString(text) : undefined;
	},
};

const ls = ts.createLanguageService(host);
const program = ls.getProgram();
const sf = program.getSourceFile(cssTs);
const preferences = { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true };

ls.getCompletionsAtPosition(cssTs, content.length, preferences);

const getExportInfoMap = ts.getExportInfoMap;
if (!getExportInfoMap) {
	console.error('getExportInfoMap not exposed');
	process.exit(1);
}

const map = getExportInfoMap(sf, host, program, preferences, undefined);
const names = [
	'documentFeatureWorker', 'forEachEmbeddedDocument', 'getGeneratedPositions',
	'getGeneratedRange', 'getGeneratedRanges', 'getLinkedCodePositions',
	'getSourcePositions', 'getSourceRange', 'getSourceRanges',
	'languageFeatureWorker', 'safeCall',
];

console.log(`side=${useStock ? 'stock' : 'tnb'}`);
for (const name of names) {
	const details = [];
	map.search(sf.path, false, (n, flags) => n === name && !!(flags & ts.SymbolFlags.Value), (info, symName, isAmbient, key) => {
		for (const i of info) {
			details.push({
				key,
				moduleName: i.moduleName,
				moduleFile: i.moduleFileName?.replace(volarRoot, '<volar>'),
				isFromPackageJson: i.isFromPackageJson,
				symbolId: i.symbol ? ts.getSymbolId(i.symbol) : undefined,
			});
		}
	});
	console.log(`${name}: count=${details.length}`, JSON.stringify(details));
}

const batch = program.getModuleExportMap?.(cssTs);
const fwMods = batch?.modules?.filter(m => {
	const n = m.moduleName.replace(/"/g, '');
	return n.includes('featureWorkers') || n.includes('language-service');
}) ?? [];
console.log('batch featureWorkers-related modules:', fwMods.length);
for (const m of fwMods.slice(0, 5)) {
	console.log('  mod:', m.moduleName, 'file:', m.moduleFileName?.replace(volarRoot, '<volar>'), 'named:', m.namedExports.length,
		'hasSafeCall:', m.namedExports.some(e => e.key === 'safeCall'));
}
