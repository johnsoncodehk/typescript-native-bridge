#!/usr/bin/env node
/**
 * Simulate exportInfoMap isImportableSymbol filtering for vue module in project context.
 * GODEBUG=asyncpreemptoff=1 node tools/triage-export-map-filter.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const tsPath = process.env.TYPESCRIPT_PATH
	?? path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);

const testWorkspace = path.join(volarRoot, 'test-workspace/tsconfigProject');
const configPath = path.join(testWorkspace, 'tsconfig.json');
const emptyVue = path.join(testWorkspace, 'empty.vue');
const fixtureTs = path.join(testWorkspace, 'fixture.ts');
const fixtureVue = path.join(testWorkspace, 'fixture.vue');

fs.writeFileSync(emptyVue, `<template>< /></template>`);
if (!fs.existsSync(fixtureTs)) fs.writeFileSync(fixtureTs, 'export function foo() {}');
if (!fs.existsSync(fixtureVue)) fs.writeFileSync(fixtureVue, `<script setup lang="ts"></script>\n<template></template>`);

const parsed = ts.getParsedCommandLineOfConfigFile(
	configPath,
	{},
	{
		...ts.sys,
		getCurrentDirectory: () => testWorkspace,
		onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, {
			getCanonicalFileName: f => f,
			getCurrentDirectory: () => testWorkspace,
			getNewLine: () => '\n',
		})); },
	},
);

// Match tsserver: open empty.vue pulls fixture.ts/vue + vue deps
const rootNames = [...new Set([...parsed.fileNames, emptyVue, fixtureVue])];

const program = ts.createProgram({
	rootNames,
	options: parsed.options,
	projectReferences: parsed.projectReferences,
});
const checker = program.getTypeChecker();

function analyzeModule(sf) {
	if (!sf?.symbol) return null;
	const mod = checker.getMergedSymbol(sf.symbol);
	let total = 0;
	let importable = 0;
	let unknown = 0;
	let undefinedSym = 0;
	const samples = { unknown: [], importable: [] };
	checker.forEachExportAndPropertyOfModule(mod, (sym, key) => {
		total++;
		const isUnknown = checker.isUnknownSymbol(sym);
		const isUndef = checker.isUndefinedSymbol(sym);
		if (isUnknown) {
			unknown++;
			if (samples.unknown.length < 5) samples.unknown.push(key);
		}
		if (isUndef) undefinedSym++;
		const ok = !isUndef && !isUnknown && !checker.isKnownSymbol?.(sym);
		if (ok) {
			importable++;
			if (samples.importable.length < 5) samples.importable.push(key);
		}
	});
	return { file: sf.fileName, total, importable, unknown, undefinedSym, samples };
}

const externalModules = program.getSourceFiles()
	.filter(sf => ts.isExternalModule(sf) && sf.fileName.includes('node_modules'))
	.map(sf => analyzeModule(sf))
	.filter(Boolean);

const vueModules = externalModules.filter(r => r.file.includes('/vue/') || r.file.includes('runtime-dom'));
const topByTotal = [...externalModules].sort((a, b) => b.total - a.total).slice(0, 8);

console.log('typescript:', tsPath.includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('program files:', program.getSourceFiles().length);
console.log('external module count:', externalModules.length);
console.log('--- vue-related modules ---');
for (const r of vueModules) {
	console.log(JSON.stringify(r, null, 2));
}
console.log('--- top modules by export count ---');
for (const r of topByTotal) {
	console.log(`${path.basename(r.file)}: total=${r.total} importable=${r.importable} unknown=${r.unknown}`);
}
