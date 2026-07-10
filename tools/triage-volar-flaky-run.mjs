#!/usr/bin/env node
/**
 * Repeated single-spec runs for flaky detection.
 * Usage: node tools/triage-volar-flaky-run.mjs <count> <spec-path> <log-prefix>
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const [countStr, specPath, logPrefix] = process.argv.slice(2);
if (!countStr || !specPath || !logPrefix) {
	console.error('Usage: node tools/triage-volar-flaky-run.mjs <count> <spec-path> <log-prefix>');
	process.exit(1);
}
const count = Number(countStr);
const volarRoot = process.env.VOLAR_ROOT ?? '/Users/johnsonchu/Desktop/volar/vue';
const logPath = `${logPrefix}.log`;
const summaryPath = `${logPrefix}-summary.txt`;

let pass = 0;
let fail = 0;
const lines = [];

for (let i = 1; i <= count; i++) {
	const start = Date.now();
	const r = spawnSync('npm', ['test', '--', specPath], {
		cwd: volarRoot,
		encoding: 'utf8',
		env: process.env,
	});
	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	const out = (r.stdout ?? '') + (r.stderr ?? '');
	const testLine = out.match(/Tests\s+(\d+)\s+failed\s+\|\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?/);
	const fileLine = out.match(/Test Files\s+(\d+)\s+failed\s+\|\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?/);
	const failedTests = [...out.matchAll(/FAIL\s+(.+\.spec\.[tj]s)\s+>\s+(.+)/g)].map(m => `${m[2]}`);
	const ok = testLine ? Number(testLine[1]) === 0 : r.status === 0;
	if (ok) pass++; else fail++;
	const row = `run${i}: ${ok ? 'PASS' : 'FAIL'} exit=${r.status} elapsed=${elapsed}s | ${testLine?.[0]?.trim() ?? 'no summary'} | fails=${failedTests.join('; ') || 'none'}`;
	lines.push(row);
	fs.appendFileSync(logPath, `\n=== RUN ${i}/${count} ${new Date().toISOString()} ===\n${out}\n`);
	console.log(row);
}

const summary = [
	`spec: ${specPath}`,
	`runs: ${count}`,
	`pass: ${pass}`,
	`fail: ${fail}`,
	`pass_rate: ${(pass / count * 100).toFixed(1)}%`,
	'',
	...lines,
].join('\n');
fs.writeFileSync(summaryPath, summary + '\n');
console.log('\n' + summary);
