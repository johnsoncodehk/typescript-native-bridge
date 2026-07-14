#!/usr/bin/env node
// Perf diagnosis: decompose edit→quickinfo / edit→completion into bridge RPCs.
// Uses env-gated TNB_TRACE_RPC / TNB_RPC_TRACE (default off). Harness lock = 1.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const mainVue = path.join(testWorkspacePath, 'component-meta/#4577/main.vue');
const baseContent = fs.readFileSync(mainVue, 'utf8');

const TRACE_FILE = process.env.TNB_RPC_TRACE_FILE
	|| process.env.TNB_TRACE_RPC_FILE
	|| '/tmp/tnb-perf-edit-rpc.log';
const OUT_SUM = process.env.TNB_PERF_SUM || '/tmp/tnb-perf-edit-rpc-summary.json';
const MODE = process.env.TNB_PERF_MODE || 'both'; // qi | comp | both
const REPEATS = Math.max(3, Number(process.env.TNB_PERF_REPEATS || 3));

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const INSERT_LINE = 12;
const QI = { line: 11, offset: 13 };

function mark(phase) {
	fs.appendFileSync(TRACE_FILE, `${Date.now()} PHASE ${phase}\n`);
}
function markEnd(phase) {
	fs.appendFileSync(TRACE_FILE, `${Date.now()} PHASE_END ${phase}\n`);
}

/** Parse ENTER/EXIT/EVENT between PHASE markers; return per-method stats. */
function summarizePhase(logText, phase) {
	const lines = logText.split('\n');
	let inPhase = false;
	const enters = new Map(); // id -> { method, t }
	const byMethod = new Map(); // method -> { count, ms, samples }
	const events = [];
	let rpcCount = 0;
	let rpcMs = 0;
	for (const line of lines) {
		if (line.includes(` PHASE ${phase}`)) { inPhase = true; continue; }
		if (line.includes(` PHASE_END ${phase}`)) { inPhase = false; continue; }
		if (!inPhase) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 3) continue;
		const kind = parts[1];
		if (kind === 'ENTER') {
			const id = Number(parts[2]);
			const method = parts[parts.length - 1];
			enters.set(id, { method, t: Number(parts[0]) });
		} else if (kind === 'EXIT') {
			const id = Number(parts[2]);
			const method = parts[3];
			let ms = -1;
			const msTok = parts.find(p => p.startsWith('ms='));
			if (msTok) ms = Number(msTok.slice(3));
			else if (enters.has(id)) ms = Number(parts[0]) - enters.get(id).t;
			enters.delete(id);
			if (!(ms >= 0)) ms = 0;
			let b = byMethod.get(method);
			if (!b) { b = { count: 0, ms: 0, max: 0 }; byMethod.set(method, b); }
			b.count++;
			b.ms += ms;
			if (ms > b.max) b.max = ms;
			rpcCount++;
			rpcMs += ms;
		} else if (kind === 'EVENT') {
			events.push(line.replace(/^\d+\s+EVENT\s+/, ''));
		}
	}
	const top = [...byMethod.entries()]
		.map(([method, v]) => ({ method, count: v.count, ms: v.ms, max: v.max, avg: v.count ? v.ms / v.count : 0 }))
		.sort((a, b) => b.ms - a.ms);
	return { phase, rpcCount, rpcMs, top, events };
}

async function oneRun(runIdx) {
	const env = tnbHarnessEnv({
		TNB_TRACE_RPC: '1',
		TNB_RPC_TRACE: '1',
		TNB_RPC_TRACE_FILE: TRACE_FILE,
		TNB_TRACE_RPC_FILE: TRACE_FILE,
	});
	return withTsserver({ tsserverPath: tnbPath, args: harnessArgs, env }, async ({ send }) => {
		const wall = [];
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsForImportStatements: true,
				includeCompletionsWithInsertText: true,
				includePackageJsonAutoImports: 'auto',
			},
		});
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [{ file: mainVue, fileContent: baseContent, projectRootPath: testWorkspacePath }],
		});
		// Warm both paths so first-keystroke reflects steady-state post-edit cost.
		await send('quickinfo', { file: mainVue, ...QI });
		await send('completionInfo', { file: mainVue, line: INSERT_LINE, offset: 1 });

		const ch = 'r';
		const typed = ch;
		const tEdit = Date.now();
		await send('updateOpen', {
			changedFiles: [{
				fileName: mainVue,
				textChanges: [{
					start: { line: INSERT_LINE, offset: typed.length },
					end: { line: INSERT_LINE, offset: typed.length },
					newText: ch,
				}],
			}],
			openFiles: [], closedFiles: [],
		});
		wall.push({ step: 'edit', ms: Date.now() - tEdit });

		if (MODE === 'qi' || MODE === 'both') {
			const phase = `run${runIdx}-edit-qi`;
			mark(phase);
			const t0 = Date.now();
			await send('quickinfo', { file: mainVue, ...QI });
			wall.push({ step: 'edit→qi', ms: Date.now() - t0, phase });
			markEnd(phase);
		}
		if (MODE === 'comp' || MODE === 'both') {
			// Fresh edit for completion path isolation when measuring both in one session
			// would otherwise share warmed post-qi caches. For MODE=both: second keystroke 'e'.
			if (MODE === 'both') {
				const tE = Date.now();
				await send('updateOpen', {
					changedFiles: [{
						fileName: mainVue,
						textChanges: [{
							start: { line: INSERT_LINE, offset: 2 },
							end: { line: INSERT_LINE, offset: 2 },
							newText: 'e',
						}],
					}],
					openFiles: [], closedFiles: [],
				});
				wall.push({ step: "edit 'e'", ms: Date.now() - tE });
			}
			const phase = `run${runIdx}-edit-comp`;
			const offset = MODE === 'both' ? 3 : 2;
			mark(phase);
			const t0 = Date.now();
			const comp = await send('completionInfo', {
				file: mainVue, line: INSERT_LINE, offset,
			});
			wall.push({
				step: 'edit→comp',
				ms: Date.now() - t0,
				phase,
				entries: comp?.body?.entries?.length ?? 0,
			});
			markEnd(phase);
		}

		// Repeat no-edit completion / qi
		if (MODE === 'comp' || MODE === 'both') {
			const phase = `run${runIdx}-repeat-comp`;
			mark(phase);
			const t0 = Date.now();
			await send('completionInfo', {
				file: mainVue, line: INSERT_LINE, offset: MODE === 'both' ? 3 : 2,
			});
			wall.push({ step: 'repeat-comp', ms: Date.now() - t0, phase });
			markEnd(phase);
		}
		if (MODE === 'qi' || MODE === 'both') {
			const phase = `run${runIdx}-repeat-qi`;
			mark(phase);
			const t0 = Date.now();
			await send('quickinfo', { file: mainVue, ...QI });
			wall.push({ step: 'repeat-qi', ms: Date.now() - t0, phase });
			markEnd(phase);
		}
		return wall;
	});
}

function median(nums) {
	const a = [...nums].sort((x, y) => x - y);
	return a[Math.floor(a.length / 2)];
}

fs.writeFileSync(TRACE_FILE, `# triage-perf-edit-rpc start ${new Date().toISOString()}\n`);
const allWalls = [];
for (let i = 1; i <= REPEATS; i++) {
	console.log(`=== run ${i}/${REPEATS} ===`);
	const wall = await oneRun(i);
	allWalls.push(wall);
	for (const w of wall) console.log(`  ${w.step}: ${w.ms}ms${w.entries != null ? ` entries=${w.entries}` : ''}`);
}

const logText = fs.readFileSync(TRACE_FILE, 'utf8');
const phases = [];
for (let i = 1; i <= REPEATS; i++) {
	for (const name of [`run${i}-edit-qi`, `run${i}-edit-comp`, `run${i}-repeat-comp`, `run${i}-repeat-qi`]) {
		if (logText.includes(` PHASE ${name}`)) phases.push(summarizePhase(logText, name));
	}
}

const byStep = {};
for (const wall of allWalls) {
	for (const w of wall) {
		(byStep[w.step] ??= []).push(w.ms);
	}
}
const medians = Object.fromEntries(
	Object.entries(byStep).map(([k, v]) => [k, { n: v.length, samples: v, median: median(v) }]),
);

const summary = { mode: MODE, repeats: REPEATS, traceFile: TRACE_FILE, medians, phases };
fs.writeFileSync(OUT_SUM, JSON.stringify(summary, null, 2));
console.log(`\n=== medians ===`);
for (const [k, v] of Object.entries(medians)) console.log(`  ${k}: median=${v.median}ms samples=[${v.samples.join(',')}]`);
console.log(`\n=== phase RPC tops (per run) ===`);
for (const p of phases) {
	console.log(`\n[${p.phase}] rpcCount=${p.rpcCount} rpcMs=${p.rpcMs}`);
	for (const e of p.events.slice(0, 8)) console.log(`  EVENT ${e}`);
	for (const t of p.top.slice(0, 12)) {
		console.log(`  ${t.method}: count=${t.count} totalMs=${t.ms} avg=${t.avg.toFixed(2)} max=${t.max}`);
	}
}
console.log(`\nsummary → ${OUT_SUM}`);
console.log(`trace → ${TRACE_FILE}`);
