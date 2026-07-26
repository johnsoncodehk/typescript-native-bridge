#!/usr/bin/env node
/**
 * README ledger gate (AGENTS.md: "Every TNB change to tsgo behavior is
 * listed in the README, and the list is gate-enforced against the patch
 * contents").
 *
 * Mechanism (annotation-driven, by design — heuristic behavior-hunk
 * detection was too noisy to gate on):
 *   1. A patch hunk that changes tsgo behavior must carry a
 *      `Ledger(<key>)` comment at the change site.
 *   2. The README's "Behavior and differences from tsgo" table keys each
 *      row by the first `backticked` identifier of its first cell.
 * The gate fails on either direction of drift:
 *   - a Ledger(<key>) annotation with no matching README row;
 *   - a README row key with no Ledger(<key>) annotation in patches/.
 * A row whose stopgap gets removed disappears from the table; the gate then
 * demands the annotation die with it (and vice versa).
 *
 * Usage: node tools/check-readme-ledger.mjs
 * Exit: 0 = ledger and patches agree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

// ── README behavior-table row keys ─────────────────────────────────────────
const section = readme.split(/^## Behavior and differences from tsgo$/m)[1];
if (!section) {
	console.error('FAIL: README section "Behavior and differences from tsgo" not found');
	process.exit(1);
}
const tableText = section.split(/^## /m)[0];
const rowKeys = new Set();
for (const line of tableText.split('\n')) {
	if (!line.startsWith('|') || /^\|\s*(-+|Change\s*\|)/.test(line)) continue;
	const firstCell = line.split('|')[1] ?? '';
	const key = /`([^`]+)`/.exec(firstCell)?.[1];
	if (key) rowKeys.add(key);
}
if (rowKeys.size === 0) {
	console.error('FAIL: no keyed rows found in the README behavior table');
	process.exit(1);
}

// ── Ledger annotations in patches (patch files + overlay) ──────────────────
const annotated = new Map(); // key -> file
function scanFile(file) {
	const text = fs.readFileSync(file, 'utf8');
	for (const m of text.matchAll(/Ledger\(([^)]+)\)/g)) {
		annotated.set(m[1], path.relative(repoRoot, file));
	}
}
function walk(dir) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(p);
		else scanFile(p);
	}
}
walk(path.join(repoRoot, 'patches'));

let bad = 0;
for (const [key, file] of annotated) {
	if (!rowKeys.has(key)) {
		bad++;
		console.error(`FAIL: Ledger(${key}) at ${file} has no README behavior-table row — list it or remove the stopgap`);
	}
}
for (const key of rowKeys) {
	if (!annotated.has(key)) {
		bad++;
		console.error(`FAIL: README behavior-table row \`${key}\` has no Ledger(${key}) annotation in patches/ — annotate the change site or drop the row`);
	}
}
for (const key of rowKeys) {
	if (annotated.has(key)) console.log(`ok ${key} — row ↔ ${annotated.get(key)}`);
}
console.log(bad === 0 ? `VERDICT: PASS (${rowKeys.size} rows)` : 'VERDICT: FAIL');
process.exit(bad === 0 ? 0 : 1);
