#!/usr/bin/env node
/**
 * pristine-tsgo attribution gate (v5): prove that the behaviors TNB carries
 * stopgap patches or KNOWN_DIVERGENCES registrations for are UPSTREAM tsgo
 * behaviors, not bridge-introduced divergences.
 *
 * How: clone pristine microsoft/typescript-go at the submodule's pinned tag,
 * inject each repro test extracted from the submodule's repro/* branches,
 * and assert every test FAILS on pristine with its known signature. A test
 * that PASSES on pristine means upstream fixed the behavior — the gate
 * fails loud so the stopgap / registration / README ledger row gets removed.
 *
 * Usage: node tools/check-pristine-attribution.mjs
 * Env:   TNB_PRISTINE_CACHE — clone cache dir (default /tmp/tnb-pristine-tsgo)
 * Exit:  0 = every repro still fails on pristine (attribution holds).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const submodule = path.join(repoRoot, 'typescript-go');
const cache = process.env.TNB_PRISTINE_CACHE ?? '/tmp/tnb-pristine-tsgo';
const UPSTREAM = 'https://github.com/microsoft/typescript-go.git';

// branch (submodule ref holding the repro) → test file, package, test name,
// and the failure signature that must appear in the pristine run.
const REPROS = [
	{
		branch: 'repro/export-equals-exports-merge',
		file: 'internal/checker/zz_repro_export_equals_test.go',
		pkg: './internal/checker/',
		test: 'TestGetExportsOfModuleResolvesExportEqualsTarget',
		signature: /missing "foo"/,
	},
	{
		branch: 'repro/type-position-entity-reads-any',
		file: 'internal/checker/zz_repro_type_position_entity_test.go',
		pkg: './internal/checker/',
		test: 'TestTypePositionEntityInIndexedAccess',
		signature: /resolved to any/,
	},
	{
		branch: 'repro/far-module-specifier-context',
		file: 'internal/ls/zz_repro_far_context_test.go',
		pkg: './internal/ls/',
		test: 'TestModuleSpecifierContextNode',
		signature: /= nil/,
	},
	{
		branch: 'repro/unused-type-param-diagnostic-code',
		file: 'internal/checker/zz_repro_unused_type_param_test.go',
		pkg: './internal/checker/',
		test: 'TestUnusedTypeParameterDiagnosticCode',
		signature: /TS6196/,
	},
];

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// The pin: the exact upstream tag at the submodule HEAD when one exists
// (clone --depth 1 --branch needs a ref), else the raw commit.
let pin = git(submodule, ['describe', '--tags', '--exact-match', 'HEAD']);
let pinIsTag = true;
if (!pin) {
	pin = git(submodule, ['rev-parse', 'HEAD']);
	pinIsTag = false;
}
console.log(`pin: ${pin} (${pinIsTag ? 'tag' : 'commit'})`);

// Fresh, verified-pristine clone in the cache. A cached clone whose HEAD is
// not the pin is discarded — attribution must never be judged on drift.
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

// Pristine proof: no injected file may already exist upstream.
for (const r of REPROS) {
	if (fs.existsSync(path.join(cache, r.file))) {
		console.error(`FAIL: ${r.file} exists in the pristine clone — cache is not pristine`);
		process.exit(1);
	}
}

let bad = 0;
const injected = [];
try {
	for (const r of REPROS) {
		const src = git(submodule, ['show', `${r.branch}:${r.file}`]);
		const dest = path.join(cache, r.file);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, src);
		injected.push(dest);
	}
	for (const r of REPROS) {
		let out = '';
		let code = 0;
		try {
			out = execFileSync('go', ['test', r.pkg, '-run', `^${r.test}$`, '-count=1', '-v'], { cwd: cache, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (e) {
			code = e.status ?? 1;
			out = (e.stdout ?? '') + (e.stderr ?? '');
		}
		if (code === 0) {
			bad++;
			console.error(`FIXED-UPSTREAM? ${r.test} PASSED on pristine ${pin} — remove the stopgap/registration and this repro (${r.branch})`);
			continue;
		}
		if (!r.signature.test(out)) {
			bad++;
			console.error(`FAIL ${r.test}: failed on pristine but without the expected signature ${r.signature}`);
			console.error(out.split('\n').slice(0, 15).join('\n'));
			continue;
		}
		console.log(`ok ${r.test} — reproduces on pristine ${pin} (attribution: upstream)`);
	}
} finally {
	for (const f of injected) fs.rmSync(f, { force: true });
}

console.log(bad === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(bad === 0 ? 0 : 1);
