#!/usr/bin/env node
// Merge sim-nav shard payloads, or gate a merged result against the committed
// baseline (test/baselines/).
//
//   node tools/sim-nav-merge.mjs --out <merged.json> <shard.json...>
//   node tools/sim-nav-merge.mjs --baseline <baseline.json> <merged.json>
//   node tools/sim-nav-merge.mjs --slim <merged.json> <baseline-out.json>
//
// Shard payloads are triage-sim-nav-shard.mjs OUT_JSON files (SIM_NAV_SHARD_*).
// Merged shape matches the committed baselines: scalar counters summed,
// `compareKeys` = total probed units, and `diffs`/`docdiffs`/`diagmsgs`
// unioned by `key` (shards probe disjoint unit sets).
//
// Baseline check: fail when the current run has ANY key absent from the
// baseline in any channel (new divergence). Convergences (baseline keys now
// matching) are reported but pass — refresh the baseline file to absorb them.
//
// --slim writes the committed-baseline form of a merged run: keys, counters
// and classification labels only — bulky tnb/stock snippets, locs and replay
// payloads stay in the (uncommitted) merged JSON for triage.

import fs from "node:fs";

const args = process.argv.slice(2);
const mode = args[0];
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const CHANNELS = ["diffs", "docdiffs", "diagmsgs"];

// Keys are test-workspace-relative; legacy baselines embedded absolute paths.
// Strip everything up to the last test-workspace/ so old and new compare equal.
const normKey = (key) => String(key ?? "").replace(/^((?:nav|diag):).*test-workspace\//, "$1");

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
		const baseKeys = new Set((base[ch] ?? []).map((d) => normKey(d.key)));
		const curKeys = new Set((cur[ch] ?? []).map((d) => normKey(d.key)));
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
} else if (mode === "--slim") {
	const [currentPath, outPath] = args.slice(1);
	if (!currentPath || !outPath) {
		console.error("usage: node tools/sim-nav-merge.mjs --slim <merged.json> <baseline-out.json>");
		process.exit(2);
	}
	const j = read(currentPath);
	const slim = {
		summaryLine: j.summaryLine,
		total: j.total, match: j.match, diff: j.diff, docdiff: j.docdiff, diagmsg: j.diagmsg, skip: j.skip,
		compareKeys: j.compareKeys,
		diffs: (j.diffs ?? []).map((d) => ({
			key: d.key, file: d.file, line: d.line, offset: d.offset, cmd: d.cmd,
			detail: d.detail, locClass: d.locClass, seqClass: d.seqClass,
		})),
		docdiffs: (j.docdiffs ?? []).map((d) => ({ key: d.key })),
		diagmsgs: (j.diagmsgs ?? []).map((d) => ({ key: d.key })),
	};
	// Committed baselines must be portable — refuse machine-local key prefixes.
	const local = CHANNELS.flatMap((ch) => slim[ch]).filter((d) => /^(?:nav|diag):(?:\/|[A-Za-z]:[\\/])/.test(d.key));
	if (local.length) {
		console.error(`--slim: ${local.length} keys carry absolute paths (e.g. ${local[0].key}) — regenerate with a current triage-sim-nav-shard.mjs`);
		process.exit(1);
	}
	fs.writeFileSync(outPath, JSON.stringify(slim, null, 2));
	console.log(`wrote slim baseline ${outPath} (${slim.diffs.length} diffs, ${slim.docdiffs.length} docdiffs, ${slim.diagmsgs.length} diagmsgs)`);
} else {
	console.error("usage: --out <merged.json> <shard.json...> | --baseline <baseline.json> <merged.json> | --slim <merged.json> <baseline-out.json>");
	process.exit(2);
}
