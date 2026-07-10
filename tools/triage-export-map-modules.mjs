#!/usr/bin/env node
/**
 * Compare export-map module export counts (TNB batch vs stock checker walk) for css.ts project.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const label = process.argv[2] ?? 'TNB';
const volarRoot = resolveVolarRoot();
const tsPath = label === 'STOCK'
	? (process.env.STOCK_TYPESCRIPT_PATH ?? '/tmp/stock-ts-p3/package')
	: path.join(volarRoot, 'node_modules/typescript');
const require = createRequire(import.meta.url);
const ts = require(tsPath);

const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(
	tsconfig,
	{},
	{
		...ts.sys,
		getCurrentDirectory: () => volarRoot,
		onUnRecoverableConfigFileDiagnostic: d => {
			throw new Error(ts.formatDiagnostic(d, {
				getCanonicalFileName: f => f,
				getCurrentDirectory: () => volarRoot,
				getNewLine: () => '\n',
			}));
		},
	},
);

const rootNames = [...new Set([...parsed.fileNames, cssTs])];
const host = {
	...ts.createCompilerHost(parsed.options, true),
	getCurrentDirectory: () => volarRoot,
	getCanonicalFileName: f => f,
};
const program = ts.createProgram({ rootNames, options: parsed.options, host });
const checker = program.getTypeChecker();

const targets = [
	'@vue/compiler-dom',
	'@vue/shared',
	'process',
	'node:process',
];

function countModuleExports(moduleName) {
	for (const sf of program.getSourceFiles()) {
		if (!sf.symbol) continue;
		const mod = checker.getMergedSymbol(sf.symbol);
		const name = ts.unescapeLeadingUnderscores(mod.name);
		if (name !== `"${moduleName}"` && name !== moduleName && !sf.fileName.includes(moduleName.replace('node:', ''))) continue;
		if (moduleName.startsWith('@') && !sf.fileName.includes(moduleName.split('/')[0].slice(1))) continue;
		if (moduleName === '@vue/compiler-dom' && !sf.fileName.includes('@vue+compiler-dom') && !sf.fileName.includes('@vue/compiler-dom')) continue;
		if (moduleName === '@vue/shared' && !sf.fileName.includes('@vue+shared') && !sf.fileName.includes('@vue/shared')) continue;
		if ((moduleName === 'process' || moduleName === 'node:process') && !sf.fileName.includes('node/process') && !sf.fileName.includes('node:process')) continue;

		let total = 0;
		let valueFlags = 0;
		const sample = [];
		checker.forEachExportAndPropertyOfModule(mod, (sym, key) => {
			total++;
			const flags = checker.skipAlias(sym).flags;
			if (flags & ts.SymbolFlags.Value) valueFlags++;
			if (sample.length < 8) sample.push(key);
		});
		return { file: sf.fileName, total, valueFlags, sample };
	}
	// ambient
	for (const amb of checker.getAmbientModules()) {
		const name = ts.unescapeLeadingUnderscores(amb.name);
		if (name !== moduleName) continue;
		let total = 0;
		let valueFlags = 0;
		const sample = [];
		checker.forEachExportAndPropertyOfModule(amb, (sym, key) => {
			total++;
			const flags = checker.skipAlias(sym).flags;
			if (flags & ts.SymbolFlags.Value) valueFlags++;
			if (sample.length < 8) sample.push(key);
		});
		return { file: '(ambient)', total, valueFlags, sample };
	}
	return null;
}

console.log(label, 'typescript:', tsPath);
const batchFn = program.getModuleExportMap?.bind(program);
if (batchFn) {
	const batch = batchFn(cssTs);
	const mods = batch?.modules ?? [];
	console.log('batch modules:', mods.length);
	for (const t of targets) {
		const hit = mods.filter(m => m.moduleName === `"${t}"` || m.moduleName === t || m.moduleFileName?.includes(t.replace('node:', '')));
		for (const m of hit) {
			console.log(`  batch ${t}: named=${m.namedExports?.length ?? 0} default=${!!m.defaultExport} file=${m.moduleFileName ?? 'ambient'}`);
		}
		if (!hit.length) console.log(`  batch ${t}: MISSING`);
	}
} else {
	console.log('batch: N/A (no getModuleExportMap)');
}

console.log('checker walk:');
for (const t of targets) {
	const r = countModuleExports(t);
	if (!r) {
		console.log(`  ${t}: not found`);
		continue;
	}
	console.log(`  ${t}: total=${r.total} value=${r.valueFlags} file=${path.basename(r.file)} sample=${r.sample.join(',')}`);
}
