#!/usr/bin/env node
/**
 * Family-1 exhaustive cluster: quickinfo display/kind (≈1487) + success-mismatch (6).
 * Loads nav-results once in Node; never dumps bulk into agent context.
 * Writes /tmp/tnb-f1-cluster-summary.json + /tmp/tnb-f1-cluster-reps.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const NAV_JSON =
	process.env.NAV_JSON ??
	'/Users/johnsonchu/.cursor/skills/planner-executor/state/tnb/nav-results-2f79725.json';
const OUT_SUMMARY = '/tmp/tnb-f1-cluster-summary.json';
const OUT_REPS = '/tmp/tnb-f1-cluster-reps.json';
const OUT_LOG = '/tmp/tnb-f1-cluster.log';

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

function isTruncMarker(s) {
	return /…\(\+\d+ chars\)$/.test(s) || s.includes('…(+');
}

/** Tolerate truncated JSON: mark truncated; never hard-throw. */
function parseQiSnippet(raw) {
	if (raw == null) {
		return {
			ok: false,
			truncated: false,
			success: undefined,
			displayString: null,
			kind: null,
			documentation: null,
			tags: null,
			rawKind: 'null',
		};
	}
	const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
	const truncated = isTruncMarker(s);
	try {
		const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return {
			ok: true,
			truncated,
			success: t?.success,
			displayString: t?.displayString ?? null,
			kind: t?.kind ?? null,
			documentation: t?.documentation ?? null,
			tags: t?.tags ?? null,
			topKeys: Object.keys(t ?? {}),
		};
	} catch {
		// Linear extractions only — never open-ended regex on truncated JSON
		// (catastrophic backtracking on displayString has hung this tool before).
		const mSucc = s.match(/"success"\s*:\s*(true|false)/);
		return {
			ok: false,
			truncated: true,
			success: mSucc ? mSucc[1] === 'true' : undefined,
			displayString: extractJsonStringField(s, 'displayString'),
			kind: extractJsonStringField(s, 'kind'),
			documentation: extractJsonStringField(s, 'documentation'),
			tags: null,
			topKeys: ['(truncated)'],
			partial: true,
		};
	}
}

/** Extract `"field":"..."` with a linear scan; returns null if unterminated. */
function extractJsonStringField(s, field) {
	const key = `"${field}"`;
	const i = s.indexOf(key);
	if (i < 0) return null;
	let j = i + key.length;
	while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === ':')) j++;
	if (s[j] !== '"') return null;
	j++;
	let out = '';
	while (j < s.length) {
		const ch = s[j];
		if (ch === '\\') {
			out += s.slice(j, j + 2);
			j += 2;
			continue;
		}
		if (ch === '"') {
			try {
				return JSON.parse(`"${out}"`);
			} catch {
				return out.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
			}
		}
		out += ch;
		j++;
	}
	// unterminated (truncated) — return partial raw
	return out.replace(/\\n/g, '\n').replace(/\\"/g, '"');
}

function canonPaths(s) {
	let t = String(s ?? '');
	// Keep replacements linear / non-nested — long displayStrings are common.
	t = t.replace(/\/Users\/[A-Za-z0-9_./#+@%&=-]+/g, 'ABS');
	t = t.replace(/node_modules\/\.pnpm\/[^\s"'`)]+/g, 'PNPM');
	t = t.replace(/typescript@typescript-native-bridge[^\s"'`)]*/g, 'TNB_PKG');
	t = t.replace(/typescript@6[^\s"'`)]*/g, 'STOCK_PKG');
	t = t.replace(/\bLIB:[A-Za-z0-9_.-]+/g, 'LIB:X');
	return t;
}

function stripWs(s) {
	return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function lcsRatio(a, b) {
	// cheap similarity: shared prefix/suffix + length
	if (a === b) return 1;
	const n = Math.min(a.length, b.length);
	let pre = 0;
	while (pre < n && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < n - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const shared = pre + suf;
	return shared / Math.max(a.length, b.length, 1);
}

/**
 * Second-level patterns for displayString text diffs (data-driven heuristics).
 * Order matters: first match wins.
 */
function displayPattern(tnbDisp, stockDisp, meta = {}) {
	if (meta.truncated || meta.partial) return 'truncated-or-partial';
	const t0 = tnbDisp ?? '';
	const s0 = stockDisp ?? '';
	if (!t0 && s0) return 'tnb-empty-display';
	if (t0 && !s0) return 'stock-empty-display';
	if (!t0 && !s0) return 'both-empty-display';

	const t = canonPaths(t0);
	const s = canonPaths(s0);
	if (t === s) return 'path-only-canonical-equal';

	const tw = stripWs(t);
	const sw = stripWs(s);
	if (tw === sw) return 'whitespace-only';

	// module "path" form (must precede import() — both mention paths)
	if (/^module\s+/.test(tw) || /^module\s+/.test(sw)) return 'module-path-display';

	// type-parameter quickinfo enclosing sig (before import/__VLS_ — many overlap)
	if (/^\(type parameter\)/.test(t) || /^\(type parameter\)/.test(s)) {
		return 'type-parameter-enclosing';
	}

	// __VLS_* synthetic / volar plumbing
	if (/__VLS_/.test(t) || /__VLS_/.test(s)) {
		if (/__VLS_props|__VLS_ctx|__VLS_setup|__VLS_exposed/.test(t + s)) return 'volar-synthetic:setup-args';
		return 'volar-synthetic:other';
	}

	// import("pkg").X vs bare/resolved qualifier
	const tImp = /import\s*\(/.test(t);
	const sImp = /import\s*\(/.test(s);
	if (tImp !== sImp || (tImp && sImp && extractImports(t).join('|') !== extractImports(s).join('|'))) {
		if (/vue/.test(t + s) || /import\s*\(\s*["']vue["']\s*\)/.test(t + s)) return 'import-path:vue-qualifier';
		return 'import-path:module-qualifier';
	}

	// Truncation ellipsis style: ... vs … vs Record<...> denseness
	const tEll = (t.match(/\.\.\./g) || []).length + (t.match(/…/g) || []).length;
	const sEll = (s.match(/\.\.\./g) || []).length + (s.match(/…/g) || []).length;
	const tRec = (t.match(/Record<\.\.\.>/g) || []).length;
	const sRec = (s.match(/Record<\.\.\.>/g) || []).length;
	if (tEll !== sEll || tRec !== sRec) {
		if (Math.abs(t.length - s.length) > 40 || tEll + sEll > 0) return 'truncation-ellipsis-density';
	}

	// Alias expand vs keep: stock shows alias name, tnb expands or vice versa
	const tBrace = (t.match(/[{}]/g) || []).length;
	const sBrace = (s.match(/[{}]/g) || []).length;
	if (Math.abs(t.length - s.length) > 80 && Math.abs(tBrace - sBrace) >= 4) {
		return 'alias-expand-vs-compact';
	}

	// Promise / Awaited / NonNullable wrapper stack difference
	const wrapRe = /\b(Awaited|NonNullable|Partial|Required|Readonly|Pick|Omit|ReturnType|InstanceType|Promise)\b/g;
	const tW = new Set((t.match(wrapRe) || []));
	const sW = new Set((s.match(wrapRe) || []));
	const wrapDiff = [...tW].filter((x) => !sW.has(x)).length + [...sW].filter((x) => !tW.has(x)).length;
	if (wrapDiff >= 2 || (wrapDiff >= 1 && Math.abs(t.length - s.length) > 60)) {
		return 'utility-wrapper-print';
	}

	if (/<[A-Za-z_]/.test(t) && /<[A-Za-z_]/.test(s)) {
		const tg = collectGenerics(t);
		const sg = collectGenerics(s);
		if (tg !== sg && stripGenerics(t) === stripGenerics(s)) return 'generic-args-print';
	}

	// Literal type print: "x" vs 'x' vs `"x"` / true vs boolean literal
	if (/["'`]/.test(t) || /["'`]/.test(s)) {
		const tn = t.replace(/["'`]/g, '"');
		const sn = s.replace(/["'`]/g, '"');
		if (stripWs(tn) === stripWs(sn)) return 'literal-quote-style';
	}
	if (/\btrue\b|\bfalse\b|\d+n?\b/.test(t) && /\btrue\b|\bfalse\b|\d+n?\b/.test(s)) {
		const tLit = t.replace(/\b(true|false|\d+n?)\b/g, 'LIT');
		const sLit = s.replace(/\b(true|false|\d+n?)\b/g, 'LIT');
		if (stripWs(canonPaths(tLit)) === stripWs(canonPaths(sLit)) && t !== s) return 'literal-value-print';
	}

	// Modifier / keyword order: readonly? optional? export?
	const tMod = extractModifiers(t);
	const sMod = extractModifiers(s);
	if (tMod.join(',') !== sMod.join(',') && stripMods(t) === stripMods(s)) {
		return 'modifier-order-or-set';
	}

	// kind prefix in display: (property) vs (method) etc already in kind field;
	// display often starts with "(property) foo: ..."
	const tPref = t.match(/^\(([a-zA-Z ]+)\)/);
	const sPref = s.match(/^\(([a-zA-Z ]+)\)/);
	if (tPref && sPref && tPref[1] !== sPref[1]) return 'display-kind-prefix';

	// function/const/let/var binding print
	if (/^\((method|property|const|let|var|function|constructor|getter|setter|parameter|enum member)/.test(t) ||
		/^\((method|property|const|let|var|function|constructor|getter|setter|parameter|enum member)/.test(s)) {
		// quoted prop key: title? vs 'title'?
		if (/'\w+'|\?\s*:/.test(t + s) && /'\w+'/.test(t) !== /'\w+'/.test(s)) return 'quoted-property-name';
		if (lcsRatio(tw, sw) > 0.7) return 'binding-signature-shape';
		return 'binding-signature-deep';
	}

	// interface / type / class declaration header
	if (/^(interface|type|class|enum|namespace)\b/.test(tw) || /^(interface|type|class|enum|namespace)\b/.test(sw)) {
		return 'decl-header-print';
	}

	// union / intersection order or member print
	if ((t.includes('|') || s.includes('|') || t.includes('&') || s.includes('&')) && lcsRatio(tw, sw) > 0.5) {
		return 'union-intersection-print';
	}

	// Array vs T[] / ReadonlyArray
	if (/\bArray</.test(t) !== /\bArray</.test(s) || /\[\]/.test(t) !== /\[\]/.test(s)) {
		return 'array-syntax-print';
	}

	// this-type / typeof
	if (/\btypeof\b/.test(t) !== /\btypeof\b/.test(s) || /\bthis\b/.test(t) !== /\bthis\b/.test(s)) {
		return 'typeof-this-print';
	}

	// high similarity residual vs deep rewrite
	const sim = lcsRatio(tw, sw);
	if (sim >= 0.85) return 'near-equal-residual';
	if (sim >= 0.55) return 'medium-rewrite';
	return 'deep-rewrite';
}

function extractImports(s) {
	const out = [];
	const re = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
	let m;
	while ((m = re.exec(s))) out.push(m[1]);
	return out.sort();
}

function stripGenerics(s) {
	// rough: remove <...> balanced poorly — just remove angle chunks
	return s.replace(/<[^<>]*>/g, '<>');
}

function collectGenerics(s) {
	return (s.match(/<[^<>]{0,80}>/g) || []).join(';');
}

function extractModifiers(s) {
	const mods = [];
	const re = /\b(export|declare|readonly|optional|abstract|async|static|public|private|protected|override|const|get|set)\b/g;
	let m;
	while ((m = re.exec(s))) mods.push(m[1]);
	return mods;
}

function stripMods(s) {
	return stripWs(
		s.replace(
			/\b(export|declare|readonly|optional|abstract|async|static|public|private|protected|override)\b/g,
			'',
		),
	);
}

function classifyPrimary(tnb, stock) {
	const flags = [];
	const trunc = !!(tnb.truncated || stock.truncated || !tnb.ok || !stock.ok);
	if (trunc) flags.push('truncated');

	const tSucc = tnb.success;
	const sSucc = stock.success;
	if (tSucc !== sSucc && !(tSucc === undefined && sSucc === undefined)) flags.push('success');

	const tKind = tnb.kind ?? '';
	const sKind = stock.kind ?? '';
	if (tKind !== sKind) flags.push('kind');

	const tDisp = tnb.displayString ?? '';
	const sDisp = stock.displayString ?? '';
	if (tDisp !== sDisp) {
		flags.push('display');
		if (!tDisp && sDisp) flags.push('tnbEmptyDisplay');
		if (tDisp && !sDisp) flags.push('stockEmptyDisplay');
	}

	const tDocs = tnb.documentation ?? '';
	const sDocs = stock.documentation ?? '';
	if (tDocs !== sDocs) flags.push('docs');

	const tTags = JSON.stringify(tnb.tags ?? null);
	const sTags = JSON.stringify(stock.tags ?? null);
	if (tTags !== sTags) flags.push('tags');

	if (!flags.length) flags.push('unknown-opaque');
	return flags.sort().join('+');
}

fs.writeFileSync(OUT_LOG, '');
log(`NAV_JSON=${NAV_JSON} size=${fs.statSync(NAV_JSON).size}`);
const data = JSON.parse(fs.readFileSync(NAV_JSON, 'utf8'));
const diffs = data.diffs ?? [];
const f1 = diffs.filter((d) => d.cmd === 'quickinfo');
log(`allDiffs=${diffs.length} f1Quickinfo=${f1.length}`);

const clusters = new Map();
const displayClusters = new Map();
const primaryCounts = new Map();
const successMismatch = [];

function upsert(map, key, fields, d, tnb, stock, extra = {}) {
	let c = map.get(key);
	if (!c) {
		c = {
			...fields,
			key,
			count: 0,
			files: new Map(),
			reps: [],
		};
		map.set(key, c);
	}
	c.count++;
	const rel = String(d.file ?? '').replace(/.*\/test-workspace\//, '');
	c.files.set(rel || String(d.file), (c.files.get(rel || String(d.file)) ?? 0) + 1);
	if (c.reps.length < 3) {
		c.reps.push({
			key: d.key,
			file: d.file,
			fileKey: rel,
			line: d.line,
			offset: d.offset,
			cmd: d.cmd,
			detail: d.detail,
			seqClass: d.seqClass,
			tnbSuccess: tnb.success,
			stockSuccess: stock.success,
			tnbTruncated: tnb.truncated || !tnb.ok,
			stockTruncated: stock.truncated || !stock.ok,
			tnbKind: tnb.kind,
			stockKind: stock.kind,
			tnbDisplay: (tnb.displayString ?? '').slice(0, 500),
			stockDisplay: (stock.displayString ?? '').slice(0, 500),
			tnbDisplayLen: (tnb.displayString ?? '').length,
			stockDisplayLen: (stock.displayString ?? '').length,
			tnbDocs: (tnb.documentation ?? '').slice(0, 200),
			stockDocs: (stock.documentation ?? '').slice(0, 200),
			tnbTags: tnb.tags,
			stockTags: stock.tags,
			...extra,
		});
	}
}

let truncT = 0;
let truncS = 0;
let parseFail = 0;
let displayFieldDiffs = 0;
let iRow = 0;

for (const d of f1) {
	iRow++;
	if (iRow % 250 === 0) log(`progress ${iRow}/${f1.length}`);
	const tnb = parseQiSnippet(d.tnb);
	const stock = parseQiSnippet(d.stock);
	if (tnb.truncated) truncT++;
	if (stock.truncated) truncS++;
	if (!tnb.ok || !stock.ok) parseFail++;
	if (d.detail === 'quickinfo-display/kind' && (tnb.displayString ?? '') !== (stock.displayString ?? '')) {
		displayFieldDiffs++;
	}

	const shape = fileShape(d.file);
	const primary = classifyPrimary(tnb, stock);
	primaryCounts.set(primary, (primaryCounts.get(primary) ?? 0) + 1);

	const dPat =
		primary.includes('display') || primary.includes('tnbEmptyDisplay') || primary.includes('stockEmptyDisplay')
			? displayPattern(tnb.displayString, stock.displayString, {
					truncated: tnb.truncated || stock.truncated || !tnb.ok || !stock.ok,
					partial: tnb.partial || stock.partial,
				})
			: primary.includes('kind') && !primary.includes('display')
				? 'kind-only'
				: primary.includes('docs') && !primary.includes('display')
					? 'docs-only'
					: primary.includes('tags') && !primary.includes('display')
						? 'tags-only'
						: primary.includes('success')
							? 'success-only'
							: 'non-display';

	const fineKey = `${d.detail}|${primary}|${dPat}|${shape}|${d.seqClass}`;
	upsert(
		clusters,
		fineKey,
		{
			detail: d.detail,
			primary,
			displayPattern: dPat,
			fileShape: shape,
			seqClass: d.seqClass,
		},
		d,
		tnb,
		stock,
	);

	if (d.detail === 'quickinfo-display/kind' && primary.includes('display')) {
		const dk = dPat;
		upsert(displayClusters, dk, { displayPattern: dk }, d, tnb, stock, { primary });
	}

	if (d.detail === 'success-mismatch') {
		successMismatch.push({
			file: d.file,
			fileKey: String(d.file ?? '').replace(/.*\/test-workspace\//, ''),
			line: d.line,
			offset: d.offset,
			seqClass: d.seqClass,
			tnbSuccess: tnb.success,
			stockSuccess: stock.success,
			tnbTruncated: tnb.truncated || !tnb.ok,
			stockTruncated: stock.truncated || !stock.ok,
			tnbKind: tnb.kind,
			stockKind: stock.kind,
			tnbDisplay: tnb.displayString,
			stockDisplay: stock.displayString,
			tnbDocs: tnb.documentation,
			stockDocs: stock.documentation,
			primary,
			displayPattern: dPat,
		});
	}
}

const list = [...clusters.values()].sort((a, b) => b.count - a.count);
const dispList = [...displayClusters.values()].sort((a, b) => b.count - a.count);
const sum = list.reduce((a, c) => a + c.count, 0);
const dispSum = dispList.reduce((a, c) => a + c.count, 0);
const displayKind = f1.filter((d) => d.detail === 'quickinfo-display/kind');
const succN = f1.filter((d) => d.detail === 'success-mismatch').length;

const summary = {
	allDiffs: diffs.length,
	f1Total: f1.length,
	displayKindN: displayKind.length,
	successMismatchN: succN,
	clusterSum: sum,
	conserved: sum === f1.length,
	fineClusterCount: list.length,
	displayPatternSum: dispSum,
	displayPatternConservedVsDisplayDiffs: null, // filled below
	truncT,
	truncS,
	parseFail,
	primary: [...primaryCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => ({ n, k })),
	displayPatterns: dispList.map((c) => ({
		pattern: c.key,
		count: c.count,
		topFiles: [...c.files.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([f, n]) => ({ f, n })),
		reps: c.reps.map((r) => ({
			file: r.fileKey,
			line: r.line,
			offset: r.offset,
			tnbKind: r.tnbKind,
			stockKind: r.stockKind,
			tnbDisplay: r.tnbDisplay,
			stockDisplay: r.stockDisplay,
			tnbDisplayLen: r.tnbDisplayLen,
			stockDisplayLen: r.stockDisplayLen,
		})),
	})),
	successMismatch,
	clusters: list.map((c) => ({
		key: c.key,
		count: c.count,
		detail: c.detail,
		primary: c.primary,
		displayPattern: c.displayPattern,
		fileShape: c.fileShape,
		seqClass: c.seqClass,
		topFiles: [...c.files.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([f, n]) => ({ f, n })),
		reps: c.reps.map((r) => ({
			file: r.fileKey,
			line: r.line,
			offset: r.offset,
			tnbKind: r.tnbKind,
			stockKind: r.stockKind,
			tnbDisplay: r.tnbDisplay,
			stockDisplay: r.stockDisplay,
			tnbDocs: r.tnbDocs,
			stockDocs: r.stockDocs,
			tnbTruncated: r.tnbTruncated,
			stockTruncated: r.stockTruncated,
		})),
	})),
};

summary.displayFieldDiffs = displayFieldDiffs;
summary.displayPatternConservedVsDisplayDiffs = dispSum === displayFieldDiffs;

fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));
fs.writeFileSync(
	OUT_REPS,
	JSON.stringify(
		{
			displayPatterns: dispList.map((c) => ({ key: c.key, count: c.count, reps: c.reps })),
			fine: list.map((c) => ({ key: c.key, count: c.count, reps: c.reps })),
			successMismatch,
		},
		null,
		2,
	),
);

log(
	`f1Total=${f1.length} displayKind=${displayKind.length} successMismatch=${succN} clusterSum=${sum} conserved=${sum === f1.length} fineClusters=${list.length}`,
);
log(
	`displayFieldDiffs=${displayFieldDiffs} displayPatternSum=${dispSum} displayPatternConserved=${dispSum === displayFieldDiffs}`,
);
log(`truncT=${truncT} truncS=${truncS} parseFail=${parseFail}`);
log('--- primary ---');
for (const { n, k } of summary.primary) log(`  ${n}\t${k}`);
log('--- displayPatterns ---');
for (const p of summary.displayPatterns) log(`  ${p.count}\t${p.pattern}`);
log('--- fine top 40 ---');
for (const c of list.slice(0, 40)) log(`  ${c.count}\t${c.key}`);
log('--- success-mismatch ---');
for (const r of successMismatch) {
	log(
		`  ${r.fileKey}:${r.line}:${r.offset} tnb=${r.tnbSuccess} stock=${r.stockSuccess} primary=${r.primary} pat=${r.displayPattern}`,
	);
}
log(`wrote ${OUT_SUMMARY}`);
