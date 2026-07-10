#!/usr/bin/env node
/** Debug why TNB getCompletionsAtPosition returns undefined on css.ts EOF. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const tsPath = path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);

const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(cssTs, 'utf8');
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
	...ts.sys,
	getCurrentDirectory: () => volarRoot,
	onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, { getCanonicalFileName: f => f, getCurrentDirectory: () => volarRoot, getNewLine: () => '\n' })); },
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
	log: msg => console.log('[host]', msg.trim()),
};

const ls = ts.createLanguageService(host);
try {
	const comp = ls.getCompletionsAtPosition(cssTs, content.length, {
		includeCompletionsForModuleExports: true,
		includeCompletionsWithInsertText: true,
	});
	console.log('comp ok:', !!comp, 'entries:', comp?.entries?.length);
	for (const name of ['cwd', 'abort', 'BASE_TRANSITION']) {
		const e = comp?.entries?.find(x => x.name === name);
		console.log(name, e?.source ?? 'MISSING');
	}
} catch (e) {
	console.error('THREW:', e);
}
