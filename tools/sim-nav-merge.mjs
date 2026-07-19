#!/usr/bin/env node
// Merge sim-nav shard payloads, or gate a merged result against the committed
// baseline (test/baselines/).
//
//   node tools/sim-nav-merge.mjs --out <merged.json> <shard.json...>
//   node tools/sim-nav-merge.mjs --baseline <baseline.json> <merged.json>
//
// Shard payloads are triage-sim-nav-shard.mjs OUT_JSON files (SIM_NAV_SHARD_*).
// Merged shape matches the committed baselines: scalar counters summed,
// `compareKeys` = total probed units, and `diffs`/`docdiffs`/`diagmsgs`
// unioned by `key` (shards probe disjoint unit sets).
//
// Baseline check: fail when the current run has ANY key absent from the
// baseline in any channel (new divergence). Convergences (baseline keys now
// matching) are reported but pass — refresh the baseline file to absorb them.

import fs from "node:fs";

const args = process.argv.slice(2);
const mode = args[0];
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const CHANNELS = ["diffs", "docdiffs", "diagmsgs"];

if (mode === "--out") {
	const out = args[1];
	const files = args.slice(2);
	if (!out || !files.length) {
		console.error("usage: node tools/sim-nav-merge.mjs --out <merged.json> <shard.json...>");
		process.exit(2);
	}
	const merged = {
		total: 0, match: 0, diff: 0, docdiff: 0, diagmsg: 0, skip: 0,
		skipReasons: {}, compareKeys: 0, diffs: [], docdiffs: [], diagmsgs: [], mergedFrom: files,
	};
	const seenByChannel = Object.fromEntries(CHANNELS.map((c) => [c, new Set()]));
	for (const f of files) {
		const j = read(f);
		for (const k of ["total", "match", "diff", "docdiff", "diagmsg", "skip"]) merged[k] += j[k] ?? 0;
		merged.compareKeys += j.compareKeys ?? 0;
		for (const [r, c] of Object.entries(j.skipReasons ?? {})) {
			merged.skipReasons[r] = (merged.skipReasons[r] ?? 0) + c;
		}
		for (const ch of CHANNELS) {
			for (const d of j[ch] ?? []) {
				if (seenByChannel[ch].has(d.key)) {
					console.error(`sim-nav-merge: duplicate ${ch} key across shards: ${d.key}`);
					process.exit(1);
				}
				seenByChannel[ch].add(d.key);
				merged[ch].push(d);
			}
		}
	}
	merged.summaryLine = `SUMMARY total=${merged.total} match=${merged.match} diff=${merged.diff} docdiff=${merged.docdiff} diagmsg=${merged.diagmsg} skip=${merged.skip}`;
	fs.writeFileSync(out, JSON.stringify(merged, null, 2));
	console.log(`${merged.summaryLine} units=${merged.compareKeys} (merged ${files.length} shards -> ${out})`);
} else if (mode === "--baseline") {
	const [baselinePath, currentPath] = args.slice(1);
	if (!baselinePath || !currentPath) {
		console.error("usage: node tools/sim-nav-merge.mjs --baseline <baseline.json> <merged.json>");
		process.exit(2);
	}
	const base = read(baselinePath);
	const cur = read(currentPath);
	let rc = 0;
	for (const ch of CHANNELS) {
		const baseKeys = new Set((base[ch] ?? []).map((d) => d.key));
		const curKeys = new Set((cur[ch] ?? []).map((d) => d.key));
		const added = [...curKeys].filter((k) => !baseKeys.has(k));
		const fixed = [...baseKeys].filter((k) => !curKeys.has(k));
		console.log(`${ch}: baseline=${baseKeys.size} current=${curKeys.size} new=${added.length} fixed=${fixed.length}`);
		if (added.length) {
			console.error(`NEW ${ch} divergences (${added.length}):`);
			for (const k of added.slice(0, 20)) console.error(`  ${k}`);
			if (added.length > 20) console.error(`  ... ${added.length - 20} more`);
			rc = 1;
		}
	}
	console.log(`units ${base.compareKeys} -> ${cur.compareKeys}, total ${base.total} -> ${cur.total}`);
	if ((base.compareKeys ?? 0) !== (cur.compareKeys ?? 0)) {
		console.log("note: probed unit count changed (corpus/pin drift — review before accepting)");
	}
	if (rc === 0) {
		console.log("sim-nav baseline check ok — no new divergences");
	}
	process.exit(rc);
} else {
	console.error("usage: --out <merged.json> <shard.json...> | --baseline <baseline.json> <merged.json>");
	process.exit(2);
}
