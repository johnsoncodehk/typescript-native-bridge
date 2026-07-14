#!/usr/bin/env node
/**
 * IDE edit-session parity: TNB vs stock tsserver.
 * Deterministic 8 sessions × 25 edit steps; byte-identical command scripts.
 *
 * Usage: node tools/triage-sim-edit.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const THROW_FILE = '/tmp/tnb-sim-b-throws.jsonl';
const CMD_TIMEOUT_MS = 30_000;
const STEPS_PER_SESSION = 25;
const SESSION_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

const OPS = ['dot', 'paren', 'const', 'delete'];

/** Session → relative fixture path (seeds 1..8). */
const SESSION_FILES = [
	'component-meta/#4577/main.vue',
	'component-meta/#5546/main.vue',
	'component-meta/generic/main.vue',
	'tsconfigProject/fixture.ts',
	// Deviation: tsconfigProject has only one .ts; stand-in from sibling tsc/
	'tsc/#3732/main.ts',
	// Deviation: test-workspace root has no .ts/.vue; take from tsc/
	'tsc/#3164/main.vue',
	'tsc/directives/main.vue',
	'tsc/#2472/main.vue',
];

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	// No --suppressDiagnosticEvents: geterr must emit semanticDiag events.
];

function mulberry32(seed) {
	let a = seed >>> 0;
	return function next() {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function offsetToLineCol(text, offset) {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === '\n') {
			line++;
			col = 1;
		} else col++;
	}
	return { line, offset: col };
}

function lineColToOffset(text, line, col) {
	let l = 1;
	let i = 0;
	while (i < text.length && l < line) {
		if (text[i] === '\n') l++;
		i++;
	}
	return Math.min(text.length, i + Math.max(0, col - 1));
}

function lineStarts(text) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') starts.push(i + 1);
	}
	return starts;
}

function lineCount(text) {
	if (text.length === 0) return 1;
	return lineStarts(text).length;
}

/** 1-based column just past the last character of the line (insert-at-EOL). */
function lineEndCol(text, line) {
	const starts = lineStarts(text);
	const start = starts[line - 1] ?? 0;
	// exclusive end of line content (index of '\n' or text.length)
	const exclusiveEnd = starts[line] !== undefined ? starts[line] - 1 : text.length;
	return exclusiveEnd - start + 1;
}

function firstIdentifierPos(text) {
	const m = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(text);
	if (!m) return { line: 1, offset: 1, found: false };
	return { ...offsetToLineCol(text, m.index), found: true };
}

function applyEdit(content, start, end, newText) {
	const s = lineColToOffset(content, start.line, start.offset);
	const e = lineColToOffset(content, end.line, end.offset);
	return content.slice(0, s) + newText + content.slice(e);
}

function remapInsertions(insertions, sOff, eOff, newLen) {
	const delta = newLen - (eOff - sOff);
	const out = [];
	for (const ins of insertions) {
		if (ins.start >= eOff) out.push({ ...ins, start: ins.start + delta });
		else if (ins.start + ins.length <= sOff) out.push(ins);
		// Overlap: drop tracking (delete may skip later)
	}
	return out;
}

function pickLine(rng, content) {
	const n = lineCount(content);
	return 1 + Math.floor(rng() * n);
}

function updateOpenChange(file, textChanges) {
	return {
		command: 'updateOpen',
		arguments: {
			openFiles: [],
			closedFiles: [],
			changedFiles: [{ fileName: file, textChanges }],
		},
	};
}

function buildSessionScript(sessionIndex) {
	const seed = SESSION_SEEDS[sessionIndex];
	const rel = SESSION_FILES[sessionIndex];
	const file = path.join(testWorkspacePath, rel);
	const originalContent = fs.readFileSync(file, 'utf8');
	const rng = mulberry32(seed);

	let content = originalContent;
	let insertions = [];
	const steps = [];

	for (let step = 1; step <= STEPS_PER_SESSION; step++) {
		const op = OPS[Math.floor(rng() * OPS.length)];
		const entry = { step, op, commands: [], compare: null, probe: null, skipReason: null };

		if (op === 'delete' && insertions.length === 0) {
			entry.op = 'skip';
			entry.skipReason = 'no-prior-insertion';
			steps.push(entry);
			continue;
		}

		if (op === 'dot') {
			const line = pickLine(rng, content);
			const col = lineEndCol(content, line);
			const start = { line, offset: col };
			const end = { line, offset: col };
			const newText = '.';
			const sOff = lineColToOffset(content, line, col);
			insertions = remapInsertions(insertions, sOff, sOff, newText.length);
			insertions.push({ start: sOff, length: newText.length, text: newText });
			content = applyEdit(content, start, end, newText);
			const probe = { line, offset: col }; // caret after insert → after the '.'
			const after = offsetToLineCol(content, sOff + newText.length);
			entry.commands.push(updateOpenChange(file, [{ start, end, newText }]));
			entry.commands.push({
				command: 'completionInfo',
				arguments: { file, line: after.line, offset: after.offset },
			});
			entry.compare = 'completionInfo';
			entry.probe = after;
		} else if (op === 'paren') {
			const line = pickLine(rng, content);
			const col = lineEndCol(content, line);
			const start = { line, offset: col };
			const end = { line, offset: col };
			const newText = '(';
			const sOff = lineColToOffset(content, line, col);
			insertions = remapInsertions(insertions, sOff, sOff, newText.length);
			insertions.push({ start: sOff, length: newText.length, text: newText });
			content = applyEdit(content, start, end, newText);
			const after = offsetToLineCol(content, sOff + newText.length);
			entry.commands.push(updateOpenChange(file, [{ start, end, newText }]));
			entry.commands.push({
				command: 'signatureHelp',
				arguments: { file, line: after.line, offset: after.offset },
			});
			entry.compare = 'signatureHelp';
			entry.probe = after;
		} else if (op === 'const') {
			const line = pickLine(rng, content);
			const start = { line, offset: 1 };
			const end = { line, offset: 1 };
			const newText = `const _tmp${step} = 1;\n`;
			const sOff = lineColToOffset(content, line, 1);
			insertions = remapInsertions(insertions, sOff, sOff, newText.length);
			insertions.push({ start: sOff, length: newText.length, text: newText });
			content = applyEdit(content, start, end, newText);
			entry.commands.push(updateOpenChange(file, [{ start, end, newText }]));
			entry.commands.push({
				command: 'geterr',
				arguments: { delay: 0, files: [file] },
			});
			entry.compare = 'geterr';
			entry.probe = offsetToLineCol(content, sOff);
		} else if (op === 'delete') {
			const ins = insertions.pop();
			const start = offsetToLineCol(content, ins.start);
			const end = offsetToLineCol(content, ins.start + ins.length);
			const newText = '';
			const sOff = ins.start;
			const eOff = ins.start + ins.length;
			insertions = remapInsertions(insertions, sOff, eOff, 0);
			content = applyEdit(content, start, end, newText);
			const probe = start;
			entry.commands.push(updateOpenChange(file, [{ start, end, newText }]));
			entry.commands.push({
				command: 'quickinfo',
				arguments: { file, line: probe.line, offset: probe.offset },
			});
			entry.compare = 'quickinfo';
			entry.probe = probe;
		}

		steps.push(entry);
	}

	const idPos = firstIdentifierPos(originalContent);
	const finale = {
		commands: [
			updateOpenChange(file, [{
				start: { line: 1, offset: 1 },
				end: offsetToLineCol(content, content.length),
				newText: originalContent,
			}]),
			{
				command: 'quickinfo',
				arguments: { file, line: idPos.line, offset: idPos.offset },
			},
		],
		compare: 'quickinfo',
		probe: idPos,
		identifierFound: idPos.found,
	};

	return {
		session: sessionIndex + 1,
		seed,
		rel,
		file,
		originalContent,
		steps,
		finale,
		scriptPath: `/tmp/tnb-sim-b-session${sessionIndex + 1}.json`,
	};
}

function signatureLabel(item) {
	if (!item) return null;
	const partText = (parts) => (parts ?? []).map(p => p.text).join('');
	const params = (item.parameters ?? [])
		.map(p => partText(p.displayParts))
		.join(partText(item.separatorDisplayParts) || ', ');
	return partText(item.prefixDisplayParts) + params + partText(item.suffixDisplayParts);
}

function fingerprint(compare, res, diagBody) {
	if (compare === 'completionInfo') {
		const names = (res?.body?.entries ?? []).map(e => e.name).sort();
		return {
			success: !!res?.success,
			isGlobalCompletion: !!res?.body?.isGlobalCompletion,
			namesTop50: names.slice(0, 50),
		};
	}
	if (compare === 'signatureHelp') {
		const items = res?.body?.items ?? [];
		return {
			success: !!res?.success,
			itemCount: items.length,
			firstLabel: signatureLabel(items[0]),
		};
	}
	if (compare === 'geterr') {
		const diags = diagBody?.diagnostics ?? [];
		const set = diags
			.map(d => {
				const start = d.start;
				const startKey = typeof start === 'object'
					? `${start.line}:${start.offset}`
					: String(start ?? '');
				return `${d.code}@${startKey}`;
			})
			.sort();
		return { codesStarts: set, timedOut: !!diagBody?.timedOut };
	}
	if (compare === 'quickinfo') {
		return {
			success: !!res?.success,
			displayString: res?.body?.displayString ?? null,
		};
	}
	return { raw: res?.success };
}

function fpKey(fp) {
	return JSON.stringify(fp);
}

function sameFp(a, b) {
	return fpKey(a) === fpKey(b);
}

async function replayScript(label, tsserverPath, env, script, { maxStep = Infinity, classifyMode = false } = {}) {
	const results = [];
	let crashed = null;
	/** @type {{ resolve: (b: any) => void, timer: NodeJS.Timeout } | null} */
	let pendingDiag = null;

	try {
		await withTsserver({
			tsserverPath,
			args: harnessArgs,
			env,
			deadlineMs: 600_000,
			onEvent: (ev) => {
				if (ev?.event === 'semanticDiag' && pendingDiag) {
					const body = ev.body ?? { diagnostics: [] };
					clearTimeout(pendingDiag.timer);
					const r = pendingDiag.resolve;
					pendingDiag = null;
					r(body);
				}
			},
		}, async ({ send, server }) => {
			const safeSend = async (command, args) => {
				try {
					return await send(command, args, CMD_TIMEOUT_MS);
				} catch (err) {
					const e = new Error(`${command} failed: ${err.message}`);
					e.cause = err;
					throw e;
				}
			};

			await safeSend('configure', {
				preferences: {
					includeCompletionsForModuleExports: false,
					includeCompletionsWithInsertText: true,
				},
			});
			await safeSend('updateOpen', {
				changedFiles: [],
				closedFiles: [],
				openFiles: [{
					file: script.file,
					fileContent: script.originalContent,
					projectRootPath: testWorkspacePath,
				}],
			});

			const runCmds = async (stepMeta) => {
				let lastRes = null;
				let diagBody = null;
				for (const cmd of stepMeta.commands) {
					if (cmd.command === 'geterr') {
						// geterr often emits events without a request response; do not
						// treat a missing/slow response as a crash.
						const diagPromise = new Promise((resolve) => {
							const timer = setTimeout(() => {
								if (pendingDiag) {
									pendingDiag = null;
									resolve({ file: script.file, diagnostics: [], timedOut: true });
								}
							}, CMD_TIMEOUT_MS);
							pendingDiag = { resolve, timer };
						});
						lastRes = await Promise.race([
							send(cmd.command, cmd.arguments, 5_000).catch(() => ({ success: true, noResponse: true })),
							new Promise(resolve => setTimeout(() => resolve({ success: true, noResponse: true }), 2_000)),
						]);
						diagBody = await diagPromise;
					} else {
						lastRes = await safeSend(cmd.command, cmd.arguments);
					}
				}
				return { lastRes, diagBody };
			};

			const limit = Math.min(script.steps.length, maxStep);
			for (let i = 0; i < limit; i++) {
				const stepMeta = script.steps[i];
				if (stepMeta.op === 'skip') {
					results.push({
						step: stepMeta.step,
						op: 'skip',
						compare: null,
						fp: null,
						skipReason: stepMeta.skipReason,
						raw: null,
					});
					continue;
				}
				try {
					const { lastRes, diagBody } = await runCmds(stepMeta);
					const fp = fingerprint(stepMeta.compare, lastRes, diagBody);
					results.push({
						step: stepMeta.step,
						op: stepMeta.op,
						compare: stepMeta.compare,
						fp,
						raw: {
							success: lastRes?.success,
							message: lastRes?.message ?? null,
							bodyKeys: lastRes?.body ? Object.keys(lastRes.body) : [],
							diagCount: diagBody?.diagnostics?.length ?? null,
						},
					});
				} catch (err) {
					crashed = { step: stepMeta.step, error: String(err.message ?? err) };
					results.push({
						step: stepMeta.step,
						op: stepMeta.op,
						compare: stepMeta.compare,
						fp: { crash: true, error: crashed.error },
						raw: { crash: true },
						crash: true,
					});
					throw err;
				}
			}

			if (!classifyMode && maxStep >= script.steps.length) {
				try {
					const { lastRes } = await runCmds(script.finale);
					const fp = fingerprint('quickinfo', lastRes, null);
					results.push({
						step: 'finale',
						op: 'restore',
						compare: 'quickinfo',
						fp,
						raw: {
							success: lastRes?.success,
							displayString: lastRes?.body?.displayString ?? null,
						},
					});
				} catch (err) {
					crashed = { step: 'finale', error: String(err.message ?? err) };
					results.push({
						step: 'finale',
						op: 'restore',
						compare: 'quickinfo',
						fp: { crash: true, error: crashed.error },
						crash: true,
					});
					throw err;
				}
			}

			void server;
		});
	} catch (err) {
		if (!crashed) {
			crashed = { step: results.at(-1)?.step ?? 'init', error: String(err.message ?? err) };
		}
	}

	return { label, results, crashed };
}

/** Replay open + only steps in `stepIndices` (1-based). */
async function replayPrefix(label, tsserverPath, env, script, stepIndices) {
	const subset = {
		...script,
		steps: script.steps.filter(s => stepIndices.includes(s.step)),
		finale: null,
	};
	// Re-map: apply only selected steps but they assume prior content edits —
	// For SHORT test we need contiguous suffix ending at target applied to original.
	// Rebuild a synthetic script that applies those steps' textChanges in order
	// as recorded (they were generated against evolving content, so only a
	// contiguous prefix from step 1 works correctly). For ≤3-step SHORT we try
	// suffixes by regenerating from a content simulator — see classifyDiff.
	return replayScript(label, tsserverPath, env, subset, {
		maxStep: subset.steps.length,
		classifyMode: true,
	});
}

/**
 * Rebuild script that contains only the last K steps before and including
 * targetStep, by re-simulating edits from original for that window only.
 * For K-step suffix starting mid-session, recompute positions from a parallel
 * content sim that applies ALL prior edits then records only last K commands.
 */
function buildSuffixScript(fullScript, targetStep, k) {
	const startStep = Math.max(1, targetStep - k + 1);
	const seed = fullScript.seed;
	const rng = mulberry32(seed);
	let content = fullScript.originalContent;
	let insertions = [];
	const kept = [];

	for (let step = 1; step <= targetStep; step++) {
		const opOrig = fullScript.steps[step - 1];
		// Consume the same RNG draws as buildSessionScript even for skipped ops.
		const opRoll = OPS[Math.floor(rng() * OPS.length)];
		void opRoll;
		const stepMeta = opOrig;
		if (stepMeta.op === 'skip') {
			if (step >= startStep) kept.push(stepMeta);
			continue;
		}
		// Re-apply using recorded commands' textChanges (source of truth)
		const changeCmd = stepMeta.commands.find(c => c.command === 'updateOpen');
		const tc = changeCmd?.arguments?.changedFiles?.[0]?.textChanges?.[0];
		if (tc) {
			content = applyEdit(content, tc.start, tc.end, tc.newText);
		}
		if (step >= startStep) kept.push(stepMeta);
	}

	return {
		...fullScript,
		steps: kept,
		// Suffix scripts still open original; commands' line/col were computed
		// in the FULL session context. Applying a mid-session textChange on
		// original content is wrong. So SHORT must use contiguous prefix from 1.
	};
}

/**
 * SHORT = DIFF still appears when replaying open + steps 1..target with
 * targetStep <= 3, OR when replaying only the single target step is impossible
 * on original — handout: 「開檔→跳到該步的最小前綴」「≤3 步內復現」.
 * We try prefixes of length L=1..min(3,target) ending at target:
 *   steps (target-L+1)..target applied AFTER replaying 1..(target-L) silently? 
 * Simpler interpretation used here:
 *   If targetStep <= 3: replay full prefix 1..target → if DIFF remains, SHORT.
 *   If targetStep > 3: try replay of only steps (target-2)..target on a server
 *   that first silently applies 1..(target-3) — that's still >3 visible compare
 *   steps. Handout means: can reproduce with a fresh server and ≤3 edit steps
 *   total. So try prefixes of the FULL sequence truncated to last K=1..3 steps
 *   by regenerating a mini-session — only works if those K steps' coordinates
 *   are re-derived from original.
 *
 * Practical approach matching handout + SEQ fallback:
 *   Replay open + steps 1..min(target,3) and compare the last step's fp when
 *   target<=3. When target>3, attempt replay of open + steps 1..target but only
 *   classify SHORT if target<=3; else mark SEQ with full script path.
 *   Additionally: try replaying open + ONLY step `target` after regenerating
 *   that one edit against original (same op/seed-position attempt) — too fragile.
 *
 * Final rule (stable, honest):
 *   Fresh server, replay steps 1..targetStep. If targetStep <= 3 and DIFF
 *   reproduces → SHORT. Else → SEQ. (「≤3 步內」= 整段前綴長度 ≤3)
 */
async function classifyDiff(script, targetStep, stockFp, tnbFp) {
	if (targetStep <= 3) {
		const tnb = await replayScript('TNB', tnbPath, tnbHarnessEnv({
			TNB_TRACE_THROW: '1',
			TNB_TRACE_THROW_FILE: THROW_FILE,
		}), script, { maxStep: targetStep, classifyMode: true });
		const stock = await replayScript('STOCK', stockPath, process.env, script, {
			maxStep: targetStep,
			classifyMode: true,
		});
		const tStep = tnb.results.find(r => r.step === targetStep);
		const sStep = stock.results.find(r => r.step === targetStep);
		const stillDiff = tStep && sStep && !sameFp(tStep.fp, sStep.fp);
		return {
			kind: stillDiff ? 'SHORT' : 'SEQ',
			replay: {
				tnb: tStep?.fp ?? tnb.crashed,
				stock: sStep?.fp ?? stock.crashed,
				stillDiff: !!stillDiff,
				prefixLen: targetStep,
			},
		};
	}
	return {
		kind: 'SEQ',
		replay: {
			note: 'targetStep>3; full session script required',
			prefixLen: targetStep,
			stockFp,
			tnbFp,
		},
	};
}

function summarizeThrows() {
	if (!fs.existsSync(THROW_FILE)) return [];
	const lines = fs.readFileSync(THROW_FILE, 'utf8').split('\n').filter(Boolean);
	return lines.map(l => {
		try { return JSON.parse(l); } catch { return { raw: l }; }
	});
}

// ── main ──────────────────────────────────────────────────────────────
fs.writeFileSync(THROW_FILE, '');

const scripts = SESSION_SEEDS.map((_, i) => {
	const s = buildSessionScript(i);
	const toSave = {
		session: s.session,
		seed: s.seed,
		rel: s.rel,
		file: s.file,
		steps: s.steps,
		finale: s.finale,
		originalContent: s.originalContent,
	};
	fs.writeFileSync(s.scriptPath, JSON.stringify(toSave, null, 2));
	return s;
});

console.log('=== session → file → seed ===');
for (const s of scripts) {
	console.log(`session=${s.session} seed=${s.seed} file=${s.rel} script=${s.scriptPath}`);
}

const sideResults = { TNB: [], STOCK: [] };

for (const side of ['TNB', 'STOCK']) {
	const tsserverPath = side === 'TNB' ? tnbPath : stockPath;
	const env = side === 'TNB'
		? tnbHarnessEnv({ TNB_TRACE_THROW: '1', TNB_TRACE_THROW_FILE: THROW_FILE })
		: { ...process.env };
	for (const script of scripts) {
		console.log(`\n=== ${side} session ${script.session} ===`);
		let r = await replayScript(side, tsserverPath, env, script);
		if (r.crashed) {
			console.log(`CRASH ${side} session=${script.session} step=${r.crashed.step}: ${r.crashed.error}`);
			console.log(`RETRY session ${script.session}`);
			r = await replayScript(side, tsserverPath, env, script);
		}
		sideResults[side].push(r);
		if (r.crashed) {
			console.log(`CRASH ${side} session=${script.session} step=${r.crashed.step}: ${r.crashed.error}`);
			// Fill remaining steps as skip so totals conserve; continue next session
			const have = new Set(r.results.map(x => x.step));
			for (let step = 1; step <= STEPS_PER_SESSION; step++) {
				if (!have.has(step)) {
					r.results.push({
						step,
						op: 'skip',
						compare: null,
						fp: null,
						skipReason: `aborted-after-crash@${r.crashed.step}`,
					});
				}
			}
			if (![...have].includes('finale')) {
				r.results.push({
					step: 'finale',
					op: 'skip',
					fp: null,
					skipReason: `aborted-after-crash@${r.crashed.step}`,
					baselineSkipped: true,
				});
			}
		}
		console.log(`${side} session=${script.session} steps=${r.results.filter(x => x.step !== 'finale').length} crashed=${!!r.crashed}`);
	}
}

let match = 0;
let diff = 0;
let skip = 0;
const diffs = [];
const samples = [];
const baseline = [];

for (let si = 0; si < scripts.length; si++) {
	const script = scripts[si];
	const tnb = sideResults.TNB[si];
	const stock = sideResults.STOCK[si];
	const tnbSteps = new Map(tnb.results.map(r => [r.step, r]));
	const stockSteps = new Map(stock.results.map(r => [r.step, r]));

	for (let step = 1; step <= STEPS_PER_SESSION; step++) {
		const t = tnbSteps.get(step);
		const s = stockSteps.get(step);
		if (!t || !s) {
			skip++;
			continue;
		}
		if (t.op === 'skip' || s.op === 'skip' || t.skipReason || s.skipReason) {
			skip++;
			continue;
		}
		if (t.crash || s.crash) {
			diff++;
			diffs.push({
				session: script.session,
				step,
				op: t.op ?? s.op,
				compare: t.compare ?? s.compare,
				tnb: t.fp,
				stock: s.fp,
				scriptPath: script.scriptPath,
				crash: true,
			});
			continue;
		}
		if (sameFp(t.fp, s.fp)) {
			match++;
			if (samples.length < 3) {
				samples.push({
					session: script.session,
					step,
					op: t.op,
					compare: t.compare,
					tnb: t.fp,
					stock: s.fp,
					tnbRaw: t.raw,
					stockRaw: s.raw,
				});
			}
		} else {
			diff++;
			diffs.push({
				session: script.session,
				step,
				op: t.op,
				compare: t.compare,
				tnb: t.fp,
				stock: s.fp,
				tnbRaw: t.raw,
				stockRaw: s.raw,
				scriptPath: script.scriptPath,
			});
		}
	}

	const tf = tnbSteps.get('finale');
	const sf = stockSteps.get('finale');
	const baseOk = tf && sf && !tf.crash && !sf.crash && !tf.baselineSkipped && !sf.baselineSkipped
		&& sameFp(tf.fp, sf.fp);
	baseline.push({
		session: script.session,
		ok: !!baseOk,
		tnb: tf?.fp ?? null,
		stock: sf?.fp ?? null,
	});
}

console.log('\n=== classifying DIFFS ===');
for (const d of diffs) {
	if (d.crash) {
		d.classification = 'SHORT';
		d.classifyReplay = { note: 'crash/timeout treated as highest finding' };
		continue;
	}
	try {
		const script = scripts[d.session - 1];
		const cls = await classifyDiff(script, d.step, d.stock, d.tnb);
		d.classification = cls.kind;
		d.classifyReplay = cls.replay;
		console.log(`DIFF session=${d.session} step=${d.step} → ${cls.kind}`);
	} catch (err) {
		d.classification = 'SEQ';
		d.classifyReplay = { error: String(err.message ?? err) };
		console.log(`DIFF session=${d.session} step=${d.step} classify error → SEQ (${err.message})`);
	}
}

const steps = match + diff + skip;
const baselineOk = baseline.filter(b => b.ok).length;

console.log(`\nSUMMARY: steps=${steps} match=${match} diff=${diff} skip=${skip}`);
console.log(`BASELINE: ${baselineOk}/8`);
console.log(`conservation: ${steps}===${match}+${diff}+${skip} → ${steps === 200 && steps === match + diff + skip}`);

const throws = summarizeThrows();
console.log(`THROWS: ${throws.length}`);

const out = {
	summary: { steps, match, diff, skip, baselineOk },
	sessions: scripts.map(s => ({
		session: s.session,
		seed: s.seed,
		rel: s.rel,
		scriptPath: s.scriptPath,
	})),
	diffs,
	samples,
	baseline,
	throws,
};
fs.writeFileSync('/tmp/tnb-sim-b-results.json', JSON.stringify(out, null, 2));
console.log('wrote /tmp/tnb-sim-b-results.json');

if (steps !== 200 || steps !== match + diff + skip) {
	process.exitCode = 1;
} else {
	process.exitCode = 0;
}
