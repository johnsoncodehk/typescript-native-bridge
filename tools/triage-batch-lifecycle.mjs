#!/usr/bin/env node
/** Check getModuleExportMap availability during completion lifecycle. */
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

function batchStats(label) {
	const program = ls.getProgram();
	const batch = program.getModuleExportMap?.(cssTs);
	const mods = batch?.modules?.length ?? 0;
	const proc = batch?.modules?.some(m => (m.moduleName ?? '').includes('process'));
	const compiler = batch?.modules?.some(m => (m.moduleName ?? '').includes('compiler-dom'));
	console.log(`${label}: modules=${mods} process=${!!proc} compiler-dom=${!!compiler}`);
}

batchStats('before');
ls.getCompletionsAtPosition(cssTs, content.length, {
	includeCompletionsForModuleExports: true,
	includeCompletionsWithInsertText: true,
});
batchStats('after completion 1');
if (ts.getExportInfoMap) {
	const sf = ls.getProgram().getSourceFile(cssTs);
	ts.getExportInfoMap(sf, host, ls.getProgram(), { includeCompletionsForModuleExports: true }, undefined);
}
batchStats('after explicit export map');
ls.getCompletionsAtPosition(cssTs, content.length, {
	includeCompletionsForModuleExports: true,
	includeCompletionsWithInsertText: true,
});
batchStats('after completion 2');
