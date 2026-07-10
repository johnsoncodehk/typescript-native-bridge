#!/usr/bin/env node
/** Count completion entries with source (auto-import) in minimal LS. */
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
	log: msg => { if (/collectAutoImports/.test(msg)) console.log('[host]', msg.trim()); },
};
const ls = ts.createLanguageService(host);
const prefs = { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true };
const comp = ls.getCompletionsAtPosition(cssTs, content.length, prefs);
const entries = comp?.entries ?? [];
const withSource = entries.filter(e => e.source);
console.log('total', entries.length, 'withSource', withSource.length);
console.log('sample sources:', [...new Set(withSource.map(e => e.source))].slice(0, 15));
console.log('BASE_TRANSITION', entries.find(e => e.name === 'BASE_TRANSITION')?.source ?? 'MISSING');
console.log('cwd', entries.find(e => e.name === 'cwd')?.source ?? 'MISSING');
