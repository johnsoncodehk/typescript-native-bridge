#!/usr/bin/env node
/**
 * Q3: classify auto-import delta patterns from name-table + full entry dump.
 *
 * Usage:
 *   node tools/triage-dedup-classify.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);
const pluginProbe = path.join(volarRoot, 'packages/language-server');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

async function fetchEntries(tsserverPath, env) {
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
		return comp?.body?.entries ?? [];
	});
}

function autoByName(entries) {
	const m = new Map();
	for (const e of entries) {
		if (!e.source) continue;
		if (!m.has(e.name)) m.set(e.name, []);
		m.get(e.name).push(e);
	}
	return m;
}

function nodeCoreBase(src) {
	if (!src) return null;
	const s = src.replace(/^node:/, '');
	return nodeCore.has(s) ? s : null;
}

const nodeCore = new Set([
	'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
	'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
	'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
	'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
	'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

const pkgOf = s => {
	if (!s || s.startsWith('.')) return null;
	const m = s.match(/^(@[^/]+\/[^/]+|[^./@][^/]*)/);
	return m ? m[1] : null;
};

function classifyName(name, tnbList, stockList) {
	const delta = tnbList.length - stockList.length;
	if (delta <= 0) return [];

	const tnbSources = new Set(tnbList.map(e => e.source));
	const stockSources = new Set(stockList.map(e => e.source));
	const assignments = [];
	let remaining = delta;

	// Stock offers no auto-import entries at all — TNB-only surplus (not a dedup miss).
	if (stockList.length === 0) {
		assignments.push({
			category: 'stock_absent_tnb_extra',
			delta: remaining,
			detail: `stock auto=0; tnb sources=[${[...tnbSources].slice(0, 5).join('|')}${tnbSources.size > 5 ? '|…' : ''}]`,
		});
		return assignments;
	}

	// node: vs bare dual keys — only count excess beyond what stock already keeps (≤1 per base).
	const dualBases = [];
	let dualDelta = 0;
	for (const s of tnbSources) {
		const base = nodeCoreBase(s);
		if (!base || dualBases.includes(base)) continue;
		if (tnbSources.has(base) && tnbSources.has(`node:${base}`)) {
			const stockDual = (stockSources.has(base) ? 1 : 0) + (stockSources.has(`node:${base}`) ? 1 : 0);
			const excess = Math.max(0, 2 - Math.max(stockDual, 1));
			if (excess > 0) {
				dualDelta += excess;
				dualBases.push(base);
			}
		}
	}
	if (dualDelta > 0) {
		assignments.push({ category: 'node_bare_dual_key', delta: dualDelta, detail: dualBases.join(',') });
		remaining -= dualDelta;
	}

	// same package different subpath
	const tnbPkgs = new Map();
	for (const s of tnbSources) {
		const p = pkgOf(s);
		if (p) tnbPkgs.set(p, (tnbPkgs.get(p) ?? 0) + 1);
	}
	const stockPkgs = new Map();
	for (const s of stockSources) {
		const p = pkgOf(s);
		if (p) stockPkgs.set(p, (stockPkgs.get(p) ?? 0) + 1);
	}
	for (const [pkg, tnbCnt] of tnbPkgs) {
		if (remaining <= 0) break;
		const stockCnt = stockPkgs.get(pkg) ?? 0;
		if (tnbCnt > 1 && tnbCnt > stockCnt) {
			const tnbSub = [...tnbSources].filter(s => s === pkg || s.startsWith(pkg + '/'));
			const stockSub = [...stockSources].filter(s => s === pkg || s.startsWith(pkg + '/'));
			const subDelta = tnbSub.length - stockSub.length;
			if (subDelta > 0) {
				const take = Math.min(subDelta, remaining);
				assignments.push({
					category: 'same_package_subpath',
					delta: take,
					detail: `${pkg}: tnb=[${tnbSub.join('|')}] stock=[${stockSub.join('|')}]`,
				});
				remaining -= take;
			}
		}
	}

	// exact duplicate source (same name+source twice in TNB)
	const tnbSourceCounts = new Map();
	for (const e of tnbList) tnbSourceCounts.set(e.source, (tnbSourceCounts.get(e.source) ?? 0) + 1);
	const dupSources = [...tnbSourceCounts.entries()].filter(([, c]) => c > 1);
	if (dupSources.length && remaining > 0) {
		const dupDelta = dupSources.reduce((a, [, c]) => a + c - 1, 0);
		const take = Math.min(dupDelta, remaining);
		assignments.push({
			category: 'exact_source_duplicate',
			delta: take,
			detail: dupSources.map(([s, c]) => `${s}x${c}`).join(','),
		});
		remaining -= take;
	}

	// re-export / relative: extra sources not in stock
	const extraSources = [...tnbSources].filter(s => !stockSources.has(s));
	if (extraSources.length && remaining > 0) {
		const take = Math.min(extraSources.length, remaining);
		assignments.push({ category: 'extra_source_reexport', delta: take, detail: extraSources.join('|') });
		remaining -= take;
	}

	if (remaining > 0) {
		assignments.push({
			category: 'other',
			delta: remaining,
			detail: `tnbSources=${[...tnbSources].join('|')} stockSources=${[...stockSources].join('|')}`,
		});
	}

	return assignments;
}

const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const tnb = await fetchEntries(tnbPath, tnbHarnessEnv());
const stock = await fetchEntries(stockPath, process.env);

const tnbMap = autoByName(tnb);
const stockMap = autoByName(stock);
const allNames = new Set([...tnbMap.keys(), ...stockMap.keys()]);

const categories = new Map();
const assignments = [];

for (const name of allNames) {
	const tnbList = tnbMap.get(name) ?? [];
	const stockList = stockMap.get(name) ?? [];
	if (tnbList.length === stockList.length) continue;
	for (const cls of classifyName(name, tnbList, stockList)) {
		assignments.push({ name, ...cls });
		categories.set(cls.category, (categories.get(cls.category) ?? 0) + cls.delta);
	}
}

const totalDelta = [...categories.values()].reduce((a, b) => a + b, 0);
const expectedDelta = tnb.filter(e => e.source).length - stock.filter(e => e.source).length;

console.log('expected auto delta:', expectedDelta);
console.log('classified sum:', totalDelta);
console.log('\ncategories:');
for (const [cat, cnt] of [...categories.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${cat}: ${cnt}`);
}

const outPath = '/tmp/tnb-dedup-diag-classify.txt';
const lines = [
	`expected auto delta: ${expectedDelta}`,
	`classified sum: ${totalDelta}`,
	'',
	'category | count',
	...[...categories.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} | ${n}`),
	'',
	'name | category | delta | detail',
	...assignments.sort((a, b) => b.delta - a.delta).map(a => `${a.name} | ${a.category} | ${a.delta} | ${a.detail}`),
];
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`\nwritten: ${outPath}`);
