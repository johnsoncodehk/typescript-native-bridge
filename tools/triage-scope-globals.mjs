#!/usr/bin/env node
/** List getSymbolsInScope globals at css.ts EOF (TNB vs stock). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(cssTs, 'utf8');
const pos = content.length;
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');

function probe(label, tsPath) {
	const ts = require(tsPath);
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
	const program = ls.getProgram();
	const sf = program.getSourceFile(cssTs);
	const checker = program.getTypeChecker();
	const meaning = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias;
	const syms = checker.getSymbolsInScope(sf, meaning);
	const names = syms.map(s => s.name).filter(Boolean).sort();
	const watch = ['cwd', 'abort', 'ref', 'BASE_TRANSITION', 'process', 'Buffer'];
	console.log(`\n${label} scope count=${syms.length} externalModule=${!!sf.externalModuleIndicator}`);
	for (const w of watch) {
		const found = syms.filter(s => s.name === w);
		if (!found.length) {
			console.log(`  ${w}: absent`);
			continue;
		}
		for (const s of found) {
			console.log(`  ${w}: flags=0x${(s.flags >>> 0).toString(16)} objectRegistry=${!!s.objectRegistry}`);
		}
	}
}

probe('TNB', path.join(volarRoot, 'node_modules/typescript'));
const stock = process.env.STOCK_TSSERVER_PATH?.replace(/lib\/tsserver\.js$/, '') ?? '/tmp/stock-ts-p3/package';
probe('STOCK', path.join(stock === '/tmp/stock-ts-p3/package' ? stock : path.dirname(stock), 'typescript.js') === '/tmp/stock-ts-p3/package/typescript.js'
	? '/tmp/stock-ts-p3/package'
	: stock);
try {
	probe('STOCK', '/tmp/stock-ts-p3/package');
} catch (e) {
	console.error('STOCK probe failed:', e.message);
}
