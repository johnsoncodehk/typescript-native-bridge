#!/usr/bin/env node
/** List all tsgo batch modules + resolved specifiers for a fixture file. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const fixtureArg = process.argv[2] ?? 'empty.vue';
const volarRoot = resolveVolarRoot();
const require = createRequire(import.meta.url);
const ts = require(path.join(volarRoot, 'node_modules/typescript'));

const fixtures = {
	'empty.vue': path.join(volarRoot, 'test-workspace/tsconfigProject/empty.vue'),
	'css.ts': path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts'),
};
const targetFile = fixtures[fixtureArg] ?? fixtureArg;
const configPath = targetFile.includes('test-workspace')
	? path.join(volarRoot, 'test-workspace/tsconfigProject/tsconfig.json')
	: path.join(volarRoot, 'packages/language-service/tsconfig.json');
const cwd = path.dirname(configPath);

const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
	...ts.sys,
	getCurrentDirectory: () => cwd,
	onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.formatDiagnostic(d, {
		getCanonicalFileName: f => f,
		getCurrentDirectory: () => cwd,
		getNewLine: () => '\n',
	})); },
});

const rootNames = [...new Set([...parsed.fileNames, targetFile])];
const host = { ...ts.createCompilerHost(parsed.options, true), getCurrentDirectory: () => volarRoot };
const program = ts.createProgram({ rootNames, options: parsed.options, host });
const batch = program.getModuleExportMap?.(targetFile);
if (!batch) { console.log('no batch'); process.exit(0); }

const mods = batch.modules ?? [];
const symbols = mods.map(m => m.moduleSymbol);
const specBatch = program.getModuleSpecifiersBatch?.(targetFile, symbols, { includeCompletionsForModuleExports: true });
const specById = new Map();
for (const r of specBatch?.results ?? []) {
	specById.set(ts.getSymbolId(r.moduleSymbol), r.moduleSpecifiers?.[0]);
}

const rows = mods.map(m => ({
	moduleName: ts.unescapeLeadingUnderscores(m.moduleName),
	file: m.moduleFileName ? path.basename(m.moduleFileName) : 'ambient',
	named: m.namedExports?.length ?? 0,
	default: !!m.defaultExport,
	resolved: specById.get(ts.getSymbolId(m.moduleSymbol)) ?? null,
}));
rows.sort((a, b) => String(a.resolved ?? a.moduleName).localeCompare(String(b.resolved ?? b.moduleName)));

console.log('fixture:', targetFile);
console.log('batch modules:', rows.length);
for (const r of rows) {
	console.log(`${r.resolved ?? r.moduleName}\t named=${r.named}\t default=${r.default}\t ${r.file}`);
}

const blacklist = ['@vue/compiler-sfc', '@vue/reactivity', 'alien-signals'];
for (const pkg of blacklist) {
	const hit = rows.filter(r => (r.resolved ?? r.moduleName)?.includes?.(pkg) || String(r.moduleName).includes(pkg));
	const exp = hit.reduce((a, r) => a + r.named + (r.default ? 1 : 0), 0);
	console.log(`\nblacklist ${pkg}: modules=${hit.length} exports=${exp}`);
	for (const h of hit) console.log(' ', h.resolved ?? h.moduleName, 'exports', h.named + (h.default ? 1 : 0));
}

fs.writeFileSync(`/tmp/tnb-batch-modules-${path.basename(targetFile)}.json`, JSON.stringify(rows, null, 2));
