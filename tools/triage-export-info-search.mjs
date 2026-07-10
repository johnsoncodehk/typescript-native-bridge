#!/usr/bin/env node
/** Search ExportInfoMap for missing auto-import symbols (css.ts context). */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const tsPath = path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);

const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = require('node:fs').readFileSync(cssTs, 'utf8');
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
	...ts.sys,
	getCurrentDirectory: () => volarRoot,
	onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, { getCanonicalFileName: f => f, getCurrentDirectory: () => volarRoot, getNewLine: () => '\n' })); },
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
	log: msg => { if (/getExportInfoMap/.test(msg)) console.log('[host]', msg.trim()); },
};

const ls = ts.createLanguageService(host);
const program = ls.getProgram();
const sf = program.getSourceFile(cssTs);
const preferences = { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true };

// Warm export map via completion (getExportInfoMap is internal; completion triggers populate).
ls.getCompletionsAtPosition(cssTs, content.length, preferences);

const getExportInfoMap = ts.getExportInfoMap;
if (!getExportInfoMap) {
	console.error('getExportInfoMap not exposed on ts namespace');
	process.exit(1);
}

const map = getExportInfoMap(sf, host, program, preferences, undefined);
const names = ['BASE_TRANSITION', 'CREATE_VNODE', 'cwd', 'ref', 'Fragment', 'abort'];

console.log('sf.path:', sf.path);
console.log('moduleResolution:', parsed.options.moduleResolution, 'resolvePackageJsonExports:', parsed.options.resolvePackageJsonExports);
console.log('map.isEmpty:', map.isEmpty?.());

for (const name of names) {
	let hits = 0;
	const details = [];
	map.search(sf.path, false, (n, flags) => n === name && !!(flags & ts.SymbolFlags.Value), (info, symName, isAmbient) => {
		hits += info.length;
		for (const i of info) {
			details.push({
				moduleName: i.moduleName,
				moduleFile: i.moduleFileName?.slice(-50),
				isAmbient,
				targetFlags: '0x' + (i.targetFlags >>> 0).toString(16),
				symbolTransient: !!(i.symbol?.flags & ts.SymbolFlags.Transient),
			});
		}
	});
	console.log(`${name}: hits=${hits}`, JSON.stringify(details));
}

const batch = program.getModuleExportMap?.(cssTs);
const procMod = batch?.modules?.find(m => m.moduleName === '"process"' || m.moduleName === 'process');
console.log('batch process:', procMod ? `named=${procMod.namedExports.length} cwd=${procMod.namedExports.some(e => e.key === 'cwd')}` : 'MISSING');

const comp = ls.getCompletionsAtPosition(cssTs, content.length, preferences);
for (const name of names) {
	const all = comp?.entries?.filter(x => x.name === name) ?? [];
	console.log(`completion ${name}:`, all.length ? all.map(e => e.source ?? '(local)') : 'MISSING');
}
