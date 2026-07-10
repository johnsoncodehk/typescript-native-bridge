#!/usr/bin/env node
/** Check sourceFile.path consistency across LS materializations (css.ts). */
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
const paths = new Set();
for (let i = 0; i < 5; i++) {
	const sf = ls.getProgram().getSourceFile(cssTs);
	paths.add(sf?.path);
	paths.add(sf?.fileName);
	ls.getCompletionsAtPosition(cssTs, content.length, {
		includeCompletionsForModuleExports: true,
		includeCompletionsWithInsertText: true,
	});
}
console.log('unique paths:', [...paths]);
console.log('cssTs arg:', cssTs);
