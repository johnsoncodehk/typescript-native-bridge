#!/usr/bin/env node
/** Debug getExportsOfModule('vue') — pass TYPESCRIPT_PATH or use volar linked install. */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const volarRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../volar/vue');
const tsPath = process.env.TYPESCRIPT_PATH ?? path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);

const testWorkspace = path.join(volarRoot, 'test-workspace/tsconfigProject');
const configPath = path.join(testWorkspace, 'tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(
	configPath,
	{},
	{
		...ts.sys,
		getCurrentDirectory: () => testWorkspace,
		onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, { getCanonicalFileName: f => f, getCurrentDirectory: () => testWorkspace, getNewLine: () => '\n' })); },
	},
);

const program = ts.createProgram({
	rootNames: parsed.fileNames,
	options: parsed.options,
	projectReferences: parsed.projectReferences,
});
const checker = program.getTypeChecker();

const vuePath = require.resolve('vue', { paths: [path.join(volarRoot, 'test-workspace')] });
const vueSf = program.getSourceFile(vuePath);
console.log('typescript:', tsPath);
console.log('vue file:', vuePath, !!vueSf);
if (!vueSf) process.exit(1);

const modSym = checker.getSymbolAtLocation(vueSf);
console.log('module symbol:', modSym?.name, 'has exports:', !!modSym?.exports);

const names = [];
checker.forEachExportAndPropertyOfModule(modSym, (_s, k) => names.push(k));
console.log('forEachExport count:', names.length);
console.log('sample:', names.filter(n => ['defineComponent', 'h', 'ref', 'compile'].includes(n)));

const exports = checker.getExportsOfModule(modSym);
console.log('getExportsOfModule count:', exports?.length ?? 0);
