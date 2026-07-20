#!/usr/bin/env node
/**
 * Parallel local sim-nav: the harness lock is per tools-dir parent, so shards
 * must run from isolated tools copies (CI does the same for witness groups).
 * This runner copies tools/ into /tmp/tnb-simnav-wg<i>, symlinks vendor/ lib/
 * native/ back, runs SIM_NAV_SHARD_INDEX=i/COUNT=N concurrently, then merges
 * and baseline-gates the result.
 *
 * Usage: node tools/sim-nav-parallel.mjs [shardCount]
 * Env: VOLAR_ROOT (required off-repo layouts), STOCK_TSSERVER_PATH,
 *      SIM_NAV_BASELINE (defaults to newest committed baseline).
 * Exit: 0 = merged run has no new divergences vs baseline.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');
const SHARDS = Math.max(1, Number.parseInt(process.argv[2] ?? process.env.SIM_NAV_PARALLEL ?? '4', 10) || 4);

function newestBaseline() {
	if (process.env.SIM_NAV_BASELINE) return process.env.SIM_NAV_BASELINE;
	const dir = path.join(repoRoot, 'test', 'baselines');
	let best = null;
	for (const name of fs.readdirSync(dir)) {
		const m = /^nav-results-.+-t(\d+)\.json$/.exec(name);
		if (m && (!best || Number(m[1]) > best.t)) best = { t: Number(m[1]), name };
	}
	if (!best) throw new Error(`no nav-results baseline in ${dir}`);
	return path.join(dir, best.name);
}

const baseline = newestBaseline();
console.log(`shards=${SHARDS} baseline=${path.basename(baseline)}`);

const kids = [];
for (let i = 0; i < SHARDS; i++) {
	const wg = `/tmp/tnb-simnav-wg${i}`;
	fs.rmSync(wg, { recursive: true, force: true });
	fs.mkdirSync(wg, { recursive: true });
	fs.cpSync(toolsDir, path.join(wg, 'tools'), { recursive: true });
	for (const d of ['vendor', 'lib', 'native', 'test']) {
		fs.symlinkSync(path.join(repoRoot, d), path.join(wg, d));
	}
	const env = {
		...process.env,
		SIM_NAV_SHARD_INDEX: String(i),
		SIM_NAV_SHARD_COUNT: String(SHARDS),
		SIM_NAV_BASELINE: baseline,
		SIM_NAV_OUT_JSON: `/tmp/tnb-simnav-results-shard${i}of${SHARDS}.json`,
		SIM_NAV_OUT_LOG: `/tmp/tnb-simnav-run-shard${i}of${SHARDS}.log`,
		SIM_NAV_THROW_FILE: `/tmp/tnb-simnav-throws-shard${i}of${SHARDS}.jsonl`,
	};
	kids.push(new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(wg, 'tools', 'triage-sim-nav-shard.mjs')], {
			env,
			stdio: ['ignore', fs.openSync(`/tmp/tnb-simnav-stdout-shard${i}of${SHARDS}.log`, 'w'), 'inherit'],
		});
		child.on('exit', (code) => resolve({ i, code }));
	}));
}

const results = await Promise.all(kids);
const failed = results.filter((r) => r.code !== 0);
if (failed.length) {
	console.error(`shard failures: ${failed.map((r) => `#${r.i}(exit ${r.code})`).join(', ')} — see /tmp/tnb-simnav-run-shard*.log`);
	process.exit(1);
}

const merged = `/tmp/tnb-simnav-merged-${SHARDS}.json`;
const shardJsons = results.map((r) => `/tmp/tnb-simnav-results-shard${r.i}of${SHARDS}.json`);
const run = (args) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, args, { stdio: 'inherit' });
		child.on('exit', (code) => resolve(code ?? 1));
	});

let rc = await run([path.join(toolsDir, 'sim-nav-merge.mjs'), '--out', merged, ...shardJsons]);
if (rc === 0) rc = await run([path.join(toolsDir, 'sim-nav-merge.mjs'), '--baseline', baseline, merged]);
process.exit(rc);
