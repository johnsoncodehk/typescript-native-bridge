#!/usr/bin/env node
/**
 * Family-2 exhaustive cluster (10MB nav-results). Runs in-process only — no tsserver.
 * Loads JSON once in Node (OK); does not dump bulk into agent context.
 * Writes /tmp/tnb-f2-cluster-summary.json + /tmp/tnb-f2-cluster-reps.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const NAV_JSON =
	process.env.NAV_JSON ??
	'/Users/johnsonchu/.cursor/skills/planner-executor/state/tnb/nav-results-9c555aa.json';
const OUT_SUMMARY = '/tmp/tnb-f2-cluster-summary.json';
const OUT_REPS = '/tmp/tnb-f2-cluster-reps.json';
const OUT_LOG = '/tmp/tnb-f2-cluster.log';

const F2_CMDS = new Set(['references', 'definitionAndBoundSpan', 'documentHighlights']);

function log(s) {
	const line = typeof s === 'string' ? s : JSON.stringify(s);
	console.log(line);
	fs.appendFileSync(OUT_LOG, line + '\n');
}

function fileShape(file) {
	const f = String(file ?? '');
	if (f.endsWith('.vue')) return 'vue';
	if (/\.(tsx?|d\.ts)$/.test(f)) return 'ts';
	if (/\.jsx?$/.test(f)) return 'js';
	return 'other';
}

/** Tolerate truncated JSON: pull success via regex if parse fails. */
function parseNavSnippet(raw) {
	if (raw == null) return { ok: false, truncated: false, success: undefined, locs: [], rawKind: 'null' };
	const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
	const truncated = /…\(\+\d+ chars\)$/.test(s) || s.includes('…(+');
	try {
		const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
		const locs = Array.isArray(t?.locs) ? t.locs.map(String) : [];
		return {
			ok: true,
			truncated,
			success: t?.success,
			locs,
			message: t?.message,
			error: t?.error,
			topKeys: Object.keys(t ?? {}),
		};
	} catch {
		const mSucc = s.match(/"success"\s*:\s*(true|false)/);
		const mMsg = s.match(/"message"\s*:\s*"([^"\\]*)/);
		const locs = [];
		const re = /"([^"]+\.(?:vue|ts|tsx|js|d\.ts)\|[\d]+\|[\d]+)"/g;
		let m;
		while ((m = re.exec(s)) !== null) locs.push(m[1]);
		return {
			ok: false,
			truncated: true,
			success: mSucc ? mSucc[1] === 'true' : undefined,
			locs,
			message: mMsg?.[1],
			topKeys: ['(truncated)'],
			partialLocs: true,
		};
	}
}

function successLabel(v) {
	if (v === undefined) return 'undefined';
	return String(!!v);
}

function classLocFile(filePart) {
	const file = String(filePart ?? '');
	if (!file) return 'empty';
	if (file.includes('node_modules') || file.includes('/.pnpm/')) return 'node_modules';
	if (file.includes('/lib/lib.') && file.endsWith('.d.ts')) return 'tslib';
	if (file.endsWith('.d.ts')) return 'dts';
	if (file.includes('.vue')) {
		// generated virtual scripts often appear as path with .vue.ts or __VLS
		if (file.includes('__VLS') || file.includes('.vue.') || file.includes('+')) return 'vue-virtual';
		return 'vue';
	}
	if (/\.(tsx?|jsx?)$/.test(file)) return 'tsjs';
	return 'other';
}

function classifyLocDiff(tnbLocs, stockLocs, queryFile) {
	const tSet = new Set(tnbLocs);
	const sSet = new Set(stockLocs);
	const onlyTnb = [...tSet].filter((x) => !sSet.has(x));
	const onlyStock = [...sSet].filter((x) => !tSet.has(x));
	const tally = (keys) => {
		const c = {};
		for (const k of keys) {
			const file = String(k).split('|')[0];
			const cls = classLocFile(file);
			c[cls] = (c[cls] ?? 0) + 1;
			const sameFile = file === queryFile || file.endsWith('/' + path.basename(queryFile));
			if (sameFile) c.sameFile = (c.sameFile ?? 0) + 1;
			else c.crossFile = (c.crossFile ?? 0) + 1;
		}
		return { ...c, n: keys.length };
	};
	return {
		tnbN: tnbLocs.length,
		stockN: stockLocs.length,
		onlyTnbN: onlyTnb.length,
		onlyStockN: onlyStock.length,
		onlyTnb: tally(onlyTnb),
		onlyStock: tally(onlyStock),
		onlyStockSample: onlyStock.slice(0, 6),
		onlyTnbSample: onlyTnb.slice(0, 6),
	};
}

fs.writeFileSync(OUT_LOG, '');
log(`NAV_JSON=${NAV_JSON} size=${fs.statSync(NAV_JSON).size}`);
const data = JSON.parse(fs.readFileSync(NAV_JSON, 'utf8'));
const diffs = data.diffs ?? [];
const f2 = diffs.filter((d) => F2_CMDS.has(d.cmd));
log(`allDiffs=${diffs.length} f2=${f2.length}`);

const clusters = new Map();

function upsert(key, fields, d, tnbP, stockP, loc) {
	let c = clusters.get(key);
	if (!c) {
		c = {
			...fields,
			key,
			count: 0,
			files: new Map(),
			messages: new Map(),
			reps: [],
			locAgg: {
				onlyStock: {},
				onlyTnb: {},
				sumTnbN: 0,
				sumStockN: 0,
				nWithLocs: 0,
			},
		};
		clusters.set(key, c);
	}
	c.count++;
	const rel = String(d.file ?? '')
		.replace(/.*\/test-workspace\//, '')
		.replace(/^\//, '');
	// file may already be relative in findings
	const rel2 = d.file?.includes('test-workspace')
		? rel
		: String(d.file ?? '').replace(/^.*\/(component-meta|tsc|tsconfigProject)\//, (m, g) => `${g}/`);
	const fileKey = rel.includes('/') ? rel : String(d.file ?? '');
	c.files.set(fileKey, (c.files.get(fileKey) ?? 0) + 1);
	if (tnbP.message) {
		const m = String(tnbP.message).split('\n')[0].slice(0, 160);
		c.messages.set(m, (c.messages.get(m) ?? 0) + 1);
	}
	if (loc && (tnbP.locs.length || stockP.locs.length)) {
		c.locAgg.nWithLocs++;
		c.locAgg.sumTnbN += loc.tnbN;
		c.locAgg.sumStockN += loc.stockN;
		for (const [k, v] of Object.entries(loc.onlyStock)) {
			if (k === 'n') continue;
			c.locAgg.onlyStock[k] = (c.locAgg.onlyStock[k] ?? 0) + v;
		}
		for (const [k, v] of Object.entries(loc.onlyTnb)) {
			if (k === 'n') continue;
			c.locAgg.onlyTnb[k] = (c.locAgg.onlyTnb[k] ?? 0) + v;
		}
	}
	if (c.reps.length < 2) {
		c.reps.push({
			key: d.key,
			file: d.file,
			fileKey,
			line: d.line,
			offset: d.offset,
			cmd: d.cmd,
			detail: d.detail,
			seqClass: d.seqClass,
			tnbSuccess: tnbP.success,
			stockSuccess: stockP.success,
			tnbTruncated: tnbP.truncated || !tnbP.ok,
			stockTruncated: stockP.truncated || !stockP.ok,
			tnbMessage: tnbP.message,
			stockMessage: stockP.message,
			loc,
			tnbTopKeys: tnbP.topKeys,
			stockTopKeys: stockP.topKeys,
			tnbLocsSample: tnbP.locs.slice(0, 8),
			stockLocsSample: stockP.locs.slice(0, 8),
		});
	}
}

for (const d of f2) {
	const tnbP = parseNavSnippet(d.tnb);
	const stockP = parseNavSnippet(d.stock);
	const pair = `${successLabel(tnbP.success)}/${successLabel(stockP.success)}`;
	const shape = fileShape(d.file);
	const loc =
		d.detail === 'loc-set-mismatch' || d.detail === 'success-mismatch'
			? classifyLocDiff(tnbP.locs, stockP.locs, d.file)
			: null;

	// Fine cluster: detail × successPair × fileShape × (optional miss class)
	let missKind = 'n/a';
	if (d.detail === 'loc-set-mismatch' && loc) {
		const os = loc.onlyStock;
		const ot = loc.onlyTnb;
		const dominant = (obj) => {
			const entries = Object.entries(obj).filter(([k]) => !['n', 'sameFile', 'crossFile'].includes(k));
			entries.sort((a, b) => b[1] - a[1]);
			return entries[0]?.[0] ?? 'empty';
		};
		if (loc.onlyStockN > 0 && loc.onlyTnbN === 0) missKind = `tnb-missing:${dominant(os)}`;
		else if (loc.onlyTnbN > 0 && loc.onlyStockN === 0) missKind = `tnb-extra:${dominant(ot)}`;
		else if (loc.onlyStockN > 0 && loc.onlyTnbN > 0) missKind = `both:${dominant(os)}+${dominant(ot)}`;
		else missKind = 'empty-or-truncated';
	} else if (d.detail === 'success-mismatch') {
		missKind = tnbP.message ? `msg:${String(tnbP.message).split('\n')[0].slice(0, 60)}` : 'no-message';
	} else if (d.detail === 'error/timeout') {
		missKind = 'error/timeout';
	}

	const key = `${d.cmd}|${d.detail}|${pair}|${d.seqClass}|${shape}|${missKind}`;
	upsert(
		key,
		{
			cmd: d.cmd,
			detail: d.detail,
			successPair: pair,
			seqClass: d.seqClass,
			fileShape: shape,
			missKind,
		},
		d,
		tnbP,
		stockP,
		loc,
	);
}

const list = [...clusters.values()].sort((a, b) => b.count - a.count);
const sum = list.reduce((a, c) => a + c.count, 0);

// Also planner-style coarse sig for cross-check
const coarse = new Map();
for (const d of f2) {
	const tnbP = parseNavSnippet(d.tnb);
	const stockP = parseNavSnippet(d.stock);
	const pair = `${successLabel(tnbP.success)}/${successLabel(stockP.success)}`;
	const k = `${d.cmd}|${d.detail}|${pair}|${d.seqClass}`;
	coarse.set(k, (coarse.get(k) ?? 0) + 1);
}

const summary = {
	allDiffs: diffs.length,
	f2Total: f2.length,
	clusterSum: sum,
	conserved: sum === f2.length,
	fineClusterCount: list.length,
	byCmd: Object.fromEntries(
		['references', 'definitionAndBoundSpan', 'documentHighlights'].map((c) => [
			c,
			f2.filter((d) => d.cmd === c).length,
		]),
	),
	byDetail: (() => {
		const m = {};
		for (const d of f2) m[d.detail] = (m[d.detail] ?? 0) + 1;
		return m;
	})(),
	coarseSig: [...coarse.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => ({ n, k })),
	clusters: list.map((c) => ({
		key: c.key,
		count: c.count,
		cmd: c.cmd,
		detail: c.detail,
		successPair: c.successPair,
		seqClass: c.seqClass,
		fileShape: c.fileShape,
		missKind: c.missKind,
		topFiles: [...c.files.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([f, n]) => ({ f, n })),
		messages: [...c.messages.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([m, n]) => ({ m, n })),
		locAgg: c.locAgg,
		reps: c.reps.map((r) => ({
			file: r.file,
			fileKey: r.fileKey,
			line: r.line,
			offset: r.offset,
			tnbSuccess: r.tnbSuccess,
			stockSuccess: r.stockSuccess,
			tnbTruncated: r.tnbTruncated,
			stockTruncated: r.stockTruncated,
			tnbMessage: r.tnbMessage,
			loc: r.loc
				? {
						tnbN: r.loc.tnbN,
						stockN: r.loc.stockN,
						onlyStockN: r.loc.onlyStockN,
						onlyTnbN: r.loc.onlyTnbN,
						onlyStock: r.loc.onlyStock,
						onlyTnb: r.loc.onlyTnb,
						onlyStockSample: r.loc.onlyStockSample,
						onlyTnbSample: r.loc.onlyTnbSample,
					}
				: null,
		})),
	})),
};

fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));
fs.writeFileSync(
	OUT_REPS,
	JSON.stringify(
		list.map((c) => ({
			key: c.key,
			count: c.count,
			reps: c.reps,
		})),
		null,
		2,
	),
);

log(`f2Total=${f2.length} clusterSum=${sum} conserved=${sum === f2.length} fineClusters=${list.length}`);
log('--- coarse ---');
for (const { n, k } of summary.coarseSig) log(`  ${n}\t${k}`);
log('--- fine top 50 ---');
for (const c of list.slice(0, 50)) log(`  ${c.count}\t${c.key}`);
log(`wrote ${OUT_SUMMARY}`);
