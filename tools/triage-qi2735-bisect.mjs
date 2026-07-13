#!/usr/bin/env node
// Bisect: which earlier probe makes TNB quickinfo@a.ts:27:35 (JSDoc comment
// interior) flip from empty (stock parity) to success. Replays the recorded
// probe args from /tmp/tnb-sweepfail-probes.jsonl prefix [0, N) then tests.
// Usage: node tools/triage-qi2735-bisect.mjs [N]   (single run)
//        node tools/triage-qi2735-bisect.mjs --bisect
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const aPath = '/tmp/tnb-sweep-fixtures/a.ts';
const bPath = '/tmp/tnb-sweep-fixtures/b.tsx';

const probes = fs.readFileSync('/tmp/tnb-sweepfail-probes.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
// only prefix probes in a.ts before the target position battery
const targetIdx = probes.findIndex(p => p.fileBase === 'a.ts' && p.line === 27 && p.col === 35 && p.command === 'quickinfo');
if (targetIdx < 0) throw new Error('target probe not found');

async function probeWithPrefix(n) {
	return withTsserver({ tsserverPath: tnbPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env: tnbHarnessEnv() }, async ({ send }) => {
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [
				{ file: aPath, fileContent: fs.readFileSync(aPath, 'utf8'), projectRootPath: '/tmp/tnb-sweep-fixtures' },
				{ file: bPath, fileContent: fs.readFileSync(bPath, 'utf8'), projectRootPath: '/tmp/tnb-sweep-fixtures' },
			],
		});
		for (let i = 0; i < n; i++) {
			const p = probes[i];
			try { await send(p.command, p.args, 30_000); } catch { /* ignore */ }
		}
		let r;
		try { r = await send('quickinfo', probes[targetIdx].args, 30_000); } catch (e) { r = { success: false, message: String(e) }; }
		return { success: !!r?.success, display: r?.body?.displayString ?? null };
	});
}

const arg = process.argv[2];
if (arg && arg !== '--bisect') {
	const n = Number(arg);
	const r = await probeWithPrefix(n);
	console.log(`prefix=${n} → success=${r.success} display=${JSON.stringify(r.display)}`);
	process.exit(0);
}

// bisect: find minimal N where success flips to true
let lo = 0, hi = targetIdx; // prefix length
const atHi = await probeWithPrefix(hi);
console.log(`prefix=${hi} → success=${atHi.success} display=${JSON.stringify(atHi.display)}`);
if (!atHi.success) {
	console.log('not reproducible with full prefix; flaky beyond prefix replay');
	process.exit(2);
}
const atLo = await probeWithPrefix(0);
console.log(`prefix=0 → success=${atLo.success}`);
if (atLo.success) {
	console.log('reproducible with empty prefix?! single-shot repro');
	process.exit(0);
}
while (lo + 1 < hi) {
	const mid = (lo + hi) >> 1;
	const r = await probeWithPrefix(mid);
	console.log(`prefix=${mid} → success=${r.success}`);
	if (r.success) hi = mid; else lo = mid;
}
const culprit = probes[hi - 1];
console.log(`\nculprit probe idx=${hi - 1}: ${culprit.command} @ ${culprit.fileBase}:${culprit.line}:${culprit.col} args=${JSON.stringify(culprit.args).slice(0, 200)}`);
