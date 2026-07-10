#!/usr/bin/env node
/** Inspect batch export map targetFlags + sample missing completion names. */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const tsPath = path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);

const cssTs = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const tsconfig = path.join(volarRoot, 'packages/language-service/tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
	...ts.sys,
	getCurrentDirectory: () => volarRoot,
	onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, { getCanonicalFileName: f => f, getCurrentDirectory: () => volarRoot, getNewLine: () => '\n' })); },
});

const program = ts.createProgram({
	rootNames: [...new Set([...parsed.fileNames, cssTs])],
	options: parsed.options,
	host: { ...ts.createCompilerHost(parsed.options, true), getCurrentDirectory: () => volarRoot },
});

const batch = program.getModuleExportMap?.(cssTs);
const missing = ['BASE_TRANSITION', 'CREATE_VNODE', 'Fragment', 'ref', 'cwd', 'env', 'process'];
const mods = ['@vue/compiler-dom', '@vue/shared', 'process', 'node:process'];

for (const modName of mods) {
	const mod = batch?.modules?.find(m => m.moduleName === `"${modName}"` || m.moduleName === modName);
	if (!mod) {
		console.log(`${modName}: not in batch`);
		continue;
	}
	console.log(`\n${modName} named=${mod.namedExports.length} default=${!!mod.defaultExport}`);
	for (const name of missing) {
		const exp = mod.namedExports.find(e => e.key === name);
		if (!exp) {
			const def = mod.defaultExport?.symbol;
			console.log(`  ${name}: NOT in namedExports`);
			continue;
		}
		console.log(`  ${name}: targetFlags=0x${(exp.targetFlags >>> 0).toString(16)} hasValue=${!!(exp.targetFlags & ts.SymbolFlags.Value)}`);
	}
}

// Value-flag stats for compiler-dom
const cd = batch?.modules?.find(m => m.moduleFileName?.includes('compiler-dom'));
if (cd) {
	let withValue = 0;
	let noValue = 0;
	const noValueSample = [];
	for (const e of cd.namedExports) {
		if (e.targetFlags & ts.SymbolFlags.Value) withValue++;
		else {
			noValue++;
			if (noValueSample.length < 10) noValueSample.push(e.key);
		}
	}
	console.log(`\ncompiler-dom value stats: withValue=${withValue} noValue=${noValue}`);
	console.log('noValue sample:', noValueSample.join(', '));
}
