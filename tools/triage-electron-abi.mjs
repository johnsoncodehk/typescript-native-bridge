#!/usr/bin/env node
/**
 * Electron-runtime ABI probe for the NAPI bridge: spawns ITSELF under an
 * Electron binary (ELECTRON_RUN_AS_NODE) and round-trips payloads through
 * both call paths. Guards the V8-sandbox failure class: napi's
 * create_external_buffer with a Go heap pointer fails under Electron's
 * sandbox, killing every binary RPC session-wide (2026-07-20 incident —
 * VS Code tsserver host, all LS nav degraded/crashing).
 *
 * Electron binary resolution: TNB_ELECTRON_BIN → require('electron')
 * (npm-installed) → VS Code macOS default. None found: SKIP (exit 0) —
 * local machines without Electron simply don't gate this class; CI wires
 * `npm i --no-save electron` explicitly.
 *
 * Exit: 0 = PASS (or SKIP), 1 = FAIL.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.ELECTRON_RUN_AS_NODE) {
	let bin = process.env.TNB_ELECTRON_BIN ?? '';
	if (!bin) {
		try { bin = createRequire(import.meta.url)('electron'); } catch { /* not installed */ }
	}
	if (!bin || !fs.existsSync(bin)) {
		const vscodeBin = '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)';
		if (fs.existsSync(vscodeBin)) bin = vscodeBin;
	}
	if (!bin || !fs.existsSync(bin)) {
		console.log('SKIP: no Electron binary (set TNB_ELECTRON_BIN or npm i --no-save electron)');
		process.exit(0);
	}
	const r = spawnSync(bin, [fileURLToPath(import.meta.url)], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TNB_LIB_PATH: process.env.TNB_LIB_PATH ?? path.join(repoRoot, 'lib'), GODEBUG: 'asyncpreemptoff=1' },
		stdio: 'inherit',
	});
	process.exit(r.status ?? 1);
}

// ── Electron side ──
const require2 = createRequire(import.meta.url);
const addon = require2(path.join(repoRoot, 'native', 'bridge.node'));
const session = addon.newSession(repoRoot);
const handle = BigInt(session);

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? 'ok' : 'FAIL'} ${label}`);
	if (!ok) failed++;
};

const payloadU = 'héllo π ✓';
const bufU = addon.callBinary(handle, 'echo', JSON.stringify(payloadU));
const okU = Buffer.isBuffer(bufU)
	&& Buffer.from(bufU.buffer, bufU.byteOffset, bufU.byteLength).toString('utf8') === JSON.stringify(payloadU);
check(`callBinary unicode roundtrip (${Buffer.isBuffer(bufU) ? bufU.byteLength : String(bufU)} bytes)`, okU);

for (const size of [19, 4147, 1048576]) {
	const payload = 'x'.repeat(size);
	const buf = addon.callBinary(handle, 'echo', JSON.stringify(payload));
	const ok = Buffer.isBuffer(buf)
		&& buf.byteLength > 0
		&& Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf8') === JSON.stringify(payload);
	check(`callBinary ${size}B -> ${Buffer.isBuffer(buf) ? `Buffer(${buf.byteLength})` : String(buf)}`, ok);
}

// Reuse stability: alternating sizes must not corrupt.
let stable = true;
for (let i = 0; i < 60; i++) {
	const payload = 'y'.repeat((i % 7) * 991);
	const buf = addon.callBinary(handle, 'echo', JSON.stringify(payload));
	const got = buf && Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf8');
	if (got !== JSON.stringify(payload)) { stable = false; break; }
}
check('reuse stability (60 alternating)', stable);

addon.disposeSession(handle);
console.log(failed === 0 ? 'VERDICT: PASS' : `VERDICT: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
