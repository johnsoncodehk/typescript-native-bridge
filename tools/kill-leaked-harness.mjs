#!/usr/bin/env node
/**
 * DIAGNOSTIC SWEEPER ONLY — not a primary defense.
 *
 * The structural defenses are: parent-watch (tsserver exits when the harness
 * parent dies, see tools/tnb-parent-watch.cjs), the repo harness file lock
 * (max 1 concurrent harness, tools/tsserver-harness.mjs), and the
 * deny-by-default shell hook (.cursor/hooks/block-adhoc-tsserver-harness.mjs).
 * Use this script to detect/clean historical leaks; a non-zero count here
 * means one of the defenses above regressed.
 *
 * Usage:
 *   node tools/kill-leaked-harness.mjs          # dry-run (count only)
 *   node tools/kill-leaked-harness.mjs --kill   # SIGKILL + retry until stable
 */
import { execSync } from 'node:child_process';

const patterns = [
	'node -e.*launchServer',
	'node -e.*resolveVolarRoot',
	'node -e.*withTsserver',
	'node --input-type=module -e.*withTsserver',
	'node --input-type=module -e.*resolveVolarRoot',
	'node --input-type=module -e.*completionInfo wall',
	'tsserver\\.js.*disableAutomaticTypingAcquisition',
	'tsserver\\.js.*@vue/typescript-plugin',
];

function countMatches() {
	const pids = new Set();
	for (const pattern of patterns) {
		const out = execSync(`pgrep -f '${pattern}' 2>/dev/null || true`, { encoding: 'utf8' }).trim();
		for (const pid of out.split('\n').filter(Boolean)) pids.add(pid);
	}
	return pids.size;
}

const before = countMatches();
console.log(`leaked harness processes: ${before}`);

if (before === 0) {
	process.exit(0);
}

if (!process.argv.includes('--kill')) {
	console.log('dry-run only. Re-run with --kill to terminate.');
	process.exit(1);
}

const maxRounds = 5;
for (let round = 1; round <= maxRounds; round++) {
	for (const pattern of patterns) {
		execSync(`pkill -9 -f '${pattern}' 2>/dev/null || true`);
	}
	execSync('sleep 1');
	const remaining = countMatches();
	console.log(`round ${round}: remaining ${remaining}`);
	if (remaining === 0) {
		process.exit(0);
	}
}

const after = countMatches();
console.log(`remaining after ${maxRounds} kill rounds: ${after}`);
process.exit(after === 0 ? 0 : 1);
