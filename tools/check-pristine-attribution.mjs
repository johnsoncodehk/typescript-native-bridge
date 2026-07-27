#!/usr/bin/env node
/**
 * pristine-tsgo attribution gate, dual-side (v5): proves that every stopgap
 * TNB carries is (a) still WORKING on the patched tree and (b) still NEEDED
 * because pristine upstream tsgo has not fixed the behavior.
 *
 * Per entry, one of four quadrants:
 *   OK               patched=PASS  pristine=FAIL  — stopgap alive, upstream open
 *   STOPGAP-BROKEN   patched=FAIL                  — the stopgap rotted; gate fails
 *   UPSTREAM-FIXED   pristine=PASS                 — remove the stopgap, its README
 *                                                    ledger row, and this repro
 *   (both pass is unreachable: a test can't assert the bug on one side and not
 *    the other without one of the two above firing first)
 *
 * ARCHIVAL entries have no stopgap (reverted — the behavior is pristine
 * tsgo's by policy): only the pristine FAIL assertion remains, so an
 * upstream fix surfaces as CLOSABLE and the leftover registrations
 * (volar filter lines, baselines, KNOWN entries) get cleaned up.
 *
 * Patched-side runner: inject the repro test into the patched submodule and
 * `go test` (the stopgap lives in the Go patches, e.g. #30's checker arm).
 *
 * Usage: node tools/check-pristine-attribution.mjs
 * Env:   TNB_PRISTINE_CACHE — clone cache dir (default /tmp/tnb-pristine-tsgo)
 * Exit:  0 = every entry in its expected quadrant.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const submodule = path.join(repoRoot, 'typescript-go');
const cache = process.env.TNB_PRISTINE_CACHE ?? '/tmp/tnb-pristine-tsgo';
const UPSTREAM = 'https://github.com/microsoft/typescript-go.git';

// ── Dual-side entries (a stopgap exists and must stay alive) ───────────────
// NOTE: getExportsOfModule was removed — its "stopgap" premise was wrong.
// Stock 6.0.3 returns the same raw table as pristine tsgo for class export=
// ([prototype]) and namespace export= ([foo, bar]); 5a45799's host-table
// guard is bridge-contract parity, not a tsgo-behavior stopgap. (Verified
// against stock typescript.js + pristine tsgo, 2026-07-27.)
const DUAL = [
	{
		key: 'getTypeFromTypeNodeWorker',
		branch: 'repro/type-position-entity-reads-any',
		file: 'internal/checker/zz_repro_type_position_entity_test.go',
		pkg: './internal/checker/',
		test: 'TestTypePositionEntityInIndexedAccess',
		signature: /resolved to any/,
	},
];

// ── Archival entries (no stopgap: reverted to pristine behavior by policy) ──
const ARCHIVAL = [
	{
		branch: 'repro/far-module-specifier-context',
		file: 'internal/ls/zz_repro_far_context_test.go',
		pkg: './internal/ls/',
		test: 'TestModuleSpecifierContextNode',
		signature: /= nil/,
		note: 'reverted in 1234c83 — pristine behavior kept, upstream issue F3',
	},
	{
		branch: 'repro/unused-type-param-diagnostic-code',
		file: 'internal/checker/zz_repro_unused_type_param_test.go',
		pkg: './internal/checker/',
		test: 'TestUnusedTypeParameterDiagnosticCode',
		signature: /TS6196/,
		note: 'reverted in 1234c83 — pristine behavior kept, upstream issue F4',
	},
];

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitOk = (cwd, args) => {
	try { return git(cwd, args); }
	catch { return ''; }
};

function runGoTest(cwd, r) {
	let out = '';
	let code = 0;
	try {
		out = execFileSync('go', ['test', r.pkg, '-run', `^${r.test}$`, '-count=1', '-v'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (e) {
		code = e.status ?? 1;
		out = (e.stdout ?? '') + (e.stderr ?? '');
	}
	return { pass: code === 0, out };
}

// ── Pristine clone (pin-verified) ──────────────────────────────────────────
// git describe tolerates failure: shallow submodule checkouts (CI fetch-depth
// 1) carry no tag refs, so the tag form may be unavailable — fall back to SHA.
let pin = gitOk(submodule, ['describe', '--tags', '--exact-match', 'HEAD']);
let pinIsTag = true;
if (!pin) {
	pin = git(submodule, ['rev-parse', 'HEAD']);
	pinIsTag = false;
}
console.log(`pin: ${pin} (${pinIsTag ? 'tag' : 'commit'})`);

if (fs.existsSync(path.join(cache, '.git'))) {
	const head = git(cache, ['rev-parse', 'HEAD']);
	const want = pinIsTag ? git(cache, ['rev-list', '-n', '1', `tags/${pin}`]) : pin;
	if (head !== want) {
		console.log(`cache drift (head=${head.slice(0, 9)} want=${want.slice(0, 9)}) — re-cloning`);
		fs.rmSync(cache, { recursive: true, force: true });
	}
}
if (!fs.existsSync(path.join(cache, '.git'))) {
	console.log(`cloning pristine ${UPSTREAM} @ ${pin} …`);
	if (pinIsTag) {
		execFileSync('git', ['clone', '--depth', '1', '--branch', pin, UPSTREAM, cache], { stdio: 'inherit' });
	} else {
		execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', UPSTREAM, cache], { stdio: 'inherit' });
		execFileSync('git', ['checkout', pin], { cwd: cache, stdio: 'inherit' });
	}
}

let bad = 0;
const injectedPristine = [];
const injectedPatched = [];
try {
	// Pristine proof: no injected file may already exist upstream.
	for (const r of [...DUAL, ...ARCHIVAL]) {
		if (fs.existsSync(path.join(cache, r.file))) {
			console.error(`FAIL: ${r.file} exists in the pristine clone — cache is not pristine`);
			process.exit(1);
		}
		const src = git(submodule, ['show', `${r.branch}:${r.file}`]);
		const dest = path.join(cache, r.file);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, src);
		injectedPristine.push(dest);
	}

	// ── Dual-side: patched PASS + pristine FAIL ──────────────────────────────
	for (const r of DUAL) {
		const src = git(submodule, ['show', `${r.branch}:${r.file}`]);
		const dest = path.join(submodule, r.file);
		fs.writeFileSync(dest, src);
		injectedPatched.push(dest);
		const patched = runGoTest(submodule, r);
		const pristine = runGoTest(cache, r);
		const pristineFails = !pristine.pass && r.signature.test(pristine.out);
		if (!patched.pass) {
			bad++;
			console.error(`STOPGAP-BROKEN ${r.key}: patched side FAILS (${patched.out.split('\n').find(l => l.trim()) ?? ''})`);
		} else if (pristine.pass) {
			bad++;
			console.error(`UPSTREAM-FIXED ${r.key}: pristine ${pin} PASSES — remove the stopgap, its README ledger row, and ${r.branch}`);
		} else if (!pristineFails) {
			bad++;
			console.error(`FAIL ${r.key}: pristine failed without signature ${r.signature}`);
			console.error(pristine.out.split('\n').slice(0, 10).join('\n'));
		} else {
			console.log(`ok ${r.key} — patched=PASS pristine=FAIL (stopgap alive, upstream open)`);
		}
	}

	// ── Archival: pristine FAIL only (no stopgap) ────────────────────────────
	for (const r of ARCHIVAL) {
		const pristine = runGoTest(cache, r);
		if (pristine.pass) {
			bad++;
			console.error(`CLOSABLE ${r.test}: pristine ${pin} PASSES — upstream fixed it; clean up registrations (${r.note})`);
		} else if (!r.signature.test(pristine.out)) {
			bad++;
			console.error(`FAIL ${r.test}: pristine failed without signature ${r.signature}`);
		} else {
			console.log(`ok ${r.test} — pristine=FAIL (archival; ${r.note})`);
		}
	}
} finally {
	for (const f of injectedPristine) fs.rmSync(f, { force: true });
	for (const f of injectedPatched) fs.rmSync(f, { force: true });
}

console.log(bad === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(bad === 0 ? 0 : 1);
