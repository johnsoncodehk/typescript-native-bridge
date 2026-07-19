#!/usr/bin/env node
/**
 * NAPI bridge fuzz: round-trip pathological payloads through echo (string and
 * binary paths) and verify byte-identical envelopes. The shim's contract:
 * string results are Go-owned buffers V8 copies; binary results are zero-copy
 * napi_create_external_buffer views. Any marshalling bug (truncation, encoding drift,
 * use-after-reuse) shows up as a mismatch here.
 *
 * Usage: node tools/triage-napi-fuzz.mjs
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const bridgePath = path.join(repoRoot, 'native', 'bridge.node');

process.env.TNB_LIB_PATH ??= path.join(repoRoot, 'lib');

const addon = require2(bridgePath);
const cwd = repoRoot;

const deep = (() => { let o = {}; let cur = o; for (let i = 0; i < 200; i++) { cur.n = {}; cur = cur.n; } cur.end = true; return o; })();
const big = 'x'.repeat(1024 * 1024);
const cases = [
	['empty', ''],
	['null', null],
	['ascii', { s: 'hello world' }],
	['bmp', { s: '世界 ✓ Ω π 漢字' }],
	['astral', { s: '🌍🚀𝄞𝓊𝓃𝒾𝒸ℴ𝒹ℯ' }],
	['escapes', { s: '"quoted" \\ backslash \n \t /  ' }],
	['deep', deep],
	['big-1mb', { s: big }],
	['mixed', { a: [1, 'two', { three: [4, 5, { six: '🌍' }] }], b: big.slice(0, 4096) }],
];

let failures = 0;
const handle = addon.newSession(cwd);
if (!handle) { console.error('newSession failed'); process.exit(1); }

for (const [name, payload] of cases) {
	const paramsJson = payload === null ? null : JSON.stringify(payload);
	const expected = paramsJson ?? 'null';
	// string path: echo returns RawBinary, which the Go side json.Marshal's as
	// a base64 JSON doc — decode before comparing. Errors throw (napi).
	const doc = addon.call(BigInt(handle), 'echo', paramsJson);
	const gotStr = Buffer.from(String(JSON.parse(doc)), 'base64').toString('utf8');
	if (gotStr !== expected) {
		failures++;
		console.log(`FAIL ${name} (string): expected ${expected.length}B, got ${gotStr.length}B`);
		continue;
	}
	// binary path — echo returns the params as RawBinary
	const buf = addon.callBinary(BigInt(handle), 'echo', paramsJson);
	const gotBin = buf ? buf.toString('utf8') : '';
	if (gotBin !== expected) {
		failures++;
		console.log(`FAIL ${name} (binary): expected ${expected.length}B, got ${gotBin.length}B`);
		continue;
	}
	console.log(`ok ${name} (${expected.length}B ×2 paths)`);
}

// Reusable-buffer stability: alternate payload sizes 60 times; every doc
// must stay intact (stale-pointer/reuse corruption would garble earlier reads).
let stable = true;
let prev = '';
for (let i = 0; i < 60; i++) {
	const p = JSON.stringify({ i, pad: 'y'.repeat((i % 7) * 1000) });
	const doc = addon.call(BigInt(handle), 'echo', p);
	const data = Buffer.from(String(JSON.parse(doc)), 'base64').toString('utf8');
	if (data !== p) { stable = false; console.log(`FAIL stability iter ${i}`); break; }
	prev = data;
}
console.log(`stability: ${stable ? 'ok (60 alternating calls)' : 'FAIL'} prev=${prev.length}B`);

addon.disposeSession(BigInt(handle));
console.log(failures === 0 && stable ? 'VERDICT: PASS' : `VERDICT: FAIL (${failures})`);
process.exit(failures === 0 && stable ? 0 : 1);
