#!/usr/bin/env node
/**
 * T2 witness f2r6-libref: references on lib-declared globals — TNB misses the
 * lib .d.ts declaration entries (dominant T2 sub-cluster, 531/696 visible).
 * Case A: pure .ts degradation (console). Case B: sim-nav key tsc/#2225/main.vue:3:3.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const gate = new Map();

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const tw = path.join(volarRoot, 'test-workspace');

const fix = '/tmp/tnb-f2r6-fixture';
fs.mkdirSync(fix, { recursive: true });
const tsFile = path.join(fix, 'main.ts');
fs.writeFileSync(tsFile, `console.log(1);\nconsole.log(2);\n`);
const vueFile = path.join(tw, 'tsc/#2225/main.vue');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

function norm(k) {
	const [f, l, o] = String(k).split('|');
	let file = f || '';
	const i = file.indexOf('/test-workspace/');
	if (i >= 0) file = 'TW:' + file.slice(i + '/test-workspace/'.length);
	else if (file.includes('/node_modules/')) {
		const j = file.lastIndexOf('/node_modules/');
		file = 'NM:' + file.slice(j + '/node_modules/'.length).replace(/^\.pnpm\/[^/]+\/node_modules\//, '');
	} else file = 'ABS:' + file.split('/').slice(-2).join('/');
	return `${file}|${l}|${o}`;
}

async function run(label, tsserverPath, env, openFiles, query) {
	return withTsserver({ tsserverPath, args: harnessArgs, env, deadlineMs: 120_000 }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const resp = await send('references', query);
		const locs = (resp?.body?.refs ?? []).map((r) => `${r.file}|${r.start?.line}|${r.start?.offset}`);
		let libInProject = null, projectFiles = null, projectName = null;
		try {
			const pi = await send('projectInfo', { file: query.file, needFileNameList: true });
			projectName = pi?.body?.projectName ?? null;
			const names = pi?.body?.fileNames ?? [];
			projectFiles = names.length;
			libInProject = names.filter((f) => /lib\.dom\.d\.ts$|lib\.es5\.d\.ts$/.test(f));
		} catch (e) { libInProject = ['ERR ' + e.message]; }
		return { label, success: !!resp?.success, message: String(resp?.message ?? '').split('\n')[0], locs, norm: locs.map(norm).sort(), projectName, projectFiles, libInProject };
	});
}

function verdictOf(tnb, stock) {
	const tSet = new Set(tnb.norm), sSet = new Set(stock.norm);
	const onlyStock = [...sSet].filter((x) => !tSet.has(x));
	const onlyTnb = [...tSet].filter((x) => !sSet.has(x));
	return { verdict: tnb.success === stock.success && onlyTnb.length === 0 && onlyStock.length === 0 ? 'MATCH' : 'DIFF', onlyStock, onlyTnb };
}

console.log('=== WITNESS f2r6-libref ===');
// Case A: pure .ts
{
	const open = [{ file: tsFile, fileContent: fs.readFileSync(tsFile, 'utf8'), projectRootPath: fix }];
	const q = { file: tsFile, line: 1, offset: 1 };
	const tnb = await run('TNB', tnbPath, tnbHarnessEnv(), open, q);
	const stock = await run('STOCK', stockPath, process.env, open, q);
	const v = verdictOf(tnb, stock);
	gate.set('A_pure_ts_console', [...v.onlyStock.map((x) => `S:${x}`), ...v.onlyTnb.map((x) => `T:${x}`)]);
	console.log(`A pure-ts console: verdict=${v.verdict} TNB n=${tnb.locs.length} STOCK n=${stock.locs.length}`);
	console.log('  onlyStock', v.onlyStock);
	console.log('  onlyTnb', v.onlyTnb);
	console.log('  TNB raw', tnb.locs);
	console.log('  STOCK raw', stock.locs);
	console.log(`  TNB project=${tnb.projectName} files=${tnb.projectFiles} lib=${JSON.stringify(tnb.libInProject)}`);
	console.log(`  STOCK project=${stock.projectName} files=${stock.projectFiles} lib=${JSON.stringify(stock.libInProject)}`);
}
// Case B: sim-nav key tsc/#2225/main.vue:3:3
{
	const open = [{ file: vueFile, fileContent: fs.readFileSync(vueFile, 'utf8'), projectRootPath: tw }];
	const q = { file: vueFile, line: 3, offset: 3 };
	const tnb = await run('TNB', tnbPath, tnbHarnessEnv(), open, q);
	const stock = await run('STOCK', stockPath, process.env, open, q);
	const v = verdictOf(tnb, stock);
	gate.set('B_vue_2225_3_3', [...v.onlyStock.map((x) => `S:${x}`), ...v.onlyTnb.map((x) => `T:${x}`)]);
	console.log(`B vue #2225 3:3: verdict=${v.verdict} TNB n=${tnb.locs.length} STOCK n=${stock.locs.length}`);
	console.log('  onlyStock', v.onlyStock.slice(0, 10));
	console.log('  onlyTnb', v.onlyTnb.slice(0, 10));
	console.log('  TNB norm', tnb.norm.slice(0, 10));
	console.log('  STOCK norm', stock.norm.slice(0, 10));
}
// Case C: pure .ts INSIDE test-workspace (controls project routing; plugin loaded)
{
	const tsInTw = path.join(tw, 'tsc/#2225/plain-probe.ts');
	fs.writeFileSync(tsInTw, `console.log(1);\nconsole.log(2);\n`);
	const open = [{ file: tsInTw, fileContent: fs.readFileSync(tsInTw, 'utf8'), projectRootPath: tw }];
	const q = { file: tsInTw, line: 1, offset: 1 };
	const tnb = await run('TNB', tnbPath, tnbHarnessEnv(), open, q);
	const stock = await run('STOCK', stockPath, process.env, open, q);
	const v = verdictOf(tnb, stock);
	gate.set('C_pure_ts_in_workspace', [...v.onlyStock.map((x) => `S:${x}`), ...v.onlyTnb.map((x) => `T:${x}`)]);
	console.log(`C pure-ts-in-workspace: verdict=${v.verdict} TNB n=${tnb.locs.length} STOCK n=${stock.locs.length}`);
	console.log('  onlyStock', v.onlyStock);
	console.log('  onlyTnb', v.onlyTnb);
	console.log(`  TNB project=${tnb.projectName} files=${tnb.projectFiles} lib=${JSON.stringify(tnb.libInProject)}`);
	console.log(`  STOCK project=${stock.projectName} files=${stock.projectFiles} lib=${JSON.stringify(stock.libInProject)}`);
	fs.unlinkSync(tsInTw);
}

// The known DIFF set is pinned to tools/baselines/triage-f2r6-libref.json; a
// NEW key or a KNOWN key whose item set grows fails the gate (exit 1), so a
// regression in this cluster turns CI red instead of just leaving a log.
// Convergence (fixed keys) is reported but does not block — re-pin the
// baseline with: node tools/triage-f2r6-libref.mjs --refresh
const gateFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baselines', 'triage-f2r6-libref.json');
process.exit(gateCheck(gate));
function gateCheck(collected) {
	const refresh = process.argv.includes('--refresh');
	const cur = new Map([...collected].filter(([, items]) => items.length).map(([k, items]) => [k, [...new Set(items)].sort()]));
	if (refresh) {
		fs.mkdirSync(path.dirname(gateFile), { recursive: true });
		fs.writeFileSync(gateFile, JSON.stringify(Object.fromEntries([...cur].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2) + '\n');
		console.log(`gate: --refresh re-pinned ${gateFile} (${cur.size} keys)`);
		return 0;
	}
	if (!fs.existsSync(gateFile)) {
		console.error(`gate: no baseline at ${gateFile} — run with --refresh to pin the current known DIFF set`);
		return 1;
	}
	const base = new Map(Object.entries(JSON.parse(fs.readFileSync(gateFile, 'utf8'))));
	let rc = 0;
	for (const [k, items] of cur) {
		if (!base.has(k)) {
			console.error(`gate FAIL: NEW diff key ${k} (${items.length} item(s))`);
			for (const i of items) console.error(`  + ${i}`);
			rc = 1;
		} else {
			const grown = items.filter((i) => !base.get(k).includes(i));
			if (grown.length) {
				console.error(`gate FAIL: known diff key ${k} grew by ${grown.length} item(s)`);
				for (const i of grown) console.error(`  + ${i}`);
				rc = 1;
			}
		}
	}
	const fixed = [...base.keys()].filter((k) => !cur.has(k));
	const shrunk = [...cur.keys()].filter((k) => base.has(k) && cur.get(k).length < base.get(k).length);
	if (fixed.length) console.log(`gate: converged (report only): ${fixed.join(', ')}`);
	if (shrunk.length) console.log(`gate: shrunk (report only): ${shrunk.join(', ')}`);
	console.log(rc === 0
		? `gate ok: ${cur.size} known diff keys within baseline (baseline had ${base.size})`
		: 'gate FAILED — re-pin with --refresh only after verifying the new items are real cluster regressions');
	return rc;
}
