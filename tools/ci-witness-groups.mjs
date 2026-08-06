#!/usr/bin/env node
// Single source of truth for the CI witness matrix (.github/workflows/ci.yml).
//
//   node tools/ci-witness-groups.mjs matrix   # compact JSON {"include":[...]} for the prepare job
//   node tools/ci-witness-groups.mjs <index>  # space-separated witness names of one group
//   node tools/ci-witness-groups.mjs all      # human-readable table (default)
//
// Group 0 carries the sweep flag: sweep-ls-throws must regenerate
// /tmp/tnb-sweep-fixtures on the same runner before triage-quickinfo-emptyparity
// and triage-refs-exportspec read it (/tmp is per-runner, so they must share a job).
//
// Balance (measured on run 30756640008 — the agent-estimated "heavies"
// checker-differential / type-field-audit / bridge-thread-race /
// parent-watch-acceptance / rpcsym-adversarial all run ≤1s; the real cost is
// nine ~49-70s witnesses): each of wg1-wg4 carries two heavies (~126-131s),
// wg5 carries the ninth plus all ≤11s witnesses (~125s). Rebalance by moving
// names between lists; `all` validates the full table (below).
//
// 2026-08-03 convergence audit: 14 witnesses wired (13 in the audit, plus
// triage-nuxtui-exportstar 2026-08-04 — unblocked by the bin symlink the
// witnesses job now creates). The batch triages
// triage-typeq-batch (~69s) and triage-spellnb-batch (~65s) form wg6 (same
// two-heavies shape as wg1-wg4); twelve ≤11s witnesses joined wg5 (~140s).
// Witnesses intentionally NOT in the matrix are local-only — the machine-
// readable list lives in LOCAL_ONLY below (reasons: framework-checks /
// external-edits need the /tmp/tnb-fw-fixtures installs (network;
// framework-checks populates them, external-edits' estree mode reads them);
// generation-retention needs in-child GC marks + --stock-tsserver slope
// calibration; napi-fuzz is a NAPI payload fuzz probe; the perf series is
// measurement, not pass/fail). triage-electron-abi / triage-sim-nav-shard
// are wired outside the matrix — OWNED_ELSEWHERE below (electron-abi:
// direct ci.yml build-job step + nightly test-bridge-win32; sim-nav-shard:
// the sim-nav gate's shard runner). `all` fails on duplicates, missing
// tools/<name>.mjs, a drifted TOTAL, an orphan triage-*.mjs (no group, not
// LOCAL_ONLY, not OWNED_ELSEWHERE), a LOCAL_ONLY/OWNED_ELSEWHERE name
// without its file, or a tools/baselines/triage-<name>.json whose witness
// is not wired.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOTAL = 71;

// Witnesses intentionally NOT in the matrix — run on demand (reasons above).
const LOCAL_ONLY = [
	'triage-framework-checks',
	'triage-external-edits',
	'triage-generation-retention',
	'triage-napi-fuzz',
	'triage-completion-latency',
	'triage-postedit-latency',
	'triage-perf-edit-rpc',
	'triage-perf-qi-rpc',
	'triage-typing-cpuprof',
];

// triage-*.mjs wired outside the witness matrix, owned by other gates (above):
//   triage-electron-abi  — direct step in ci.yml build job + nightly test-bridge-win32
//   triage-sim-nav-shard — the sim-nav gate's shard runner (check:sim-nav)
const OWNED_ELSEWHERE = [
	'triage-electron-abi',
	'triage-sim-nav-shard',
];

const groups = [
	{
		sweep: true,
		witnesses: [
			'triage-quickinfo-emptyparity',
			'triage-refs-exportspec',
		],
	},
	{
		witnesses: [
			'triage-f2qi-names', // ~70s
			'triage-adv6b-generic-sig', // ~61s
		],
	},
	{
		witnesses: [
			'triage-f2r6-libref', // ~67s
			'triage-adv6a-jsx-spelling', // ~61s
		],
	},
	{
		witnesses: [
			'triage-f2r5-defcases', // ~67s
			'triage-tostring-gtd-vue', // ~61s
		],
	},
	{
		witnesses: [
			'triage-qi-delete-min', // ~65s
			'triage-f2r6-xvue', // ~62s
		],
	},
	{
		witnesses: [
			'triage-sim-edit', // ~49s; everything below ≤11s
			'triage-cli-only-flags',
			'triage-f2hl-augment',
			'triage-sim-xfile',
			'triage-xrefs-diag-variants',
			'triage-f2r6-samevue',
			'triage-completion-parity',
			'triage-f2hl-jsdoc',
			'triage-diag-determinism',
			'triage-orphan-leak',
			'triage-exit-codes',
			'triage-f2hl-typesref',
			'triage-f2hl-defaultkw',
			'triage-geterr-5823',
			'triage-defineprops-refs',
			'triage-program-info',
			'triage-ghost-close',
			'triage-rpcsym-adversarial',
			'triage-checker-differential',
			'triage-type-field-audit',
			'triage-arena-parity',
			'triage-worker-libpath',
			'triage-parent-watch-acceptance',
			'triage-impl-kind',
			'triage-imported-extra-extension',
			'triage-eslint-typeref-target',
			'triage-semantic-defaultlib',
			'triage-emit-declaration-only',
			'triage-tp-constraint',
			'triage-bool-literal-intrinsic',
			'triage-bridge-thread-race',
			'triage-backslash-getsourcefile',
			'triage-jsdoc-assignment',
			'triage-builder-keyform',
			'triage-incremental-emit',
			'triage-win-drive-overlay',
			'triage-prefetch-inferred',
			'check-readme-ledger',
			'triage-overlay-delta-sync',
			'triage-completion-details-array',
			'triage-local-autoimport-details',
			'triage-alias-self-loop',
			'triage-alias-nil',
			'triage-empty-literal',
			'triage-rpcsym-nameless',
			// 2026-08-03 convergence audit: eleven ≤11s witnesses wired.
			'triage-ambient-order', // ~0s
			'triage-custom-transformers', // ~0s
			'triage-lazy-accessor-retry', // ~0s
			'triage-symbol-global-exports', // ~0s
			'triage-computed-literal', // ~1s
			'triage-crossgen-reuse', // ~1s
			'triage-display-tokens', // ~1s
			'triage-lsnav-parity', // ~1s
			'triage-node-modules-sfc', // ~1s
			'triage-issue5-contextual-def', // ~3s
			'triage-idle-drain', // ~7s
			'triage-nuxtui-exportstar', // ~0s
			'triage-completion-span-i55', // ~6s (npm install @types/node best-effort + tsserver session)
			'triage-prototype-refresh', // ~1s
		],
	},
	{
		witnesses: [
			'triage-typeq-batch', // ~69s
			'triage-spellnb-batch', // ~65s
		],
	},
];

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const flat = groups.flatMap(g => g.witnesses);
const dupes = flat.filter((w, i) => flat.indexOf(w) !== i);
const missing = flat.filter(w => !fs.existsSync(path.join(toolsDir, `${w}.mjs`)));
if (dupes.length || missing.length || flat.length !== TOTAL) {
	if (dupes.length) console.error(`duplicate witnesses: ${[...new Set(dupes)].join(', ')}`);
	if (missing.length) console.error(`no tools/<name>.mjs for: ${missing.join(', ')}`);
	if (flat.length !== TOTAL) console.error(`witness count ${flat.length} != TOTAL ${TOTAL} — update the table and TOTAL together`);
	process.exit(1);
}

const arg = process.argv[2];
if (arg === 'matrix') {
	process.stdout.write(JSON.stringify({
		include: groups.map((g, index) => ({
			index,
			...(g.sweep ? { sweep: true } : {}),
			witnesses: g.witnesses.join(' '),
		})),
	}));
} else if (arg !== undefined && arg !== 'all') {
	const index = Number(arg);
	if (!Number.isInteger(index) || !groups[index]) {
		console.error(`no group at index ${JSON.stringify(arg)} (0..${groups.length - 1})`);
		process.exit(1);
	}
	process.stdout.write(groups[index].witnesses.join(' ') + '\n');
} else {
	groups.forEach((g, index) => {
		console.log(`group ${index}${g.sweep ? ' (sweep-ls-throws first)' : ''} — ${g.witnesses.length} witnesses`);
		for (const w of g.witnesses) console.log(`  ${w}`);
	});
	console.log(`total: ${flat.length} witnesses in ${groups.length} groups`);

	// Orphan sweep: every tools/triage-*.mjs must be in a group, LOCAL_ONLY,
	// or OWNED_ELSEWHERE. LOCAL_ONLY/OWNED_ELSEWHERE names must exist on
	// disk. tools/baselines/triage-<name>.json must map to a wired witness
	// (reverse direction — a group witness without a baseline — is fine).
	const errors = [];
	const onDisk = fs.readdirSync(toolsDir)
		.filter(f => f.startsWith('triage-') && f.endsWith('.mjs'))
		.map(f => f.slice(0, -'.mjs'.length));
	const accounted = new Set([...flat, ...LOCAL_ONLY, ...OWNED_ELSEWHERE]);
	const orphans = onDisk.filter(w => !accounted.has(w));
	if (orphans.length) {
		errors.push(`orphan triage-*.mjs (no group, not local-only, not owned elsewhere): ${orphans.join(', ')}`);
	}
	const missingLocal = [...LOCAL_ONLY, ...OWNED_ELSEWHERE].filter(w => !fs.existsSync(path.join(toolsDir, `${w}.mjs`)));
	if (missingLocal.length) {
		errors.push(`no tools/<name>.mjs for: ${missingLocal.join(', ')}`);
	}
	const baselineDir = path.join(toolsDir, 'baselines');
	if (fs.existsSync(baselineDir)) {
		const groupSet = new Set(flat);
		const unwired = fs.readdirSync(baselineDir)
			.filter(f => f.endsWith('.json') && f.startsWith('triage-'))
			.map(f => f.slice(0, -'.json'.length))
			.filter(w => !groupSet.has(w));
		if (unwired.length) {
			errors.push(`baseline json without a wired witness: ${unwired.map(w => `${w}.json`).join(', ')}`);
		}
	}

	if (errors.length) {
		for (const e of errors) console.error(e);
		process.exit(1);
	}
	console.log(`local-only (${LOCAL_ONLY.length}) and owned-elsewhere (${OWNED_ELSEWHERE.length}) files all present; ${onDisk.length} triage-*.mjs accounted, no orphans; baselines all wired`);
}
