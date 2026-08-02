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
// Balance (run 30752526338: 3 groups / 273s, old group3 with 33 witnesses was the
// long tail): old groups 1-2 are split across all five non-sweep groups, old
// group3 is quartered with its heavies (checker-differential, type-field-audit,
// bridge-thread-race, parent-watch-acceptance, rpcsym-adversarial) spread one per
// group. Rebalance by moving names between lists; `all` fails on duplicates,
// missing tools/<name>.mjs, or a drifted TOTAL.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOTAL = 53;

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
			'triage-diag-determinism',
			'triage-exit-codes',
			'triage-f2hl-jsdoc',
			'triage-rpcsym-adversarial',
			'triage-incremental-emit',
			'triage-win-drive-overlay',
			'triage-backslash-getsourcefile',
			'triage-worker-libpath',
			'triage-jsdoc-assignment',
			'triage-alias-self-loop',
		],
	},
	{
		witnesses: [
			'triage-program-info',
			'triage-sim-edit',
			'triage-adv6b-generic-sig',
			'triage-checker-differential',
			'triage-eslint-typeref-target',
			'triage-cli-only-flags',
			'triage-semantic-defaultlib',
			'triage-emit-declaration-only',
			'triage-imported-extra-extension',
			'triage-alias-nil',
		],
	},
	{
		witnesses: [
			'triage-completion-parity',
			'triage-sim-xfile',
			'triage-geterr-5823',
			'triage-type-field-audit',
			'triage-tp-constraint',
			'triage-bool-literal-intrinsic',
			'triage-builder-keyform',
			'triage-prefetch-inferred',
			'triage-ghost-close',
			'triage-empty-literal',
		],
	},
	{
		witnesses: [
			'triage-xrefs-diag-variants',
			'triage-f2r6-xvue',
			'triage-f2r6-libref',
			'triage-bridge-thread-race',
			'triage-f2hl-augment',
			'triage-orphan-leak',
			'triage-f2hl-defaultkw',
			'triage-adv6a-jsx-spelling',
			'check-readme-ledger',
			'triage-overlay-delta-sync',
		],
	},
	{
		witnesses: [
			'triage-f2qi-names',
			'triage-tostring-gtd-vue',
			'triage-f2r5-defcases',
			'triage-f2r6-samevue',
			'triage-f2hl-typesref',
			'triage-completion-details-array',
			'triage-parent-watch-acceptance',
			'triage-qi-delete-min',
			'triage-defineprops-refs',
			'triage-impl-kind',
			'triage-rpcsym-nameless',
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
}
