#!/usr/bin/env node
/** Count export-map keys and compare path keys during populate vs search. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const ts = require(path.join(volarRoot, 'node_modules/typescript'));
const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(cssTs, 'utf8');
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
	...ts.sys,
	getCurrentDirectory: () => volarRoot,
	onUnRecoverableConfigFileDiagnostic: () => { throw new Error('x'); },
});
const host = {
	getCompilationSettings: () => parsed.options,
	getCurrentDirectory: () => volarRoot,
	getScriptFileNames: () => [...new Set([...parsed.fileNames, cssTs])],
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
const prefs = { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true };
const program = ls.getProgram();
const sf = program.getSourceFile(cssTs);
console.log('sf.path:', sf.path);
console.log('sf.fileName:', sf.fileName);
console.log('sf.path === fileName:', sf.path === sf.fileName);

const getExportInfoMap = ts.getExportInfoMap;
if (!getExportInfoMap) {
	console.error('no getExportInfoMap export');
	process.exit(1);
}

function countMap(map, searchPath) {
	let keys = 0;
	let cwd = 0;
	let base = 0;
	map.search(searchPath, false, () => true, (info, name) => {
		keys++;
		if (name === 'cwd') cwd += info.length;
		if (name === 'BASE_TRANSITION') base += info.length;
	});
	return { keys, cwd, base };
}

// populate via explicit call
const map1 = getExportInfoMap(sf, host, program, prefs, undefined);
console.log('\nexplicit map on sf.path:', countMap(map1, sf.path));
console.log('explicit map on fileName:', countMap(map1, sf.fileName));
console.log('isUsable sf.path:', map1.isUsableByFile?.(sf.path));
console.log('isUsable fileName:', map1.isUsableByFile?.(sf.fileName));

// after completion internal populate
ls.getCompletionsAtPosition(cssTs, content.length, prefs);
const map2 = getExportInfoMap(sf, host, program, prefs, undefined);
console.log('\nafter completion explicit map:', countMap(map2, sf.path));

// check __cache size if debug
const cache = map1.__cache;
if (cache) console.log('__cache size:', cache.size);
