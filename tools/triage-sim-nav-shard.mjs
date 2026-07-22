#!/usr/bin/env node
/**
 * IDE nav roam: long-session quickinfo / definitionAndBoundSpan / references
 * + geterr diag parity — TNB vs stock. (documentHighlights was dropped: its
 * compared surface is a strict subset of references on the same FAR
 * machinery, and it diverged zero times in gate history; f2hl-* witnesses
 * keep the targeted highlights coverage.)
 *
 * Deterministic identifier sampling, deduped: only the first sampled
 * occurrence of each identifier per file is probed (repeat occurrences resolve
 * to the same symbol), plus every position the baseline records as divergent.
 * Dual concurrent withTsserver sessions.
 * Usage: node tools/triage-sim-nav-shard.mjs
 * SUMMARY: total=T match=M diff=D docdiff=DD diagmsg=DM skip=S
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
// Compare keys use test-workspace-relative paths so committed baselines stay
// portable across checkouts (nightly CI vs local machines).
const relPath = (file) => path.relative(testWorkspacePath, file).split(path.sep).join('/');
// The sim-nav harness. Run N shards in parallel from isolated tools/ copies
// (harness lock is per tools-dir parent), then merge shard JSONs. Compare keys
// are disjoint across shards (keyed by file:pos:cmd).
const SHARD_INDEX = Math.max(0, Number.parseInt(process.env.SIM_NAV_SHARD_INDEX ?? '0', 10) || 0);
const SHARD_COUNT = Math.max(1, Number.parseInt(process.env.SIM_NAV_SHARD_COUNT ?? '1', 10) || 1);
const THROW_FILE =
	process.env.SIM_NAV_THROW_FILE ?? `/tmp/tnb-sim-a-throws-shard${SHARD_INDEX}of${SHARD_COUNT}.jsonl`;
const OUT_JSON =
	process.env.SIM_NAV_OUT_JSON ?? `/tmp/tnb-sim-a-nav-results-shard${SHARD_INDEX}of${SHARD_COUNT}.json`;
const OUT_LOG =
	process.env.SIM_NAV_OUT_LOG ?? `/tmp/tnb-sim-a-nav-run-shard${SHARD_INDEX}of${SHARD_COUNT}.log`;
const CMD_TIMEOUT_MS = 30_000;
const SESSION_DEADLINE_MS = 12 * 60 * 60 * 1000;
const MAX_POS_PER_FILE = 80;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const NAV_CMDS = ['quickinfo', 'definitionAndBoundSpan', 'references'];

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	// Not --suppressDiagnosticEvents: geterr must emit diag events.
];

function log(line) {
	const s = typeof line === 'string' ? line : JSON.stringify(line);
	console.log(s);
	fs.appendFileSync(OUT_LOG, s + '\n');
}

function walkFiles(dir, exts, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules') continue;
			walkFiles(p, exts, out);
		} else if (exts.some((e) => ent.name.endsWith(e))) {
			out.push(p);
		}
	}
	return out;
}

function offsetToLineCol(text, off) {
	let line = 1;
	let col = 1;
	for (let i = 0; i < off; i++) {
		if (text[i] === '\n') {
			line++;
			col = 1;
		} else {
			col++;
		}
	}
	return { line, offset: col };
}

function samplePositions(text) {
	const offsets = [];
	IDENT_RE.lastIndex = 0;
	let m;
	while ((m = IDENT_RE.exec(text)) !== null) offsets.push(m.index);
	const n = offsets.length;
	if (n === 0) return [];
	if (n <= MAX_POS_PER_FILE) {
		return offsets.map((off) => ({ ...offsetToLineCol(text, off), off }));
	}
	const step = Math.ceil(n / MAX_POS_PER_FILE);
	const out = [];
	for (let i = 0; i < n; i += step) {
		const off = offsets[i];
		out.push({ ...offsetToLineCol(text, off), off });
	}
	return out;
}

// Repeat occurrences of one identifier in a file resolve to the same symbol
// for most samples, so probing every occurrence pays ~38% more units for
// near-duplicate answers. Keep the first sampled occurrence, plus every
// position the baseline records as divergent — the gate's known-discriminating
// set must never be sampled away. SIM_NAV_BASELINE points at the baseline JSON
// (needed when running from an isolated tools/ copy); default is the newest
// nav-results in the sibling test/baselines/.
function loadBaselineDiffPositions() {
	let file = process.env.SIM_NAV_BASELINE;
	if (!file) {
		const dir = path.join(toolsDir, '..', 'test', 'baselines');
		let best = null;
		try {
			for (const name of fs.readdirSync(dir)) {
				const m = /^nav-results-.+-t(\d+)\.json$/.exec(name);
				if (m && (!best || Number(m[1]) > best.t)) best = { t: Number(m[1]), name };
			}
		} catch {
			// no baselines dir — fall through with an empty keep-set
		}
		if (best) file = path.join(dir, best.name);
	}
	const keep = new Map(); // file -> Set<line:offset>
	if (!file) return keep;
	const base = JSON.parse(fs.readFileSync(file, 'utf8'));
	for (const d of [...(base.diffs ?? []), ...(base.docdiffs ?? [])]) {
		const m = /^nav:(.*):(\d+):(\d+):(\w+)$/.exec(d.key ?? '');
		if (!m) continue;
		// Legacy baselines embedded absolute paths; strip to the
		// test-workspace-relative form current keys use. The keep-set is
		// looked up by absolute file path.
		const rel = path.isAbsolute(m[1]) ? m[1].replace(/^.*test-workspace\//, '') : m[1];
		const abs = path.join(testWorkspacePath, rel);
		if (!keep.has(abs)) keep.set(abs, new Set());
		keep.get(abs).add(`${m[2]}:${m[3]}`);
	}
	return keep;
}

function dedupPositions(text, positions, keepLineCols) {
	const seen = new Set();
	return positions.filter((pos) => {
		const id = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(pos.off, pos.off + 64))?.[0] ?? '';
		const keep = !seen.has(id) || (keepLineCols?.has(`${pos.line}:${pos.offset}`) ?? false);
		seen.add(id);
		return keep;
	});
}

function collectFileSet() {
	const vue = walkFiles(testWorkspacePath, ['.vue']);
	const ts = [
		...walkFiles(path.join(testWorkspacePath, 'component-meta'), ['.ts']),
		...walkFiles(path.join(testWorkspacePath, 'tsconfigProject'), ['.ts']),
	];
	const files = [...vue, ...ts].sort((a, b) => a.localeCompare(b));
	const baselineKeep = loadBaselineDiffPositions();
	const entries = [];
	for (const file of files) {
		const content = fs.readFileSync(file, 'utf8');
		const positions = dedupPositions(content, samplePositions(content), baselineKeep.get(file));
		const rawIdents = [...content.matchAll(IDENT_RE)].length;
		entries.push({ file, rel: relPath(file), content, positions, rawIdents });
	}
	return entries;
}

/**
 * Canonicalize TypeScript lib .d.ts paths so TNB's shipped lib/ and stock's
 * package lib/ compare equal (RC4 path artifact). Only affects the compare key.
 */
function canonicalizeLocFile(file) {
	const f = String(file ?? '');
	const base = f.split(/[/\\]/).pop() || f;
	// Bundled lib files: lib.es2024.string.d.ts, lib.dom.d.ts, …
	if (/^lib\..+\.d\.ts$/i.test(base)) return `LIB:${base}`;
	return f;
}

function locKey(file, line, offset) {
	return `${canonicalizeLocFile(file)}|${line}|${offset}`;
}

function extractLocsFromDefs(body) {
	const defs = body?.definitions ?? body ?? [];
	if (!Array.isArray(defs)) return [];
	return defs.map((d) => ({
		file: String(d.file ?? ''),
		line: d.start?.line ?? d.contextStart?.line ?? 0,
		offset: d.start?.offset ?? d.contextStart?.offset ?? 0,
	}));
}

function extractLocsFromRefs(body) {
	const refs = body?.refs ?? [];
	if (!Array.isArray(refs)) return [];
	return refs.map((r) => ({
		file: String(r.file ?? ''),
		line: r.start?.line ?? 0,
		offset: r.start?.offset ?? 0,
	}));
}

function sortLocSet(locs) {
	return [...locs]
		.map((l) => locKey(l.file, l.line, l.offset))
		.sort((a, b) => a.localeCompare(b));
}

// Compare-only deduped set: sortLocSet keeps multiplicities, but VS Code/Volar
// consume location SETS — one side returning the same loc twice is not a
// product divergence. Archived snippets keep summary.locs (sorted multiset).
function dedupeLocSet(locs) {
	return [...new Set(locs.map((l) => locKey(l.file, l.line, l.offset)))].sort((a, b) =>
		a.localeCompare(b),
	);
}

function classifyLocSets(aSetArr, bSetArr) {
	const a = new Set(aSetArr);
	const b = new Set(bSetArr);
	const aSubB = [...a].every((v) => b.has(v));
	const bSubA = [...b].every((v) => a.has(v));
	if (aSubB && bSubA) return 'set-equal';
	if (aSubB) return 'missing';
	if (bSubA) return 'extra';
	return 'mixed';
}

function badTnbFile(filePath) {
	if (!filePath) return 'empty-file';
	if (filePath.startsWith('bundled://')) return 'bundled';
	if (filePath.includes('://') && !filePath.startsWith('file:')) return 'non-disk-scheme';
	const disk = filePath.startsWith('file://') ? filePath.slice('file://'.length) : filePath;
	if (!fs.existsSync(disk)) return 'missing-on-disk';
	return null;
}

function checkTnbLocs(locs) {
	for (const l of locs) {
		const reason = badTnbFile(l.file);
		if (reason) return { bad: true, reason, file: l.file };
	}
	return { bad: false };
}

function diagLocKey(d) {
	const start = d.start;
	const end = d.end;
	const s =
		typeof start === 'object'
			? `${start.line}:${start.offset}`
			: String(start ?? '');
	const e =
		typeof end === 'object'
			? `${end.line}:${end.offset}`
			: String(end ?? (typeof start === 'number' && typeof d.length === 'number' ? start + d.length : ''));
	return `${d.code}|${s}|${e}`;
}

function normalizeDiagSet(diagnostics) {
	const list = Array.isArray(diagnostics) ? diagnostics : [];
	return list
		.map((d) => ({
			key: diagLocKey(d),
			code: d.code,
			message: String(d.text ?? d.message ?? ''),
		}))
		.sort((a, b) => a.key.localeCompare(b.key));
}

function diagStructuralEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].key !== b[i].key) return false;
	}
	return true;
}

function diagMessageEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].message !== b[i].message) return false;
	}
	return true;
}

function truncate(obj, max = 2000) {
	const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
	if (s.length <= max) return s;
	return s.slice(0, max) + `…(+${s.length - max} chars)`;
}

function normalizeNavResult(cmd, resp, side) {
	const success = !!resp?.success;
	const body = resp?.body;
	let locs = [];
	if (cmd === 'definitionAndBoundSpan') locs = extractLocsFromDefs(body);
	else if (cmd === 'references') locs = extractLocsFromRefs(body);

	const summary = {
		success,
		message: resp?.message ? String(resp.message).split('\n')[0] : undefined,
	};

	if (cmd === 'quickinfo') {
		summary.displayString = body?.displayString ?? null;
		summary.kind = body?.kind ?? null;
		summary.documentation = body?.documentation ?? null;
		return {
			summary,
			locs: [],
			rawSnippet: truncate({
				success,
				displayString: summary.displayString,
				kind: summary.kind,
				documentation: summary.documentation,
			}),
		};
	}

	summary.locs = sortLocSet(locs);
	summary.locCmp = dedupeLocSet(locs);
	const tnbBad = side === 'TNB' ? checkTnbLocs(locs) : { bad: false };
	return {
		summary,
		locs,
		tnbBad,
		rawSnippet: truncate({ success, locs: summary.locs.slice(0, 40), message: summary.message }),
	};
}

function compareNav(cmd, tnbN, stockN) {
	if (tnbN?.error || stockN?.error) {
		return { kind: 'DIFF', detail: 'error/timeout', tnb: tnbN, stock: stockN };
	}
	if (tnbN.tnbBad?.bad) {
		return { kind: 'DIFF', detail: `tnb-bad-file:${tnbN.tnbBad.reason}`, tnb: tnbN, stock: stockN };
	}
	if (tnbN.summary.success !== stockN.summary.success) {
		return { kind: 'DIFF', detail: 'success-mismatch', tnb: tnbN, stock: stockN };
	}
	if (cmd === 'quickinfo') {
		const dsEq = tnbN.summary.displayString === stockN.summary.displayString;
		const kindEq = tnbN.summary.kind === stockN.summary.kind;
		const docEq =
			JSON.stringify(tnbN.summary.documentation) === JSON.stringify(stockN.summary.documentation);
		if (!dsEq || !kindEq) {
			return { kind: 'DIFF', detail: 'quickinfo-display/kind', tnb: tnbN, stock: stockN };
		}
		if (!docEq) {
			return { kind: 'DOC-DIFF', detail: 'documentation-only', tnb: tnbN, stock: stockN };
		}
		return { kind: 'MATCH', tnb: tnbN, stock: stockN };
	}
	const a = tnbN.summary.locCmp.join('\n');
	const b = stockN.summary.locCmp.join('\n');
	if (a === b) {
		const multEq = tnbN.summary.locs.join('\n') === stockN.summary.locs.join('\n');
		return { kind: 'MATCH', dedupeOnly: multEq ? undefined : true, tnb: tnbN, stock: stockN };
	}
	return {
		kind: 'DIFF',
		detail: 'loc-set-mismatch',
		locClass: classifyLocSets(tnbN.summary.locCmp, stockN.summary.locCmp),
		tnb: tnbN,
		stock: stockN,
	};
}

function compareDiag(tnbD, stockD) {
	if (tnbD?.error || stockD?.error) {
		return { kind: 'DIFF', detail: 'diag-error/timeout', tnb: tnbD, stock: stockD };
	}
	const tSets = {
		syntax: normalizeDiagSet(tnbD.syntax),
		semantic: normalizeDiagSet(tnbD.semantic),
		suggestion: normalizeDiagSet(tnbD.suggestion),
	};
	const sSets = {
		syntax: normalizeDiagSet(stockD.syntax),
		semantic: normalizeDiagSet(stockD.semantic),
		suggestion: normalizeDiagSet(stockD.suggestion),
	};
	const structOk =
		diagStructuralEqual(tSets.syntax, sSets.syntax) &&
		diagStructuralEqual(tSets.semantic, sSets.semantic) &&
		diagStructuralEqual(tSets.suggestion, sSets.suggestion);
	if (!structOk) {
		return {
			kind: 'DIFF',
			detail: 'diag-structure',
			tnb: tnbD,
			stock: stockD,
			tnbKeys: {
				syntax: tSets.syntax.map((x) => x.key),
				semantic: tSets.semantic.map((x) => x.key),
				suggestion: tSets.suggestion.map((x) => x.key),
			},
			stockKeys: {
				syntax: sSets.syntax.map((x) => x.key),
				semantic: sSets.semantic.map((x) => x.key),
				suggestion: sSets.suggestion.map((x) => x.key),
			},
		};
	}
	const msgOk =
		diagMessageEqual(tSets.syntax, sSets.syntax) &&
		diagMessageEqual(tSets.semantic, sSets.semantic) &&
		diagMessageEqual(tSets.suggestion, sSets.suggestion);
	if (!msgOk) {
		return { kind: 'DIAG-MSG-DIFF', detail: 'diag-message-only', tnb: tnbD, stock: stockD };
	}
	return { kind: 'MATCH', tnb: tnbD, stock: stockD };
}

function buildOps(entries) {
	const ops = [];
	for (const e of entries) {
		ops.push({ type: 'open', file: e.file, content: e.content });
		ops.push({ type: 'geterr', file: e.file, rel: e.rel, key: `diag:${e.rel}` });
		for (const pos of e.positions) {
			for (const cmd of NAV_CMDS) {
				ops.push({
					type: 'nav',
					file: e.file,
					rel: e.rel,
					line: pos.line,
					offset: pos.offset,
					cmd,
					key: `nav:${e.rel}:${pos.line}:${pos.offset}:${cmd}`,
				});
			}
		}
	}
	return ops;
}

function makeEventRouter(eventState) {
	return (ev) => {
		const w = eventState.waiter;
		if (!w) return;
		const eventName = ev?.event;
		if (eventName !== 'syntaxDiag' && eventName !== 'semanticDiag' && eventName !== 'suggestionDiag') {
			return;
		}
		if (ev?.body?.file !== w.file) return;
		const diags = ev?.body?.diagnostics ?? [];
		if (eventName === 'syntaxDiag') w.bucket.syntax = diags;
		if (eventName === 'semanticDiag') w.bucket.semantic = diags;
		if (eventName === 'suggestionDiag') w.bucket.suggestion = diags;
		if (w.bucket.syntax && w.bucket.semantic && w.bucket.suggestion) {
			const done = w;
			eventState.waiter = null;
			done.resolve({
				syntax: done.bucket.syntax,
				semantic: done.bucket.semantic,
				suggestion: done.bucket.suggestion,
			});
		}
	};
}

async function openFile(send, file, content, prevFile) {
	await send(
		'updateOpen',
		{
			changedFiles: [],
			closedFiles: prevFile && prevFile !== file ? [prevFile] : [],
			openFiles: [
				{
					file,
					fileContent: content,
					projectRootPath: testWorkspacePath,
				},
			],
		},
		CMD_TIMEOUT_MS,
	);
}

async function runGeterr(send, eventState, file) {
	const bucket = { syntax: null, semantic: null, suggestion: null };
	const diagPromise = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			if (eventState.waiter) eventState.waiter = null;
			reject(new Error(`geterr events timeout after ${CMD_TIMEOUT_MS}ms`));
		}, CMD_TIMEOUT_MS);
		eventState.waiter = {
			file,
			bucket,
			resolve: (v) => {
				clearTimeout(timer);
				resolve(v);
			},
		};
	});
	await send('geterr', { delay: 0, files: [file] }, CMD_TIMEOUT_MS);
	return diagPromise;
}

/**
 * Long session: one server, open one file at a time (close previous), identical
 * op sequence both sides. Timeout/crash → highest finding, restart, continue.
 */
async function runSide(label, tsserverPath, envExtra) {
	const results = new Map();
	const findings = [];
	let cursor = 0;
	const ops = globalThis.__navOps;
	const entryByFile = globalThis.__navEntryByFile;
	let stuckAt = -1;
	let stuckCount = 0;

	while (cursor < ops.length) {
		const eventState = { waiter: null };
		const onEvent = makeEventRouter(eventState);
		let openedFile = null;
		let sessionError = null;

		try {
			await withTsserver(
				{
					tsserverPath,
					args: harnessArgs,
					env: envExtra,
					deadlineMs: SESSION_DEADLINE_MS,
					onEvent,
				},
				async ({ send }) => {
					await send('configure', { preferences: {} }, CMD_TIMEOUT_MS);

					// Resume: open whatever file the next op needs.
					const needFile = ops[cursor]?.file;
					if (needFile && entryByFile.has(needFile)) {
						await openFile(send, needFile, entryByFile.get(needFile).content, null);
						openedFile = needFile;
						if (ops[cursor]?.type === 'open' && ops[cursor].file === needFile) {
							cursor++;
						}
					}

					while (cursor < ops.length) {
						const op = ops[cursor];
						try {
							if (op.type === 'open') {
								await openFile(send, op.file, op.content, openedFile);
								openedFile = op.file;
								cursor++;
								continue;
							}

							if (op.type === 'geterr') {
								const diags = await runGeterr(send, eventState, op.file);
								results.set(op.key, {
									type: 'geterr',
									file: op.file,
									...diags,
									rawSnippet: truncate({
										syntax: normalizeDiagSet(diags.syntax).map((x) => x.key),
										semantic: normalizeDiagSet(diags.semantic).map((x) => x.key),
										suggestion: normalizeDiagSet(diags.suggestion).map((x) => x.key),
									}),
								});
								cursor++;
								if (cursor % 200 === 0) log(`[${label}] progress ${cursor}/${ops.length}`);
								continue;
							}

							if (op.type === 'nav') {
								const args = { file: op.file, line: op.line, offset: op.offset };
								const resp = await send(op.cmd, args, CMD_TIMEOUT_MS);
								const norm = normalizeNavResult(op.cmd, resp, label);
								results.set(op.key, {
									type: 'nav',
									file: op.file,
									line: op.line,
									offset: op.offset,
									cmd: op.cmd,
									...norm,
								});
								cursor++;
								if (cursor % 500 === 0) log(`[${label}] progress ${cursor}/${ops.length}`);
								continue;
							}

							cursor++;
						} catch (err) {
							const msg = err?.message ?? String(err);
							const isTimeout = /timeout/i.test(msg);
							findings.push({
								level: 'HIGHEST',
								side: label,
								op: {
									type: op.type,
									file: op.file,
									line: op.line,
									offset: op.offset,
									cmd: op.cmd,
									key: op.key,
								},
								reason: isTimeout ? 'TIMEOUT' : 'CRASH_OR_ERROR',
								message: msg,
							});
							if (op.key) {
								results.set(op.key, {
									type: op.type,
									file: op.file,
									line: op.line,
									offset: op.offset,
									cmd: op.cmd,
									error: msg,
									rawSnippet: truncate({ error: msg }),
								});
							}
							cursor++;
							sessionError = Object.assign(new Error('RESTART_SIDE'), {
								restart: true,
								cause: err,
							});
							throw sessionError;
						}
					}
				},
			);
		} catch (err) {
			if (err?.restart || err?.message === 'RESTART_SIDE') {
				log(
					`[${label}] restart after finding at cursor=${cursor}: ${err?.cause?.message ?? err.message}`,
				);
			} else {
				log(`[${label}] session error at cursor=${cursor}: ${err?.message ?? err}`);
				findings.push({
					level: 'HIGHEST',
					side: label,
					op: ops[cursor],
					reason: 'SESSION_ERROR',
					message: err?.message ?? String(err),
				});
				// Advance past a stuck open if session can't even start.
				if (ops[cursor]?.type === 'open') {
					cursor++;
				} else if (ops[cursor]?.key && !results.has(ops[cursor].key)) {
					results.set(ops[cursor].key, {
						type: ops[cursor].type,
						file: ops[cursor].file,
						line: ops[cursor].line,
						offset: ops[cursor].offset,
						cmd: ops[cursor].cmd,
						error: err?.message ?? String(err),
						rawSnippet: truncate({ error: err?.message ?? String(err) }),
					});
					cursor++;
				}
			}

			if (cursor === stuckAt) {
				stuckCount++;
				if (stuckCount >= 5) {
					log(`[${label}] stuck at cursor=${cursor}; force-skip`);
					if (ops[cursor]?.key && !results.has(ops[cursor].key)) {
						results.set(ops[cursor].key, {
							type: ops[cursor].type,
							file: ops[cursor].file,
							error: 'stuck-skip',
							rawSnippet: '{"error":"stuck-skip"}',
						});
					}
					cursor++;
					stuckCount = 0;
					stuckAt = -1;
				}
			} else {
				stuckAt = cursor;
				stuckCount = 1;
			}
			continue;
		}
		break;
	}

	return { results, findings };
}

/**
 * Classify replay, grouped by file: one fresh session per (side, file) runs
 * all of that file's diff ops in sequence, instead of a fresh boot per op
 * (1172 ops share 255 files — per-op boots dominated the shard wall).
 * Semantics: the fresh-boot-per-op gold standard weakens to per-file
 * isolation; seqClass stays informational triage metadata — the baseline
 * gate compares divergence KEYS only, so verdicts are unaffected.
 */
async function replayGroup(label, tsserverPath, envExtra, file, ops) {
	const eventState = { waiter: null };
	const onEvent = makeEventRouter(eventState);
	const entry = globalThis.__navEntryByFile.get(file);
	const out = new Map();

	return withTsserver(
		{
			tsserverPath,
			args: harnessArgs,
			env: envExtra,
			deadlineMs: 120_000 + ops.length * 10_000,
			onEvent,
		},
		async ({ send }) => {
			await send('configure', { preferences: {} }, CMD_TIMEOUT_MS);
			await openFile(send, file, entry.content, null);

			for (const op of ops) {
				try {
					if (op.type === 'geterr' || (op.key && String(op.key).startsWith('diag:'))) {
						const diags = await runGeterr(send, eventState, op.file);
						out.set(op.key, {
							type: 'geterr',
							file: op.file,
							...diags,
							rawSnippet: truncate({
								syntax: normalizeDiagSet(diags.syntax).map((x) => x.key),
								semantic: normalizeDiagSet(diags.semantic).map((x) => x.key),
								suggestion: normalizeDiagSet(diags.suggestion).map((x) => x.key),
							}),
						});
						continue;
					}
					const args = { file: op.file, line: op.line, offset: op.offset };
					const resp = await send(op.cmd, args, CMD_TIMEOUT_MS);
					const norm = normalizeNavResult(op.cmd, resp, label);
					out.set(op.key, {
						type: 'nav',
						file: op.file,
						line: op.line,
						offset: op.offset,
						cmd: op.cmd,
						...norm,
					});
				} catch (err) {
					out.set(op.key, { error: err?.message ?? String(err), rawSnippet: truncate({ error: err?.message ?? String(err) }) });
				}
			}
			return out;
		},
	);
}

// ---------- main ----------
fs.writeFileSync(OUT_LOG, '');
fs.writeFileSync(THROW_FILE, '');

const allEntries = collectFileSet();
// An empty corpus means the volar checkout didn't resolve (e.g. VOLAR_ROOT
// unset from an isolated tools copy) — a zero-unit run merges into a hollow
// green, so die here instead.
if (allEntries.length === 0) {
	console.error(`sim-nav: corpus is empty — volar test-workspace not found at ${testWorkspacePath} (set VOLAR_ROOT)`);
	process.exit(1);
}
// Interleaved sharding: files are sorted by collectFileSet, so index-mod gives each
// shard a deterministic, size-mixed disjoint subset.
const entries = allEntries.filter((_, i) => i % SHARD_COUNT === SHARD_INDEX);
globalThis.__navEntryByFile = new Map(entries.map((e) => [e.file, e]));
const ops = buildOps(entries);
globalThis.__navOps = ops;

const compareKeys = ops.filter((o) => o.type === 'geterr' || o.type === 'nav').map((o) => o.key);

log(`shard=${SHARD_INDEX}/${SHARD_COUNT} files=${entries.length}/${allEntries.length} ops=${ops.length} compareUnits=${compareKeys.length}`);
log(`positions_sum=${entries.reduce((s, e) => s + e.positions.length, 0)}`);

const tnbEnv = tnbHarnessEnv({
	TNB_TRACE_THROW: '1',
	TNB_TRACE_THROW_FILE: THROW_FILE,
});

// TNB and STOCK drive independent tsserver processes; the harness lock is
// reentrant within this process, so run both sides concurrently.
log('=== TNB + STOCK long sessions (concurrent) ===');
const [tnbRun, stockRun] = await Promise.all([
	runSide('TNB', tnbPath, tnbEnv),
	runSide('STOCK', stockPath, {}),
]);
log(`TNB done results=${tnbRun.results.size} findings=${tnbRun.findings.length}`);
log(`STOCK done results=${stockRun.results.size} findings=${stockRun.findings.length}`);

let match = 0;
let diff = 0;
let docdiff = 0;
let diagmsg = 0;
let skip = 0;
const skipReasons = {};
const diffs = [];
const docdiffs = [];
const diagmsgs = [];
const dedupeRescued = [];

function bumpSkip(reason) {
	skip++;
	skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
}

for (const key of compareKeys) {
	const t = tnbRun.results.get(key);
	const s = stockRun.results.get(key);
	if (!t || !s) {
		bumpSkip(!t && !s ? 'missing-both' : !t ? 'missing-tnb' : 'missing-stock');
		continue;
	}

	const isDiag = key.startsWith('diag:');
	const cmp = isDiag ? compareDiag(t, s) : compareNav(t.cmd, t, s);

	if (cmp.kind === 'MATCH') {
		match++;
		if (cmp.dedupeOnly) dedupeRescued.push(key);
	}
	else if (cmp.kind === 'DOC-DIFF') {
		docdiff++;
		docdiffs.push({ key, ...cmp });
	} else if (cmp.kind === 'DIAG-MSG-DIFF') {
		diagmsg++;
		diagmsgs.push({ key, ...cmp });
	} else {
		diff++;
		const op = ops.find((o) => o.key === key) ?? {
			type: isDiag ? 'geterr' : 'nav',
			file: t.file,
			line: t.line,
			offset: t.offset,
			cmd: t.cmd,
			key,
		};
		diffs.push({ key, op, ...cmp });
	}
}

log(`pre-classify SUMMARY match=${match} diff=${diff} docdiff=${docdiff} diagmsg=${diagmsg} skip=${skip}`);

// SIM_NAV_SKIP_CLASSIFY=1: stop after pre-classify SUMMARY (FACTS: classify
// replay has stalled/SDK-disconnected three consecutive rounds). Diffs are
// written without seqClass/replay.
const skipClassify = process.env.SIM_NAV_SKIP_CLASSIFY === '1' || process.env.SIM_NAV_SKIP_CLASSIFY === 'true';
if (skipClassify) {
	log(`SIM_NAV_SKIP_CLASSIFY=1 — skipping classify replay (${diffs.length} diffs unclassified)`);
} else {
	// Group replays by file (see replayGroup): 1172 ops share 255 files.
	const replaysByFile = new Map();
	for (const d of diffs) {
		const f = d.op?.file ?? d.file;
		if (!replaysByFile.has(f)) replaysByFile.set(f, []);
		replaysByFile.get(f).push(d);
	}
	let replayDone = 0;
	for (const [file, group] of replaysByFile) {
		log(`replay ${replayDone + 1}-${replayDone + group.length}/${diffs.length} ${file} (${group.length} ops)`);
		replayDone += group.length;
		let tnbMap;
		let stockMap;
		let bootErr = null;
		try {
			[tnbMap, stockMap] = await Promise.all([
				replayGroup('TNB', tnbPath, tnbEnv, file, group.map((d) => d.op)),
				replayGroup('STOCK', stockPath, {}, file, group.map((d) => d.op)),
			]);
		} catch (err) {
			bootErr = err?.message ?? String(err);
		}
		for (const d of group) {
			if (bootErr) {
				d.seqClass = 'ALWAYS';
				d.replay = { error: bootErr };
				continue;
			}
			try {
				const tnbR = tnbMap?.get(d.key);
				const stockR = stockMap?.get(d.key);
				const isDiag = d.key.startsWith('diag:');
				const replayCmp = isDiag ? compareDiag(tnbR, stockR) : compareNav(d.op.cmd, tnbR, stockR);
				d.seqClass = replayCmp.kind === 'MATCH' ? 'SEQ-ONLY' : 'ALWAYS';
				d.replay = {
					tnb: tnbR?.rawSnippet ?? truncate(tnbR),
					stock: stockR?.rawSnippet ?? truncate(stockR),
					replayKind: replayCmp.kind,
					replayDetail: replayCmp.detail,
				};
			} catch (err) {
				d.seqClass = 'ALWAYS';
				d.replay = { error: err?.message ?? String(err) };
			}
		}
	}
}

const total = match + diff + docdiff + diagmsg + skip;
const summaryLine = `SUMMARY total=${total} match=${match} diff=${diff} docdiff=${docdiff} diagmsg=${diagmsg} skip=${skip}`;
log(summaryLine);
log(`CONSERVED=${total === compareKeys.length} expected=${compareKeys.length}`);
log(`skipReasons=${JSON.stringify(skipReasons)}`);

const fileTable = entries.map((e) => ({
	file: path.relative(testWorkspacePath, e.file),
	abs: e.file,
	rawIdents: e.rawIdents,
	positions: e.positions.length,
}));

const payload = {
	summaryLine,
	total,
	match,
	diff,
	docdiff,
	diagmsg,
	skip,
	skipReasons,
	compareKeys: compareKeys.length,
	dedupeRescued,
	files: fileTable,
	positionsSum: fileTable.reduce((s, r) => s + r.positions, 0),
	navCmdCount: fileTable.reduce((s, r) => s + r.positions, 0) * 4,
	diagUnitCount: fileTable.length,
	findings: [...tnbRun.findings, ...stockRun.findings],
	diffs: diffs.map((d) => ({
		key: d.key,
		file: d.op?.rel,
		line: d.op?.line,
		offset: d.op?.offset,
		cmd: d.key.startsWith('diag:') ? 'geterr' : d.op?.cmd,
		detail: d.detail,
		locClass: d.locClass,
		seqClass: d.seqClass,
		tnb: d.tnb?.rawSnippet ?? truncate(d.tnb),
		stock: d.stock?.rawSnippet ?? truncate(d.stock),
		replay: d.replay,
		tnbKeys: d.tnbKeys,
		stockKeys: d.stockKeys,
	})),
	docdiffs: docdiffs.map((d) => ({
		key: d.key,
		tnb: d.tnb?.rawSnippet,
		stock: d.stock?.rawSnippet,
	})),
	diagmsgs: diagmsgs.map((d) => ({
		key: d.key,
		tnb: d.tnb?.rawSnippet,
		stock: d.stock?.rawSnippet,
	})),
	throwsFile: THROW_FILE,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
log(`wrote ${OUT_JSON}`);
console.log(summaryLine);
process.exit(0);
