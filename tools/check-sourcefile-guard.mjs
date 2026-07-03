#!/usr/bin/env node
// getSourceFile RPC regression guard.
//
// TNB serves BuilderProgram's getSourceFiles()/getSourceFileByPath() from a
// metadata-only light stub so it does NOT pay a tsgo getSourceFile RPC for every
// program file; only files that are actually type-checked materialize a
// tsgo-backed SourceFile (one RPC each). If that split regresses — e.g. the
// light stub is dropped or merged into the full path — every program file starts
// paying an RPC and the count spikes. This guard runs the vue-tsc full build
// (packages/tsc, the workload that exercises the split) and asserts the RPC
// count stays under baseline.
//
// component-meta is NOT usable here: it drives the Language Service host path and
// only ever produces `host` SourceFiles, so it never exercises the light /
// tsgo-backed split this guard measures.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const volarCandidates = [
	path.resolve(root, "..", "volar", "vue"),
	path.resolve(root, "..", "..", "volar", "vue"),
];
const volarVue = volarCandidates.find(p => fs.existsSync(p));
const baselinePath = path.join(root, "tools", "sourcefile-guard-baseline.json");
const statsPath = path.join(os.tmpdir(), `tnb-guard-stats-${process.pid}-${Date.now()}.json`);

const errors = [];
function fail(msg) {
	errors.push(msg);
}

if (!fs.existsSync(path.join(root, "lib", "typescript.js"))) {
	fail("missing lib/typescript.js — run npm run build:lib");
}

if (!volarVue) {
	fail(`missing volar/vue — expected one of: ${volarCandidates.join(", ")}`);
}

if (errors.length) {
	console.error("check:sourcefile-guard failed:\n");
	for (const e of errors) console.error(`  • ${e}`);
	process.exit(1);
}

try { fs.rmSync(statsPath, { force: true }); } catch { /* ignore */ }

const env = {
	...process.env,
	TNB_GUARD_STATS_FILE: statsPath,
};

const vitest = spawnSync(
	"npx",
	["vitest", "run", "packages/tsc", "--maxWorkers=1"],
	{ cwd: volarVue, env, encoding: "utf8", maxBuffer: 1 << 28 },
);

// Positive "vue-tsc actually ran to completion" signal. The overlay flushes the
// stats file continuously, so file existence alone only proves startup was
// reached — a mid/late native crash (NAPI segfault, OOM SIGKILL) leaves a full
// stats file behind. Vitest always prints a run summary when it finishes; its
// absence means the process died mid-run.
const vitestOut = `${vitest.stdout ?? ""}\n${vitest.stderr ?? ""}`;
const vitestFinished = /Test Files\s+\d+\s+(failed|passed)/.test(vitestOut)
	|| /Tests\s+\d+\s+(failed|passed)/.test(vitestOut);
if (!vitestFinished) {
	console.error(vitest.stdout);
	console.error(vitest.stderr);
	fail(`vue-tsc did not finish (no vitest run summary; likely native crash, exit ${vitest.status ?? "signal"})`);
}

let stats;
try {
	stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
}
catch {
	console.error(vitest.stdout);
	console.error(vitest.stderr);
	fail(`guard stats file missing at ${statsPath} — overlay did not write TNB_GUARD_STATS_FILE`);
}

if (stats) {
	const rpc = stats.getSourceFileRpcCount ?? 0;

	// rpc === 0 means the tsgo-backed getSourceFile path never ran — the workload
	// didn't exercise the split, so a "low" count would be a false pass.
	if (rpc <= 0) {
		fail(`getSourceFile RPC count is ${rpc} — the tsgo-backed path did not run (wrong workload or regression)`);
	}

	let baseline = { maxGetSourceFileRpc: rpc };
	if (fs.existsSync(baselinePath)) {
		baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
	}
	if (rpc > baseline.maxGetSourceFileRpc) {
		fail(
			`getSourceFile RPC count regressed: ${rpc} > baseline ${baseline.maxGetSourceFileRpc} ` +
			"(light-stub path may be broken — a skeleton/full merge would show up here)",
		);
	}

	if (!errors.length) {
		console.log(
			`check:sourcefile-guard ok (getSourceFileRpc=${rpc}, baseline<=${baseline.maxGetSourceFileRpc})`,
		);
	}
}

try { fs.unlinkSync(statsPath); } catch { /* ignore */ }

if (errors.length) {
	console.error("\ncheck:sourcefile-guard failed:\n");
	for (const e of errors) console.error(`  • ${e}`);
	process.exit(1);
}
