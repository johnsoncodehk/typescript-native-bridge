#!/usr/bin/env node
/**
 * Check isImportable path for vue exports from empty.vue context.
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

const rootNames = [...new Set([...parsed.fileNames, emptyVue, fixtureVue])];
const program = ts.createProgram({ rootNames, options: parsed.options, projectReferences: parsed.projectReferences });
const checker = program.getTypeChecker();
const importingFile = program.getSourceFile(emptyVue);

const vueFile = program.getSourceFiles().find(sf => sf.fileName.includes('vue.d.mts') || sf.fileName.endsWith('/vue/index.d.mts'));
console.log('typescript:', tsPath.includes('typescript-native-bridge') || require.resolve('typescript/package.json').includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('importing:', importingFile?.fileName);
console.log('vue file:', vueFile?.fileName);
console.log('vue file.symbol:', !!vueFile?.symbol);

const getMod = checker.getModuleSymbolForSourceFile?.bind(checker) ?? ((sf) => sf.symbol && checker.getMergedSymbol(sf.symbol));
const moduleSymbol = vueFile ? getMod(vueFile) : undefined;
console.log('moduleSymbol:', moduleSymbol?.name, 'flags:', moduleSymbol?.flags?.toString(16));
console.log('moduleSymbol.valueDeclaration kind:', moduleSymbol?.valueDeclaration?.kind, 'file:', moduleSymbol?.valueDeclaration?.getSourceFile?.()?.fileName);
console.log('moduleSymbol.declarations?.[0] file:', moduleSymbol?.declarations?.[0]?.getSourceFile?.()?.fileName);

const exportInfoMap = ts.ExportInfoMap?.getExportInfoMap?.(importingFile, {
	getCompilationSettings: () => parsed.options,
	getCurrentDirectory: () => testWorkspace,
	getScriptFileNames: () => rootNames,
	getProjectVersion: () => '1',
	fileExists: ts.sys.fileExists,
	readFile: ts.sys.readFile,
	getCanonicalFileName: f => f,
	useCaseSensitiveFileNames: () => true,
}, program, { includeCompletionsForModuleExports: true }, undefined);

if (!exportInfoMap) {
	// internal API - use services through createLanguageService
	const { createLanguageService } = require(path.join(tsPath.replace(/package\.json$/, ''), 'lib/typescript.js'));
	const host = {
		getCompilationSettings: () => parsed.options,
		getCurrentDirectory: () => testWorkspace,
		getScriptFileNames: () => rootNames,
		getProjectVersion: () => '1',
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		getCanonicalFileName: f => f,
		useCaseSensitiveFileNames: () => true,
		getScriptVersion: () => '1',
		getScriptSnapshot: f => {
			const content = ts.sys.readFile(f);
			return content ? ts.ScriptSnapshot.fromString(content) : undefined;
		},
	};
	const ls = createLanguageService(host);
	const info = ls.getCompletionsAtPosition(emptyVue, 0, { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true });
	const sort16 = (info?.entries ?? []).filter(e => e.sortText === '16');
	console.log('completions@0 sortText16:', sort16.length);
	console.log('sample:', sort16.slice(0, 5).map(e => ({ name: e.name, source: e.source })));
	process.exit(0);
}
