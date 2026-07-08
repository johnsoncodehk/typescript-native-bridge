#!/usr/bin/env node
/**
 * Trace export map building for vue module in tsserver project context.
 * cd volar/vue && GODEBUG=asyncpreemptoff=1 node path/to/triage-export-map-trace.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const volarRoot = resolveVolarRoot();
const tsPath = path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);
const { forEachExternalModuleToImportFrom } = require(path.join(tsPath, 'lib/typescript.js'));

const harnessEntry = path.join(
	volarRoot,
	'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
);
const { launchServer } = await import(pathToFileURL(harnessEntry).href);

const testWorkspacePath = path.resolve(volarRoot, 'test-workspace');
const tsserverPath = path.join(tsPath, 'lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const logFile = path.join(os.tmpdir(), `tnb-export-trace-${Date.now()}.log`);

const emptyVue = path.join(testWorkspacePath, 'tsconfigProject/empty.vue');
const content = `<template>< /></template>`;

const tsserver = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--logVerbosity', 'verbose',
	'--logFile', logFile,
]);

let seq = 1;
const send = (command, args) => tsserver.message({ seq: seq++, type: 'request', command, arguments: args });

await send('configure', {
	preferences: {
		includeCompletionsForModuleExports: true,
		includeCompletionsWithInsertText: true,
	},
});

await send('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [{ file: emptyVue, fileContent: content }],
});

await new Promise(r => setTimeout(r, 2500));

await send('completions', { file: emptyVue, position: 0 });

const log = fs.readFileSync(logFile, 'utf8');
const fileLines = log.split('\n').filter(l => /Adding root file|Finished\. Found \d+ files/i.test(l));
console.log('--- project files (from log) ---');
for (const l of fileLines.slice(-30)) console.log(l.trim());

// Build program with same tsconfig + empty.vue
const testWorkspace = path.join(testWorkspacePath, 'tsconfigProject');
const configPath = path.join(testWorkspace, 'tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(
	configPath,
	{},
	{
		...ts.sys,
		getCurrentDirectory: () => testWorkspace,
		onUnRecoverableConfigFileDiagnostic: d => {
			throw new Error(ts.formatDiagnostic(d, {
				getCanonicalFileName: f => f,
				getCurrentDirectory: () => testWorkspace,
				getNewLine: () => '\n',
			}));
		},
	},
);

const rootNames = [...new Set([...parsed.fileNames, emptyVue])];
const program = ts.createProgram({ rootNames, options: parsed.options, projectReferences: parsed.projectReferences });
const checker = program.getTypeChecker();

function analyzeModule(moduleSymbol, moduleFile) {
	let total = 0;
	let importable = 0;
	let unknown = 0;
	let undefinedSym = 0;
	const keys = [];
	checker.forEachExportAndPropertyOfModule(moduleSymbol, (sym, key) => {
		total++;
		keys.push(key);
		const isUnknown = checker.isUnknownSymbol(sym);
		const isUndef = checker.isUndefinedSymbol(sym);
		if (isUnknown) unknown++;
		if (isUndef) undefinedSym++;
		if (!isUndef && !isUnknown) importable++;
	});
	keys.sort();
	return {
		file: moduleFile?.fileName ?? moduleSymbol?.name,
		total,
		importable,
		unknown,
		undefinedSym,
		hasFragment: keys.includes('Fragment'),
		hasFixture: keys.includes('Fixture'),
		hasDefineComponent: keys.includes('defineComponent'),
		lastKeys: keys.filter(k => k >= 'ErrorCodes').slice(0, 15),
	};
}

const vueResults = [];
forEachExternalModuleToImportFrom(
	program,
	{
		...ts.sys,
		getCurrentDirectory: () => testWorkspace,
		useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
		getCompilationSettings: () => parsed.options,
		getScriptFileNames: () => rootNames,
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
	},
	{ includeCompletionsForModuleExports: true },
	true,
	(moduleSymbol, moduleFile) => {
		const f = moduleFile?.fileName ?? '';
		if (f.includes('/vue/') || f.includes('runtime-dom') || f.includes('runtime-core')) {
			vueResults.push(analyzeModule(moduleSymbol, moduleFile));
		}
	},
);

console.log('\ntypescript:', fs.realpathSync(tsPath).includes('typescript-native-bridge') ? 'TNB' : 'stock');
console.log('program files:', program.getSourceFiles().length);
console.log('--- vue-related modules in export map iteration ---');
for (const r of vueResults) {
	console.log(JSON.stringify(r));
}

// Direct vue import probe
const probeFile = path.join(testWorkspace, 'fixture.ts');
if (fs.existsSync(probeFile)) {
	const probeSf = program.getSourceFile(probeFile);
	if (probeSf) {
		for (const st of probeSf.statements) {
			if (st.kind === ts.SyntaxKind.ImportDeclaration && st.moduleSpecifier?.text === 'vue') {
				const sym = checker.getSymbolAtLocation(st.moduleSpecifier);
				if (sym) {
					console.log('\n--- direct import vue ---');
					console.log(JSON.stringify(analyzeModule(sym, undefined)));
				}
			}
		}
	}
}

tsserver.kill?.();
