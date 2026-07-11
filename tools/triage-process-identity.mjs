#!/usr/bin/env node
/**
 * Probe symbol identity between the tsgo scope-walk global `process` and the
 * batch export-map `process` module export (stock suppresses the auto-import
 * because they are the same symbol).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(cssTs, 'utf8');
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');

const ts = require(path.join(volarRoot, 'node_modules/typescript'));
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
	...ts.sys,
	getCurrentDirectory: () => volarRoot,
	onUnRecoverableConfigFileDiagnostic: () => { throw new Error('config'); },
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
const program = ls.getProgram();
const sf = program.getSourceFile(cssTs);
const checker = program.getTypeChecker();
const meaning = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias;
const scopeProcess = checker.getSymbolsInScope(sf, meaning).find(s => s.name === 'process');
console.log('scope process:', !!scopeProcess, scopeProcess && `flags=0x${(scopeProcess.flags >>> 0).toString(16)} registry=${!!scopeProcess.objectRegistry}`);

const batch = program.getModuleExportMap?.(cssTs);
console.log('batch total modules:', batch?.modules?.length);
const ambient = (batch?.modules ?? []).filter(m => !m.moduleFileName);
console.log('ambient module names sample:', ambient.slice(0, 8).map(m => m.moduleName));
const mods = (batch?.modules ?? []).filter(m => (m.moduleName ?? '').replace(/"/g, '').match(/^(node:)?process$/));
console.log('batch process modules:', mods.length);
for (const m of mods) {
	const d = m.defaultExport;
	console.log(`  module=${m.moduleName} hasDefault=${!!d} exportKind=${d?.exportKind} named=${m.namedExports?.length}`);
	if (d) {
		const sym = d.symbol;
		console.log(`    symbol name=${sym.name} flags=0x${(sym.flags >>> 0).toString(16)} sameRef=${sym === scopeProcess}`);
		const own = Object.keys(sym).filter(k => typeof sym[k] !== 'function');
		console.log(`    ownKeys=${JSON.stringify(own)}`);
		for (const k of ['id', 'handle', 'objectId', 'symbolId', 'checkFlags']) {
			if (sym[k] !== undefined || scopeProcess?.[k] !== undefined) console.log(`    ${k}: batch=${JSON.stringify(sym[k])} scope=${JSON.stringify(scopeProcess?.[k])}`);
		}
		if (sym.flags & ts.SymbolFlags.Alias) {
			try {
				const target = checker.getAliasedSymbol(sym);
				console.log(`    aliased -> name=${target.name} sameRefAsScope=${target === scopeProcess} flags=0x${(target.flags >>> 0).toString(16)}`);
			} catch (e) {
				console.log('    getAliasedSymbol failed:', e.message);
			}
		}
	}
}
