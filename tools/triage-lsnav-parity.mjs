#!/usr/bin/env node
/**
 * LS nav bridge protocol witness (issue #12 batch 1): TNB vs stock tsserver,
 * quickinfo / references / definitionAndBoundSpan over a deterministic fixture.
 * TNB serves these three commands from the Go-side arena bridge (services
 * reroute); stock composes them in JS.
 *
 * references compares loc SETS (symbol/entry ordering is not contractual);
 * quickinfo and definitionAndBoundSpan compare exact normalized bodies.
 * quickinfo runs twice: displayPartsForJSDoc true and false.
 *
 * v5 policy: display content is engine behavior referenced to pristine tsgo,
 * not stock. Diffs vs stock whose cause is a reverted stock-parity patch live
 * in KNOWN_DIVERGENCES keyed by probe key, with attribution classes:
 *   T-SEMI  tsgo prints a body-less signature declaration with its trailing
 *           ';' (pristine hover.go); stock's symbol display trims it.
 *   T-FLAT  tsgo's displayPartsWriter flattens line breaks to spaces
 *           (pristine WriteLine); stock emits lineBreak parts, so object
 *           type literals print multiline.
 *   T-ALIAS tsgo displays an alias as the resolved symbol's own display
 *           (pristine hover.go); stock shows the shorthand form plus an
 *           "import X" line.
 *   T-PARAM tsgo's declarationJSDocTags does not assign the declaring
 *           function's @param tags to the parameter (pristine jsdoc.go);
 *           stock surfaces the tag on parameter quickinfo.
 * A registered key whose sides converged FAILS as stale so the list cannot
 * rot — when pristine tsgo converges with stock, the gate demands removal.
 *
 * Usage: node tools/triage-lsnav-parity.mjs
 * SUMMARY: total=T match=M known=K diff=D (exit 1 when D>0 or a stale key)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

// ── Known divergences (probe key → class reason; see header) ───────────────
const REASON = {
	'T-SEMI': 'T-SEMI: tsgo keeps the trailing \';\' on signature displays (pristine tsgo reference)',
	'T-FLAT': 'T-FLAT: tsgo flattens display line breaks to spaces (pristine tsgo reference)',
	'T-ALIAS': 'T-ALIAS: tsgo alias display has no shorthand+import-line form (pristine tsgo reference)',
	'T-PARAM': 'T-PARAM: tsgo does not surface @param tags on parameter quickinfo (pristine tsgo reference)',
};
const KNOWN_DIVERGENCES = new Map([
	// T-SEMI — signature displayString / references symbolDisplayString
	['quickinfo:a.ts:7:17:true:fn decl', REASON['T-SEMI']],
	['quickinfo:a.ts:7:17:false:fn decl', REASON['T-SEMI']],
	['quickinfo:b.ts:7:17:true:fn decl (b)', REASON['T-SEMI']],
	['quickinfo:b.ts:7:17:false:fn decl (b)', REASON['T-SEMI']],
	['quickinfo:a.ts:8:13:true:alias usage', REASON['T-SEMI']],
	['quickinfo:a.ts:8:13:false:alias usage', REASON['T-SEMI']],
	['references:a.ts:7:17:true:fn decl', REASON['T-SEMI']],
	['references:b.ts:7:17:true:fn decl (b)', REASON['T-SEMI']],
	['references:a.ts:8:13:true:alias usage', REASON['T-SEMI']],
	// T-FLAT — object-literal property type display
	['quickinfo:a.ts:11:21:true:shorthand local', REASON['T-FLAT']],
	['quickinfo:a.ts:11:21:false:shorthand local', REASON['T-FLAT']],
	['references:a.ts:11:21:true:shorthand local', REASON['T-FLAT']],
	// T-ALIAS — alias call display form
	['quickinfo:a.ts:9:14:true:call usage', REASON['T-ALIAS']],
	['quickinfo:a.ts:9:14:false:call usage', REASON['T-ALIAS']],
	['references:a.ts:9:14:true:call usage', REASON['T-ALIAS']],
	// T-PARAM — parameter quickinfo tags
	['quickinfo:a.ts:7:26:true:type ref', REASON['T-PARAM']],
	['quickinfo:a.ts:7:26:false:type ref', REASON['T-PARAM']],
]);

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const CMD_TIMEOUT_MS = 30_000;

// ── Fixture ────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-lsnav-fixture-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, types: [] },
	include: ['*.ts'],
}, null, 2));
const bTs = path.join(dir, 'b.ts');
const aTs = path.join(dir, 'a.ts');
const bSrc = `/** A documented interface. */
export interface Thing {
	/** the name property */
	name: string;
	value?: number;
}
export function makeThing(name: string): Thing {
	return { name };
}
export const thing: Thing = makeThing("x");
`;
const aSrc = `import { makeThing, thing, type Thing } from "./b";
import "./b";
/** doc on fn
 * @param t the thing input
 * @returns the name string
 */
export function useThing(t: Thing): string { return t.name; }
const out = useThing(thing);
const made = makeThing("y");
const aliasObj = { thing };
const shorthand = { aliasObj };
export class Greeter {
	private greeting = "hi";
	get message(): string { return this.greeting; }
	set message(v: string) { this.greeting = v; }
}
const g = new Greeter();
g.message = "yo";
const msg = g.message;
const café = 1;
const afterCafé = café;
switch (msg) { case "x": break; default: break; }
`;
fs.writeFileSync(aTs, aSrc);
fs.writeFileSync(bTs, bSrc);

// (file, needle, occurrence) — every position probed with all three commands.
const PROBES = [
	{ file: aTs, needle: 'useThing(t: Thing', note: 'fn decl' },
	{ file: aTs, needle: 't: Thing', note: 'type ref' },
	{ file: aTs, needle: 'makeThing("y")', note: 'call usage' },
	{ file: aTs, needle: 'useThing(thing)', note: 'alias usage' },
	{ file: aTs, needle: 'thing }', note: 'shorthand alias' },
	{ file: aTs, needle: 'aliasObj }', note: 'shorthand local' },
	{ file: aTs, needle: 'this.greeting', note: 'private prop' },
	{ file: aTs, needle: 'g.message = "yo"', note: 'accessor write' },
	{ file: aTs, needle: '= g.message', note: 'accessor read' },
	{ file: aTs, needle: 'afterCafé = café', note: 'post-non-ascii' },
	{ file: aTs, needle: 'case "x"', note: 'case keyword' },
	{ file: aTs, needle: 'import {', note: 'import keyword' },
	{ file: bTs, needle: 'name: string', note: 'doc prop' },
	{ file: bTs, needle: 'makeThing(name', note: 'fn decl (b)' },
	{ file: bTs, needle: 'Thing = makeThing', note: 'typed const' },
	{ file: bTs, needle: '{ name }', note: 'shorthand return' },
	{ file: aTs, needle: '"./b"', note: 'module specifier (named)' },
	{ file: aTs, needle: '"./b";', note: 'module specifier (side-effect)' },
];
const CMDS = ['quickinfo', 'references', 'definitionAndBoundSpan'];

function offsetToLineCol(text, off) {
	let line = 1, col = 1;
	for (let i = 0; i < off; i++) {
		if (text[i] === '\n') { line++; col = 1; } else col++;
	}
	return { line, offset: col };
}

const norm = v => JSON.stringify(v, (k, x) => {
	if (x && typeof x === 'object' && !Array.isArray(x)) return Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)));
	return x;
});

function refsToSet(body) {
	// Gate semantics mirror sim-nav: file|line|offset|flags (context spans are
	// compared separately as warnings — tsgo FAR does not yet attach context to
	// module-specifier string-literal entries; stock does).
	const refs = (body?.refs ?? []).map(r =>
		[r.file, r.start?.line, r.start?.offset, r.end?.line, r.end?.offset, r.isWriteAccess, r.isDefinition].join('|'),
	);
	refs.sort();
	const contexts = (body?.refs ?? []).map(r =>
		[r.file, r.start?.line, r.start?.offset, r.contextStart?.line ?? 0, r.contextStart?.offset ?? 0, r.contextEnd?.line ?? 0, r.contextEnd?.offset ?? 0].join('|'),
	);
	contexts.sort();
	return {
		refs,
		contexts,
		symbolName: body?.symbolName ?? null,
		symbolStartOffset: body?.symbolStartOffset ?? null,
		symbolDisplayString: body?.symbolDisplayString ?? null,
	};
}

function compare(cmd, tnb, stock) {
	if (!!tnb?.success !== !!stock?.success) {
		return { ok: false, detail: `success ${tnb?.success} vs ${stock?.success}` };
	}
	if (!tnb?.success) return { ok: true };
	if (cmd === 'references') {
		const a = refsToSet(tnb.body), b = refsToSet(stock.body);
		if (norm(a.refs) !== norm(b.refs) || a.symbolName !== b.symbolName || a.symbolStartOffset !== b.symbolStartOffset || a.symbolDisplayString !== b.symbolDisplayString) {
			const only = (x, y) => x.refs.filter(r => !y.refs.includes(r));
			return { ok: false, detail: 'refs-set', tnb: { ...a, onlyTnb: only(a, b) }, stock: { ...b, onlyStock: only(b, a) } };
		}
		if (norm(a.contexts) !== norm(b.contexts)) {
			return { ok: true, warn: `context-span diff: tnb=${norm(a.contexts)} stock=${norm(b.contexts)}` };
		}
		return { ok: true };
	}
	if (norm(tnb.body) !== norm(stock.body)) {
		return { ok: false, detail: 'body', tnb: tnb.body, stock: stock.body };
	}
	return { ok: true };
}

async function openBoth(send, file, content) {
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: content, projectRootPath: dir }] }, CMD_TIMEOUT_MS);
}

async function runSide(label, tsserverPath, envExtra, results) {
	await withTsserver(
		{ tsserverPath, args: ['--disableAutomaticTypingAcquisition'], env: envExtra, deadlineMs: 10 * 60 * 1000 },
		async ({ send, server }) => {
			server.stderr?.on?.('data', d => process.stdout.write(`[${label} stderr] ` + d));
			await openBoth(send, aTs, aSrc);
			await openBoth(send, bTs, bSrc);
			for (const pref of [true, false]) {
				console.log(`[${label}] configure displayPartsForJSDoc=${pref}`);
				await send('configure', { preferences: { displayPartsForJSDoc: pref } }, CMD_TIMEOUT_MS);
				for (const probe of PROBES) {
					const src = probe.file === aTs ? aSrc : bSrc;
					const off = src.indexOf(probe.needle);
					if (off < 0) throw new Error(`probe missing: ${probe.needle}`);
					const lc = offsetToLineCol(src, off);
					for (const cmd of CMDS) {
						if (cmd !== 'quickinfo' && pref === false) continue; // pref only affects quickinfo
						const key = `${cmd}:${path.basename(probe.file)}:${lc.line}:${lc.offset}:${pref}:${probe.note}`;
						console.log(`[${label}] ${key}`);
						try {
							const resp = await send(cmd, { file: probe.file, line: lc.line, offset: lc.offset }, CMD_TIMEOUT_MS);
							results.set(key, resp);
						} catch (err) {
							results.set(key, { error: String(err?.message ?? err) });
						}
					}
				}
			}
		},
	);
	console.log(`[${label}] done results=${results.size}`);
}

const tnbResults = new Map();
const stockResults = new Map();
await runSide('TNB', tnbPath, tnbHarnessEnv({}), tnbResults);
await runSide('STOCK', stockPath, {}, stockResults);

let match = 0, known = 0, diff = 0, stale = 0;
const diffs = [];
const warns = [];
const seenKnown = new Set();
for (const [key, t] of tnbResults) {
	const s = stockResults.get(key);
	const cmd = key.split(':')[0];
	if (t?.error || s?.error) {
		diff++;
		seenKnown.add(key); // an error already fails the gate; don't double-flag as stale
		diffs.push({ key, detail: `error tnb=${t?.error} stock=${s?.error}` });
		continue;
	}
	const cmp = compare(cmd, t, s);
	if (cmp.ok) {
		if (KNOWN_DIVERGENCES.has(key)) {
			stale++;
			seenKnown.add(key);
			console.log(`FAIL ${key}: STALE EXEMPTION — sides converged, remove the KNOWN_DIVERGENCES entry (${KNOWN_DIVERGENCES.get(key)})`);
			continue;
		}
		match++;
		if (cmp.warn) warns.push({ key, warn: cmp.warn });
	} else if (KNOWN_DIVERGENCES.has(key)) {
		known++;
		seenKnown.add(key);
		console.log(`KNOWN ${key} — ${KNOWN_DIVERGENCES.get(key)}`);
	} else {
		diff++;
		diffs.push({ key, ...cmp, tnb: cmp.tnb ?? undefined, stock: cmp.stock ?? undefined });
	}
}
for (const key of KNOWN_DIVERGENCES.keys()) {
	if (!seenKnown.has(key)) {
		stale++;
		console.log(`FAIL ${key}: STALE EXEMPTION — probe no longer diverges, remove the KNOWN_DIVERGENCES entry (${KNOWN_DIVERGENCES.get(key)})`);
	}
}
console.log(`SUMMARY total=${match + known + diff} match=${match} known=${known} diff=${diff} warn=${warns.length} stale=${stale}`);
for (const w of warns) console.log(`WARN ${w.key}: ${w.warn.slice(0, 300)}`);
for (const d of diffs.slice(0, 12)) {
	console.log(`\nDIFF ${d.key}: ${d.detail}`);
	if (d.tnb !== undefined) console.log('  tnb  :', norm(d.tnb)?.slice(0, 900));
	if (d.stock !== undefined) console.log('  stock:', norm(d.stock)?.slice(0, 900));
}
fs.writeFileSync('/tmp/tnb-lsnav-parity-diffs.json', JSON.stringify(diffs, null, 1));
process.exit(diff === 0 && stale === 0 ? 0 : 1);
