#!/usr/bin/env node
/**
 * Witness: program-layer info APIs on tsgo-backed thin programs — stock
 * differential (the TnbProgramCoverage audit; every entry reclassified from
 * "stub" to "adapter" here).
 *
 * One self-contained fixture is loaded twice — stock 6.0.3 and the TNB fork —
 * and the program-info surfaces are compared field by field:
 *
 *   getMissingFilePaths        watch bookkeeping (updateMissingFilePathsWatch)
 *   getFileIncludeReasons      tsc --explainFiles / FAR non-module refs
 *   explainFiles (end-to-end)  the stock consumer, reason lines byte-equal
 *   resolvedModules / resolvedTypeReferenceDirectiveNames (lazily materialized
 *                              from the Go resolution batch; tsgo does not
 *                              track failedLookupLocations, so only
 *                              resolvedModule identity is compared)
 *   getAutomaticTypeDirectiveNames / Resolutions
 *   usesUriStyleNodeCoreModules
 *   getClassifiableNames       v1 classifier pre-filter (fixture names)
 *   isEmittedFile              outDir/outFile/membership logic
 *   getSourceFileFromReference / getLibFileFromReference
 *   counter delegation         program.getXCount() === checker.getXCount()
 *                              (TNB counters are checker-owned zeros by
 *                              design — the delegation, not the value)
 *   getBuildInfo               undefined on a base program (builder installs)
 *
 * Lib files are excluded from every comparison: TNB's bundled libs track the
 * fork (post-6.0.3) while stock is 6.0.3 (lib-delta class L of
 * triage-checker-differential).
 *
 * Exit 0: every compared surface matches stock. Exit 1: divergence.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tnbTsPath = path.join(repoRoot, 'lib', 'typescript.js');
const stockTsPath = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH ? path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js') : undefined)
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';

const FIXTURE = {
	'tsconfig.json': JSON.stringify({
		compilerOptions: {
			strict: true,
			target: 'es2022',
			module: 'nodenext',
			moduleResolution: 'nodenext',
			outDir: 'dist',
			types: ['fake-types'],
			skipLibCheck: true,
		},
		include: ['src'],
	}, null, 2),
	'src/a.ts': [
		'/// <reference path="./shared.ts" />',
		'/// <reference types="fake-types" />',
		'/// <reference lib="es2020" />',
		'import { bValue } from "./b.js";',
		'import "node:fs";',
		'export class FakeClass { v: string = bValue; }',
		'export interface FakeIface { x: number; }',
		'export type FakeAlias = string | number;',
		'export enum FakeEnum { A, B }',
		'',
	].join('\n'),
	'src/b.ts': [
		'import * as path from "path";',
		'import { sharedValue } from "./shared.js";',
		'export const bValue: string = sharedValue;',
		'',
	].join('\n'),
	'src/shared.ts': 'export const sharedValue: string = "s";\n',
	'src/broken.ts': '/// <reference path="./does-not-exist.ts" />\nexport const z: number = 1;\n',
	'node_modules/@types/fake-types/package.json': JSON.stringify({
		name: '@types/fake-types',
		version: '1.0.0',
		types: 'index.d.ts',
	}, null, 2),
	'node_modules/@types/fake-types/index.d.ts': 'declare const fake: number;\nexport = fake;\n',
};

const REASON_LINE = /^(Root file specified|Part of 'files' list|Matched by (include pattern|default include pattern)|Imported via|Referenced via|Type library referenced via|Library referenced via|Entry point (of type library|for implicit type library)|Library '.*' specified in compilerOptions)/;
const LIB_FILE_LINE = /\/lib\.[^/]*\.d\.ts$/;

function writeFixture(dir) {
	for (const [rel, content] of Object.entries(FIXTURE)) {
		const f = path.join(dir, rel);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, content);
	}
}

function childMain() {
	const side = process.env.TNB_PROBE_SIDE;
	const dir = process.env.TNB_PROBE_DIR;
	const ts = require(side === 'tnb' ? tnbTsPath : stockTsPath);
	const rel = p => path.relative(dir, p).replace(/\\/g, '/');

	const configPath = path.join(dir, 'tsconfig.json');
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) throw new Error('readConfigFile failed');
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir, undefined, configPath);
	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options,
		host: ts.createCompilerHost(parsed.options),
	});
	const checker = program.getTypeChecker();

	const out = {};

	// ── getMissingFilePaths ──
	out.missingFilePaths = [...program.getMissingFilePaths().values()].map(rel).sort();

	// ── getFileIncludeReasons (workspace files only) ──
	const isWorkspaceFile = p => !/node_modules[\\/]/.test(p) && !LIB_FILE_LINE.test(p);
	const reasons = {};
	for (const sf of program.getSourceFiles()) {
		if (!isWorkspaceFile(sf.fileName)) continue;
		const rs = program.getFileIncludeReasons().get(sf.path) ?? [];
		reasons[rel(sf.fileName)] = rs.map(r => ({
			kind: r.kind,
			index: r.index,
			file: r.file ? rel(r.file) : undefined,
			typeReference: r.typeReference,
		}));
	}
	out.fileIncludeReasons = reasons;

	// ── explainFiles end-to-end (reason lines only; implied-format lines read
	// light-stub module state on TNB — out of scope for this witness) ──
	const explainLines = [];
	ts.explainFiles(program, s => explainLines.push(s));
	const sections = [];
	let current = undefined;
	for (const line of explainLines) {
		if (!line.startsWith('  ')) {
			current = LIB_FILE_LINE.test(line) ? undefined : { file: line, reasons: [] };
			if (current) sections.push(current);
			continue;
		}
		const trimmed = line.trim();
		if (current && REASON_LINE.test(trimmed)) current.reasons.push(trimmed);
	}
	out.explainFiles = sections.map(s => ({ file: s.file, reasons: s.reasons }));

	// ── resolvedModules / resolvedTypeReferenceDirectiveNames ──
	const canonResolutions = map => {
		const perFile = {};
		map?.forEach((cache, filePath) => {
			const entries = [];
			cache.forEach((resolution, name, mode) => {
				const rm = resolution.resolvedModule ?? resolution.resolvedTypeReferenceDirective;
				entries.push([name, mode ?? 0, rm ? rel(rm.resolvedFileName) : null]);
			});
			entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
			const hostFile = rel(filePath);
			if (isWorkspaceFile(hostFile) && !/node_modules/.test(hostFile)) perFile[hostFile] = entries;
		});
		return perFile;
	};
	out.resolvedModules = canonResolutions(program.resolvedModules);
	out.resolvedTypeReferenceDirectiveNames = canonResolutions(program.resolvedTypeReferenceDirectiveNames);

	// ── automatic type directives ──
	out.automaticTypeDirectiveNames = [...program.getAutomaticTypeDirectiveNames()].sort();
	const auto = program.getAutomaticTypeDirectiveResolutions();
	const autoEntries = [];
	auto?.forEach((resolution, name, mode) => {
		autoEntries.push([name, mode ?? 0, resolution.resolvedTypeReferenceDirective ? rel(resolution.resolvedTypeReferenceDirective.resolvedFileName) : null]);
	});
	out.automaticTypeDirectiveResolutions = autoEntries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

	// ── usesUriStyleNodeCoreModules ──
	out.usesUriStyleNodeCoreModules = program.usesUriStyleNodeCoreModules ?? null;

	// ── getClassifiableNames (fixture-declared names) ──
	const classifiable = program.getClassifiableNames();
	out.classifiableNames = ['FakeClass', 'FakeIface', 'FakeAlias', 'FakeEnum'].map(n => classifiable.has(n));

	// ── isEmittedFile ──
	out.isEmittedFile = [
		'dist/a.js',
		'dist/a.d.ts',
		'dist/nope.js',
		'src/a.ts',
		'other/x.ts',
	].map(f => program.isEmittedFile(path.join(dir, f)));

	// ── getSourceFileFromReference / getLibFileFromReference ──
	const aSf = program.getSourceFile(path.join(dir, 'src/a.ts'));
	out.sourceFileFromReference = [
		rel(program.getSourceFileFromReference(aSf, { fileName: './shared.ts' })?.fileName ?? '<undefined>'),
		program.getSourceFileFromReference(aSf, { fileName: './nope.ts' }) === undefined,
	];
	out.libFileFromReference = path.basename(program.getLibFileFromReference({ fileName: 'es2020' })?.fileName ?? '<undefined>');

	// ── counter delegation (identity, not value) + getBuildInfo ──
	out.counterDelegation = [
		program.getNodeCount() === checker.getNodeCount(),
		program.getIdentifierCount() === checker.getIdentifierCount(),
		program.getSymbolCount() === checker.getSymbolCount(),
		program.getTypeCount() === checker.getTypeCount(),
		program.getInstantiationCount() === checker.getInstantiationCount(),
		JSON.stringify(program.getRelationCacheSizes()) === JSON.stringify(checker.getRelationCacheSizes()),
	];
	out.getBuildInfoIsUndefined = program.getBuildInfo?.() === undefined;

	console.log(JSON.stringify(out));
}

function runChild(side, dir) {
	const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
		env: { ...process.env, TNB_PROBE_SIDE: side, TNB_PROBE_DIR: dir },
		encoding: 'utf8',
		timeout: 300_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (res.status !== 0) {
		console.error(`child ${side} FAILED (status ${res.status})\n${res.stderr?.slice(-3000) ?? ''}\n${res.stdout?.slice(-2000) ?? ''}`);
		process.exit(1);
	}
	return JSON.parse(res.stdout.trim().split('\n').at(-1));
}

function parentMain() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-program-info-'));
	writeFixture(dir);
	const stock = runChild('stock', dir);
	const tnb = runChild('tnb', dir);

	const stable = v => JSON.stringify(v, (k, x) => {
		if (x && typeof x === 'object' && !Array.isArray(x)) return Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)));
		return x;
	});
	let failures = 0;
	for (const key of Object.keys(stock)) {
		const a = stable(stock[key]);
		const b = stable(tnb[key]);
		if (a !== b) {
			failures++;
			console.error(`DIVERGENCE ${key}:\n  stock: ${a}\n  tnb:   ${b}`);
		}
		else {
			console.log(`ok ${key}`);
		}
	}
	if (failures) {
		console.error(`\n${failures} divergence(s)`);
		process.exit(1);
	}
	console.log('\ntriage-program-info: all program-info surfaces match stock');
}

if (process.env.TNB_PROBE_SIDE) childMain();
else parentMain();
