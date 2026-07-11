#!/usr/bin/env node
/**
 * Probe why the local `create` (css.ts's own export) is missing from TNB
 * completions: inspect getSymbolsInScope for `create` in both TNB and stock.
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

function probeScope(label, tsPath) {
	const ts = require(tsPath);
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
	const syms = checker.getSymbolsInScope(sf, meaning);
	const matches = syms.filter(s => s.name === 'create');
	console.log(`\n${label} getSymbolsInScope total=${syms.length} create-matches=${matches.length}`);
	for (const m of matches) {
		const declFiles = (m.declarations ?? []).map(d => d.getSourceFile().fileName.slice(-60));
		console.log(`  flags=0x${(m.flags >>> 0).toString(16)} objectRegistry=${!!m.objectRegistry} valueDecl=${!!m.valueDeclaration} declFiles=${JSON.stringify(declFiles)} inFile=${(m.declarations ?? []).some(d => d.getSourceFile() === sf)}`);
	}
}

probeScope('TNB-LS', path.join(volarRoot, 'node_modules/typescript'));
probeScope('STOCK-LS', '/tmp/stock-ts-p3/package');
