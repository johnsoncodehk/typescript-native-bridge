#!/usr/bin/env node
/**
 * CLI exit-code parity witness (bridge contract surface): stock's driver
 * maps the program's emitResult to the process exit code — emitSkipped &&
 * diagnostics → 1 (DiagnosticsPresent_OutputsSkipped), diagnostics → 2
 * (DiagnosticsPresent_OutputsGenerated), else 0. Under --noEmit a
 * whole-program stock emit degenerates to emitBuildInfo (handleNoEmitOptions)
 * — emitSkipped: false, tsbuildinfo written iff incremental-capable — so
 * stock exits 2 on a project with errors; the bridge's emit proxy used to
 * return Go handleEmit's EmitSkipped: true and exit 1 on non-incremental
 * projects. The proxy now routes whole-program noEmit through its own
 * emitBuildInfo, mirroring stock's contract (and stock's
 * Program.emitBuildInfo reports emitSkipped: false even when there is no
 * buildinfo path to write).
 *
 * Expected values are stock 6.0.3's, measured on these exact fixtures:
 * noEmit gates before noEmitOnError (hence 2 for the combined cell), and
 * noEmitOnError with errors returns emitSkipped: true with the pre-emit
 * diagnostics (hence 1, and nothing is written). Incremental/composite
 * noEmit rides the JS builder program (performIncrementalCompilation),
 * which writes tsbuildinfo and reports emitSkipped: false.
 *
 * Runs `lib/_tsc.js` on self-contained fixtures in fresh processes.
 * Exit: 0 = PASS, 1 = FAIL.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(repoRoot, 'lib', '_tsc.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-exit-codes-'));

const ERR = 'export const x: number = "nope";\n';
const OK = 'export const x: number = 1;\n';
const BASE = { strict: true, types: [] };

// [label, compilerOptions, source, expected exit, mustExist, mustAbsent]
const cases = [
	['noEmit+errors', { ...BASE, noEmit: true }, ERR, 2],
	['incremental noEmit+errors', { ...BASE, noEmit: true, incremental: true }, ERR, 2, 'tsconfig.tsbuildinfo'],
	['composite noEmit+errors', { ...BASE, noEmit: true, composite: true }, ERR, 2, 'tsconfig.tsbuildinfo'],
	['noEmit+noEmitOnError+errors', { ...BASE, noEmit: true, noEmitOnError: true }, ERR, 2],
	['noEmitOnError+errors', { ...BASE, noEmitOnError: true, outDir: 'out' }, ERR, 1, undefined, 'out/src.js'],
	['emit+errors', { ...BASE, outDir: 'out' }, ERR, 2, 'out/src.js'],
	['clean noEmit', { ...BASE, noEmit: true }, OK, 0],
];

let failures = 0;
for (const [label, compilerOptions, source, want, mustExist, mustAbsent] of cases) {
	const d = path.join(dir, label.replaceAll(/[^\w]+/g, '-'));
	fs.mkdirSync(d);
	fs.writeFileSync(path.join(d, 'src.ts'), source);
	fs.writeFileSync(path.join(d, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['**/*.ts'] }));
	const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: d, encoding: 'utf8' });
	if (r.error) {
		console.error(`FAIL: ${label}: spawn error: ${r.error.message}`);
		failures++;
		continue;
	}
	const problems = [];
	if (r.status !== want) problems.push(`exit ${r.status}, want ${want}`);
	if (mustExist && !fs.existsSync(path.join(d, mustExist))) problems.push(`missing ${mustExist}`);
	if (mustAbsent && fs.existsSync(path.join(d, mustAbsent))) problems.push(`unexpected ${mustAbsent}`);
	if (problems.length) {
		console.error(`FAIL: ${label}: ${problems.join('; ')}`);
		failures++;
	} else {
		console.log(`ok ${label} (exit ${want})`);
	}
}

// Usage error: unknown flag → 1 on stock and bridge alike.
const u = spawnSync(process.execPath, [tsc, '--bogus-flag'], { cwd: dir, encoding: 'utf8' });
if (u.error || u.status !== 1) {
	console.error(`FAIL: usage error: ${u.error ? `spawn error: ${u.error.message}` : `exit ${u.status}, want 1`}`);
	failures++;
} else {
	console.log('ok usage error (exit 1)');
}

if (failures) process.exit(1);
console.log(`PASS: ${cases.length + 1} exit-code cells match stock 6.0.3`);
