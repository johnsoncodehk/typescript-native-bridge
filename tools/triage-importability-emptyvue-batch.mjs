#!/usr/bin/env node
/**
 * Q2-A: dump batch populate module specifiers for empty.vue (volar template auto-import).
 * Parses tsserver verbose log for batchPopulateDiag JSON.
 *
 * Usage: node tools/triage-importability-emptyvue-batch.mjs [--stock]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const useStock = process.argv.includes('--stock');
const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const tsserverPath = useStock ? stockPath : tnbPath;
const logFile = useStock ? '/tmp/tnb-importability-emptyvue-stock.log' : '/tmp/tnb-importability-emptyvue-tnb.log';
const outFile = useStock ? '/tmp/tnb-importability-emptyvue-stock.json' : '/tmp/tnb-importability-emptyvue-tnb.json';

const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const emptyVue = path.join(testWorkspacePath, 'tsconfigProject/empty.vue');
const fileContent = `<template><| /></template>`;
const cursorOffset = fileContent.indexOf('|');
const content = fileContent.replace('|', '');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
	'--logVerbosity', 'verbose',
	'--logFile', logFile,
];

function offsetToLineCol(text, offset) {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset; i++) {
		if (text[i] === '\n') { line++; col = 1; } else { col++; }
	}
	return { line, offset: col };
}

function pkgRoot(spec) {
	const m = String(spec).match(/^(@[^/]+\/[^/]+|[^./@][^/]*)/);
	return m ? m[1] : spec;
}

const BLACKLIST = ['@vue/compiler-sfc', '@vue/reactivity', 'alien-signals'];

function parseBatchDiag(log) {
	const line = log.split('\n').find(l => l.includes('batchPopulateDiag:'));
	if (!line) return null;
	const json = line.slice(line.indexOf('batchPopulateDiag:') + 'batchPopulateDiag:'.length).trim();
	return JSON.parse(json);
}

function summarize(diag, label) {
	const byPkg = new Map();
	for (const row of diag ?? []) {
		const root = pkgRoot(row.specifier);
		if (!byPkg.has(root)) byPkg.set(root, { accepted: 0, blocked: 0, exports: 0, specifiers: new Set(), blockedReasons: new Map() });
		const e = byPkg.get(root);
		e.specifiers.add(row.specifier);
		const expCount = row.named + (row.default ? 1 : 0);
		if (row.blocked) {
			e.blocked += 1;
			e.exports += expCount;
			e.blockedReasons.set(row.blocked, (e.blockedReasons.get(row.blocked) ?? 0) + expCount);
		} else {
			e.accepted += 1;
			e.exports += expCount;
		}
	}
	console.log(`\n=== ${label} batch populate summary ===`);
	console.log('total specifiers seen:', diag?.length ?? 0);
	for (const pkg of BLACKLIST) {
		const e = byPkg.get(pkg);
		const exp = e?.blockedReasons.get('transitiveOnlyBlacklist') ?? 0;
		console.log(`blacklist ${pkg}: blocked exports=${exp} specifiers=${e ? [...e.specifiers].join('|') : 'none'}`);
	}
	const transitiveBlocked = [...byPkg.entries()]
		.filter(([p, e]) => e.blockedReasons.get('transitiveOnlyBlacklist') && !BLACKLIST.includes(p));
	console.log('other transitiveOnlyBlacklist pkgs:', transitiveBlocked.map(([p, e]) => `${p}(${e.blockedReasons.get('transitiveOnlyBlacklist')})`).join(', ') || 'none');
	return { byPkg, diag };
}

async function completionSources(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs.filter(a => a !== '--logFile' && a !== logFile && a !== 'verbose' && a !== '--logVerbosity'), env }, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
			},
		});
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: emptyVue, fileContent: content, projectRootPath: testWorkspacePath }],
		});
		const comp0 = await send('completions', { file: emptyVue, position: 0 });
		const entries0 = Array.isArray(comp0?.body) ? comp0.body : comp0?.body?.entries ?? [];
		const auto = entries0.filter(e => e.source);
		const bySource = new Map();
		for (const e of auto) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
		return { auto: auto.length, bySource: Object.fromEntries(bySource) };
	});
}

console.log('label:', useStock ? 'STOCK' : 'TNB');
console.log('tsserver:', tsserverPath);
console.log('fixture:', emptyVue);

try { fs.rmSync(logFile, { force: true }); } catch { /* ignore */ }

await withTsserver({
	tsserverPath,
	args: harnessArgs,
	env: useStock ? process.env : tnbHarnessEnv(),
	onEvent: ev => {
		if (ev?.event === 'log' && ev.body?.message?.includes('batchPopulateDiag')) {
			fs.appendFileSync('/tmp/tnb-importability-emptyvue-events.log', ev.body.message + '\n');
		}
	},
}, async ({ send }) => {
	await send('configure', {
		preferences: {
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
		},
	});
	await send('updateOpen', {
		changedFiles: [],
		closedFiles: [],
		openFiles: [{ file: emptyVue, fileContent: content, projectRootPath: testWorkspacePath }],
	});
	// Trigger export map populate via completions@0 (vue template auto-import path)
	await send('completions', { file: emptyVue, position: 0 });
	const pos = offsetToLineCol(content, cursorOffset);
	await send('completionInfo', {
		file: emptyVue,
		line: pos.line,
		offset: pos.offset,
		includeExternalModuleExports: true,
		includeInsertTextCompletions: true,
	});
});

let diag = null;
if (fs.existsSync(logFile)) {
	const log = fs.readFileSync(logFile, 'utf8');
	diag = parseBatchDiag(log);
}
if (!diag) {
	const evLog = '/tmp/tnb-importability-emptyvue-events.log';
	if (fs.existsSync(evLog)) {
		const log = fs.readFileSync(evLog, 'utf8');
		diag = parseBatchDiag(log);
	}
}

if (!diag && !useStock) {
	console.error('WARN: batchPopulateDiag not found in log — rebuild tsserver after temp diag patch');
} else if (!diag && useStock) {
	console.log('STOCK has no batchPopulateDiag (expected — stock uses checker walk, not tsgo batch)');
}

const summary = summarize(diag, useStock ? 'STOCK' : 'TNB');
fs.writeFileSync(outFile, JSON.stringify({ diag, summary: { byPkg: [...summary.byPkg.entries()] } }, null, 2));
console.log('written:', outFile);

if (!useStock) {
	const stockAuto = await completionSources('STOCK', stockPath, process.env);
	const tnbAuto = await completionSources('TNB', tnbPath, tnbHarnessEnv());
	const stockSources = new Set(Object.keys(stockAuto.bySource));
	const tnbSources = new Set(Object.keys(tnbAuto.bySource));
	const onlyTnb = [...tnbSources].filter(s => !stockSources.has(s));
	const onlyStock = [...stockSources].filter(s => !tnbSources.has(s));
	console.log('\n=== completion source diff (completions@0) ===');
	console.log('TNB auto:', tnbAuto.auto, 'STOCK auto:', stockAuto.auto);
	console.log('onlyTnb sources:', onlyTnb.length, onlyTnb.slice(0, 20).join(', '));
	console.log('onlyStock sources:', onlyStock.length, onlyStock.slice(0, 20).join(', '));
}
