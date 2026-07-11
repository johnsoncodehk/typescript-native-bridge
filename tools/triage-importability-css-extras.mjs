#!/usr/bin/env node
/**
 * Q2-B: enumerate stock_absent_tnb_extra names with package.json visibility + stock reason.
 *
 * Usage: node tools/triage-importability-css-extras.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const pkgJsonPath = path.join(volarRoot, 'packages/language-service/package.json');
const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const require = createRequire(import.meta.url);
const tsPath = path.join(volarRoot, 'node_modules/typescript');
const ts = require(tsPath);

function allDeclaredDeps(pj) {
	const out = new Set();
	for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
		for (const name of Object.keys(pj[field] ?? {})) out.add(name);
	}
	return out;
}

const declared = allDeclaredDeps(pkgJson);

function pkgOf(source) {
	if (!source || source.startsWith('.')) return null;
	const m = String(source).match(/^(@[^/]+\/[^/]+|[^./@][^/]*)/);
	return m ? m[1] : null;
}

function isDeclared(source) {
	const p = pkgOf(source);
	if (!p) return 'n/a';
	if (declared.has(p)) return 'yes';
	// @types/foo counts for foo
	if (declared.has(`@types/${p}`)) return 'yes(@types)';
	return 'no';
}

async function fetchAutoEntries(tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
			},
		});
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }],
		});
		const comp = await send('completionInfo', {
			file: testFile,
			line,
			offset: col,
			includeExternalModuleExports: true,
			includeInsertTextCompletions: true,
		});
		return (comp?.body?.entries ?? []).filter(e => e.source);
	});
}

function stockReason(name, source, inPkgJson) {
	const p = pkgOf(source);
	if (!p) return 'relative/unknown source';
	if (inPkgJson === 'yes' || inPkgJson.startsWith('yes')) {
		return 'declared dep — stock should offer (verify reverse check)';
	}
	if (p === 'process' || source === 'node:process') {
		return 'process: stock filters via packageJsonFilter + node-core rules at completion (isImportable)';
	}
	if (name.startsWith('create') || name === 'createBlock' || name === 'createCommentVNode') {
		return 'create*: from @vue/compiler-dom (transitive via devDep chain) — stock blocks at completion via packageJsonFilter.getSourceFileInfo';
	}
	return `transitive-only package ${p} not in visible package.json — stock blocks at completion via packageJsonFilter`;
}

const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const tnb = await fetchAutoEntries(tnbPath, tnbHarnessEnv());
const stock = await fetchAutoEntries(stockPath, process.env);

const tnbByName = new Map();
for (const e of tnb) {
	if (!tnbByName.has(e.name)) tnbByName.set(e.name, []);
	tnbByName.get(e.name).push(e);
}
const stockByName = new Map();
for (const e of stock) {
	if (!stockByName.has(e.name)) stockByName.set(e.name, []);
	stockByName.get(e.name).push(e);
}

const extras = [];
for (const [name, tnbList] of tnbByName) {
	const stockList = stockByName.get(name) ?? [];
	if (stockList.length > 0) continue;
	for (const e of tnbList) {
		const inPkg = isDeclared(e.source);
		extras.push({
			name,
			source: e.source,
			inPackageJson: inPkg,
			stockReason: stockReason(name, e.source, inPkg),
		});
	}
}

extras.sort((a, b) => a.name.localeCompare(b.name) || String(a.source).localeCompare(String(b.source)));

console.log('stock_absent_tnb_extra count:', extras.length);
console.log('create*:', extras.filter(e => e.name.startsWith('create')).length);
console.log('process*:', extras.filter(e => e.source?.includes('process')).length);
console.log('\nname | source | in package.json | stock reason');
for (const row of extras) {
	console.log(`${row.name} | ${row.source} | ${row.inPackageJson} | ${row.stockReason}`);
}

// Find declaration file for create* sample
const createSample = extras.find(e => e.name.startsWith('create'));
if (createSample) {
	const parsed = ts.getParsedCommandLineOfConfigFile(
		path.join(volarRoot, 'packages/language-service/tsconfig.json'),
		{},
		{
			...ts.sys,
			getCurrentDirectory: () => volarRoot,
			onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, {
				getCanonicalFileName: f => f,
				getCurrentDirectory: () => volarRoot,
				getNewLine: () => '\n',
			})); },
		},
	);
	const rootNames = [...new Set([...parsed.fileNames, testFile])];
	const program = ts.createProgram({ rootNames, options: parsed.options });
	const checker = program.getTypeChecker();
	for (const sf of program.getSourceFiles()) {
		if (!sf.fileName.includes('@vue') || !sf.fileName.includes('compiler-dom')) continue;
		if (!sf.symbol) continue;
		const mod = checker.getMergedSymbol(sf.symbol);
		checker.forEachExportAndPropertyOfModule(mod, (sym, key) => {
			if (String(key) === createSample.name) {
				const decl = sym.declarations?.[0];
				console.log(`\ncreate* decl sample: ${createSample.name} in ${decl?.getSourceFile?.()?.fileName}:${decl?.getStart?.()}`);
			}
		});
	}
}

const outPath = '/tmp/tnb-importability-css-extras.txt';
const lines = [
	`count: ${extras.length}`,
	'',
	'package.json dependencies/devDependencies:',
	JSON.stringify({ dependencies: pkgJson.dependencies, devDependencies: pkgJson.devDependencies }, null, 2),
	'',
	'name | source | in package.json | stock reason',
	...extras.map(r => `${r.name} | ${r.source} | ${r.inPackageJson} | ${r.stockReason}`),
];
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log('\nwritten:', outPath);
