#!/usr/bin/env node
// Triage: goto definition on `toString` in main.vue L12 (''.toString;) — TNB vs stock.
// Regression witness for the bundled:///libs/* fileName leak in DefinitionInfo.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(testWorkspacePath, 'component-meta/#4577/main.vue');
const fileContent = fs.readFileSync(mainVue, 'utf8');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const offset = fileContent.indexOf("''.toString") + "''.".length + 2; // inside toString
function offsetToLineCol(text, off) {
	let line = 1, col = 1;
	for (let i = 0; i < off; i++) {
		if (text[i] === '\n') { line++; col = 1; } else col++;
	}
	return { line, offset: col };
}
const pos = offsetToLineCol(fileContent, offset);
console.log(`target: line=${pos.line} col=${pos.offset} (offset=${offset})`);

async function run(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: mainVue, fileContent, projectRootPath: testWorkspacePath }],
		});
		const defBound = await send('definitionAndBoundSpan', { file: mainVue, line: pos.line, offset: pos.offset });
		const def = await send('definition', { file: mainVue, line: pos.line, offset: pos.offset });
		const qi = await send('quickinfo', { file: mainVue, line: pos.line, offset: pos.offset });
		return {
			label,
			defBound: { success: defBound?.success, message: defBound?.message, defs: defBound?.body?.definitions ?? [] },
			def: { success: def?.success, message: def?.message, defs: def?.body ?? [] },
			quickinfo: { success: qi?.success, displayString: qi?.body?.displayString },
		};
	});
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = await run('STOCK', stockPath, process.env);
for (const r of [tnb, stock]) {
	console.log(`\n=== ${r.label} ===`);
	console.log(`definitionAndBoundSpan: success=${r.defBound.success} count=${r.defBound.defs.length} msg=${(r.defBound.message ?? '').split('\n')[0]}`);
	for (const d of r.defBound.defs) console.log(`  -> ${d.file}:${d.start?.line}:${d.start?.offset}`);
	console.log(`definition: success=${r.def.success} count=${r.def.defs.length}`);
	console.log(`quickinfo: success=${r.quickinfo.success} display=${JSON.stringify(r.quickinfo.displayString)}`);
}
const parity = tnb.defBound.success === stock.defBound.success
	&& tnb.defBound.defs.length === stock.defBound.defs.length
	&& tnb.defBound.defs.every(d => !String(d.file ?? '').startsWith('bundled://'));
console.log(`\nverdict: ${parity ? 'PARITY' : 'DIFF'}`);

const gate = new Map();
if (!parity) {
	const items = [];
	const normLoc = (f) => {
		const file = String(f ?? '');
		if (file.startsWith('bundled://')) return 'BUNDLED:' + file;
		const i = file.indexOf('/test-workspace/');
		if (i >= 0) return 'TW:' + file.slice(i + '/test-workspace/'.length);
		const j = file.lastIndexOf('/node_modules/');
		if (j >= 0) return 'NM:' + file.slice(j + '/node_modules/'.length);
		return 'ABS:' + file.split('/').slice(-2).join('/');
	};
	const normDefs = (defs) => (defs ?? []).map((d) => `${normLoc(d.file)}|${d.start?.line ?? '?'}|${d.start?.offset ?? '?'}`).sort().join('|');
	const sub = (name, a, b, fmt) => {
		const pa = fmt(a);
		const pb = fmt(b);
		if (pa !== pb) items.push(`TNB ${name} ${pa}`, `STOCK ${name} ${pb}`);
	};
	sub('defBound', tnb.defBound, stock.defBound, (r) => `success=${r.success} defs=[${normDefs(r.defs)}]`);
	sub('definition', tnb.def, stock.def, (r) => `success=${r.success} defs=[${normDefs(r.defs)}]`);
	sub('quickinfo', tnb.quickinfo, stock.quickinfo, (r) => `success=${r.success} display=${JSON.stringify(r.displayString)}`);
	const leak = [...tnb.defBound.defs, ...tnb.def.defs].filter((d) => String(d.file ?? '').startsWith('bundled://'));
	if (leak.length) items.push(`TNB bundled:// fileName leak (${leak.length} def(s))`);
	gate.set('4577_toString_gtd', items);
}

// The known DIFF set is pinned to tools/baselines/triage-tostring-gtd-vue.json;
// a NEW key or a KNOWN key whose item set grows fails the gate (exit 1), so a
// regression in this cluster turns CI red instead of just leaving a log.
// Convergence (fixed keys) is reported but does not block — re-pin the
// baseline with: node tools/triage-tostring-gtd-vue.mjs --refresh
const gateFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baselines', 'triage-tostring-gtd-vue.json');
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
