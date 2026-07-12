#!/usr/bin/env node
/**
 * Misc batch 2+5+6 parity for 7 TypeChecker RPCs:
 * getPromiseType, getPromiseLikeType, getAnyAsyncIterableType,
 * getExactOptionalProperties, getJsxNamespace, getJsxFragmentFactory,
 * getParameterIdentifierInfoAtPosition.
 *
 * Dual-server: TNB vs stock. Fixtures in /tmp/tnb-misc8-fixtures/.
 *
 * Markers: slash-star-N:cmd-star-slash
 *   cf  = semantic/suggestion diags → getCodeFixes
 *   oi  = organizeImports
 *   ih  = provideInlayHints
 *
 * Usage: node tools/triage-misc8-batch.mjs
 * Output: positions=N matched=M diff=D
 *
 * With TNB_TRACE_THROW=1 TNB_TRACE_THROW_FILE=/tmp/...jsonl, throw hits are
 * recorded for baseline / post-fix verification.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const fixtureDir = '/tmp/tnb-misc8-fixtures';

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--suppressDiagnosticEvents',
];

const TSCONFIG_BASE = {
	compilerOptions: {
		target: 'ES2020',
		module: 'ESNext',
		moduleResolution: 'bundler',
		strict: true,
		noEmit: true,
		lib: ['ES2020', 'DOM'],
	},
	include: ['*.ts', '*.tsx'],
};

const TSCONFIG_EXACT = {
	compilerOptions: {
		...TSCONFIG_BASE.compilerOptions,
		exactOptionalPropertyTypes: true,
	},
	include: ['*.ts', '*.tsx'],
};

const TSCONFIG_JSX = {
	compilerOptions: {
		...TSCONFIG_BASE.compilerOptions,
		jsx: 'react',
	},
	include: ['*.ts', '*.tsx'],
};

const TSCONFIG_JSX_FRAG = {
	compilerOptions: {
		...TSCONFIG_BASE.compilerOptions,
		jsx: 'react',
		jsxFactory: 'React.createElement',
		jsxFragmentFactory: 'React.Fragment',
	},
	include: ['*.ts', '*.tsx'],
};

/** getPromiseType / getPromiseLikeType — 80006 convertToAsyncFunction */
const PROMISE_ASYNC = `// getPromiseType / getPromiseLikeType
function /*1:cf*/fetchUser() {
  return Promise.resolve({ id: 1 }).then(u => u.id);
}
`;

/** getAnyAsyncIterableType — for-of on async iterable without await */
const ASYNC_ITER = `// getAnyAsyncIterableType
declare function getAsyncItems(): AsyncIterable<number>;
async function consume() {
  for (const x of /*2:cf*/getAsyncItems()) {
    console.log(x);
  }
}
`;

/** getExactOptionalProperties — 2412 addOptionalPropertyUndefined */
const EXACT_OPT = `// getExactOptionalProperties
type Opts = { a?: number };
const o: Opts = {};
o./*3:cf*/a = undefined;
`;

/** getJsxNamespace — missing React import (2304 importFixes) */
const JSX_NS = `// getJsxNamespace
export const el = /*4:cf*/<div />;
`;

/** getJsxFragmentFactory — fragment + organizeImports */
const JSX_FRAG = `// getJsxFragmentFactory
import { Fragment as Unused } from "react";
export const frag = /*5:oi*/<></>;
`;

/** getParameterIdentifierInfoAtPosition — inlay parameter name hints */
const INLAY = `// getParameterIdentifierInfoAtPosition
declare function greet(name: string, age: number): void;
greet(/*6:ih*/"Ada", 36);
`;

/** @typedef {{ dir: string; tsconfig?: object; files: Record<string, string> }} Project */

/** @type {Project[]} */
const PROJECTS = [
	{ dir: 'm1-promise', files: { 'promise.ts': PROMISE_ASYNC } },
	{ dir: 'm2-asynciter', files: { 'asynciter.ts': ASYNC_ITER } },
	{ dir: 'm3-exact', tsconfig: TSCONFIG_EXACT, files: { 'exact.ts': EXACT_OPT } },
	{ dir: 'm4-jsxns', tsconfig: TSCONFIG_JSX, files: { 'jsxns.tsx': JSX_NS } },
	{ dir: 'm5-jsxfrag', tsconfig: TSCONFIG_JSX_FRAG, files: { 'jsxfrag.tsx': JSX_FRAG } },
	{ dir: 'm6-inlay', files: { 'inlay.ts': INLAY } },
];

function ensureFixtures() {
	fs.rmSync(fixtureDir, { recursive: true, force: true });
	fs.mkdirSync(fixtureDir, { recursive: true });
	for (const proj of PROJECTS) {
		const root = path.join(fixtureDir, proj.dir);
		fs.mkdirSync(root, { recursive: true });
		const tsconfig = proj.tsconfig ?? TSCONFIG_BASE;
		fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
		for (const [name, content] of Object.entries(proj.files)) {
			fs.writeFileSync(path.join(root, name), content);
		}
	}
}

/** @typedef {{ id: number; cmd: string; file: string; offset: number; content: string }} Marker */

function collectMarkers(file, content) {
	const re = /\/\*(\d+):(cf|oi|ih)\*\//g;
	/** @type {Marker[]} */
	const out = [];
	let m;
	while ((m = re.exec(content))) {
		out.push({
			id: Number(m[1]),
			cmd: m[2],
			file,
			offset: m.index + m[0].length,
			content,
		});
	}
	return out;
}

function offsetToLineCol(text, offset) {
	let line = 1, col = 1;
	for (let i = 0; i < offset; i++) {
		if (text[i] === '\n') { line++; col = 1; }
		else col++;
	}
	return { line, offset: col };
}

function normalizeCodeFixes(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	const fixes = Array.isArray(body) ? body : (body?.fixes ?? body ?? []);
	const list = (Array.isArray(fixes) ? fixes : []).map(f => ({
		fixName: f.fixName,
		description: f.description,
		changes: (f.changes ?? []).map(c => ({
			fileName: path.basename(String(c.fileName ?? '')),
			textChanges: (c.textChanges ?? []).map(t => ({
				start: t.start,
				length: t.length ?? t.span?.length,
				newText: t.newText,
			})).sort((a, b) =>
				(a.start?.line ?? a.start ?? 0) - (b.start?.line ?? b.start ?? 0)
				|| String(a.newText).localeCompare(String(b.newText))),
		})).sort((a, b) => String(a.fileName).localeCompare(String(b.fileName))),
	})).sort((a, b) => String(a.fixName).localeCompare(String(b.fixName))
		|| String(a.description).localeCompare(String(b.description)));
	return { success: !!res.success, body: list };
}

function normalizeEdits(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	if (!body) return { success: !!res.success, message: res.message ?? null, body: null };
	const edits = (body.edits ?? body ?? []);
	const list = (Array.isArray(edits) ? edits : []).map(c => ({
		fileName: path.basename(String(c.fileName ?? '')),
		textChanges: (c.textChanges ?? []).map(t => ({
			start: t.start,
			length: t.length ?? t.span?.length,
			newText: t.newText,
		})),
	}));
	return { success: !!res.success, body: list };
}

function normalizeInlayHints(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	const hints = Array.isArray(body) ? body : (body?.hints ?? body ?? []);
	const list = (Array.isArray(hints) ? hints : []).map(h => ({
		text: h.text,
		position: h.position,
		kind: h.kind,
		whitespaceBefore: h.whitespaceBefore,
		whitespaceAfter: h.whitespaceAfter,
		displayParts: (h.displayParts ?? []).map(p => ({
			text: p.text,
			span: p.span,
			file: p.file ? path.basename(String(p.file)) : undefined,
		})),
	})).sort((a, b) =>
		(a.position?.line ?? a.position ?? 0) - (b.position?.line ?? b.position ?? 0)
		|| String(a.text).localeCompare(String(b.text)));
	return { success: !!res.success, body: list };
}

async function runCodeFixesForFile(send, file, { suggestion = false } = {}) {
	const cmd = suggestion ? 'suggestionDiagnosticsSync' : 'semanticDiagnosticsSync';
	const diags = await send(cmd, { file, includeLinePosition: true });
	const body = Array.isArray(diags?.body) ? diags.body : [];
	const allFixes = [];
	for (const d of body) {
		const startLine = d.startLocation?.line ?? d.start?.line;
		const startOffset = d.startLocation?.offset ?? d.start?.offset;
		const endLine = d.endLocation?.line ?? d.end?.line ?? startLine;
		const endOffset = d.endLocation?.offset ?? d.end?.offset ?? startOffset;
		if (startLine == null || startOffset == null) continue;
		try {
			const fixes = await send('getCodeFixes', {
				file,
				startLine,
				startOffset,
				endLine,
				endOffset,
				errorCodes: [d.code],
			});
			const list = Array.isArray(fixes?.body) ? fixes.body : [];
			for (const f of list) allFixes.push(f);
		} catch (e) {
			allFixes.push({ fixName: '__throw__', description: String(e?.message ?? e) });
		}
	}
	return {
		normalized: normalizeCodeFixes({ success: true, body: allFixes }),
		diagCodes: body.map(d => d.code),
	};
}

async function runCmd(send, mk) {
	const pos = offsetToLineCol(mk.content, mk.offset);
	if (mk.cmd === 'cf') {
		// id=1 uses suggestion diags (80006); others semantic
		const suggestion = mk.id === 1;
		const { normalized, diagCodes } = await runCodeFixesForFile(send, mk.file, { suggestion });
		// Also try semantic for id=1 if suggestion empty (belt+suspenders)
		if (suggestion && (!normalized.body || normalized.body.length === 0)) {
			const sem = await runCodeFixesForFile(send, mk.file, { suggestion: false });
			return {
				cmd: 'cf',
				diagCodes: [...new Set([...diagCodes, ...sem.diagCodes])],
				normalized: sem.normalized.body?.length ? sem.normalized : normalized,
			};
		}
		return { cmd: 'cf', diagCodes, normalized };
	}
	if (mk.cmd === 'oi') {
		try {
			const res = await send('organizeImports', {
				scope: { type: 'file', args: { file: mk.file } },
			});
			return { cmd: 'oi', normalized: normalizeEdits(res) };
		} catch (e) {
			return { cmd: 'oi', normalized: { success: false, error: String(e?.message ?? e) } };
		}
	}
	if (mk.cmd === 'ih') {
		try {
			const res = await send('provideInlayHints', {
				file: mk.file,
				start: 0,
				length: mk.content.length,
			});
			return { cmd: 'ih', normalized: normalizeInlayHints(res) };
		} catch (e) {
			return { cmd: 'ih', normalized: { success: false, error: String(e?.message ?? e) } };
		}
	}
	throw new Error(`unknown cmd ${mk.cmd}`);
}

async function runProject(tsserverPath, env, markers, openFiles) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
				includeInlayParameterNameHints: 'all',
				includeInlayParameterNameHintsWhenArgumentMatchesName: true,
			},
		});
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const out = {};
		for (const mk of markers) {
			try {
				out[mk.id] = await runCmd(send, mk);
			} catch (e) {
				out[mk.id] = {
					cmd: mk.cmd,
					normalized: { success: false, error: String(e?.message ?? e) },
				};
			}
		}
		return out;
	});
}

function deepEqual(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

ensureFixtures();

/** @type {Marker[]} */
const allMarkers = [];
/** @type {Record<number, { cmd: string; normalized: unknown }>} */
const tnb = {};
/** @type {Record<number, { cmd: string; normalized: unknown }>} */
const stock = {};

for (const proj of PROJECTS) {
	const root = path.join(fixtureDir, proj.dir);
	/** @type {Marker[]} */
	const markers = [];
	const openFiles = [];
	for (const [name, content] of Object.entries(proj.files)) {
		const file = path.join(root, name);
		openFiles.push({ file, fileContent: content, projectRootPath: root });
		markers.push(...collectMarkers(file, content));
	}
	markers.sort((a, b) => a.id - b.id);
	allMarkers.push(...markers);

	const tnbPart = await runProject(tnbPath, tnbHarnessEnv(), markers, openFiles);
	const stockPart = await runProject(stockPath, process.env, markers, openFiles);
	Object.assign(tnb, tnbPart);
	Object.assign(stock, stockPart);
}

allMarkers.sort((a, b) => a.id - b.id);

let matched = 0;
const diffs = [];
for (const mk of allMarkers) {
	const a = tnb[mk.id];
	const b = stock[mk.id];
	if (deepEqual(a, b)) matched++;
	else {
		diffs.push({
			id: mk.id,
			cmd: mk.cmd,
			file: path.basename(mk.file),
			lineCol: offsetToLineCol(mk.content, mk.offset),
			tnb: a,
			stock: b,
		});
	}
}

const positions = allMarkers.length;
const diff = diffs.length;
console.log(`positions=${positions} matched=${matched} diff=${diff}`);

// Method-oriented summaries
const METHOD_BY_ID = {
	1: 'getPromiseType/getPromiseLikeType',
	2: 'getAnyAsyncIterableType',
	3: 'getExactOptionalProperties',
	4: 'getJsxNamespace',
	5: 'getJsxFragmentFactory',
	6: 'getParameterIdentifierInfoAtPosition',
};

for (const id of [1, 2, 3, 4, 5, 6]) {
	const t = tnb[id];
	const s = stock[id];
	console.log(`\n[${METHOD_BY_ID[id]} id=${id}]`);
	console.log(`  diags stock=${JSON.stringify(s?.diagCodes)} tnb=${JSON.stringify(t?.diagCodes)}`);
	if (id === 6) {
		console.log(`  stock hints: ${JSON.stringify(s?.normalized?.body)}`);
		console.log(`  tnb hints:   ${JSON.stringify(t?.normalized?.body)}`);
	} else {
		const tFixes = t?.normalized?.body ?? [];
		const sFixes = s?.normalized?.body ?? [];
		console.log(`  stock fixes: ${JSON.stringify((sFixes).map(f => f.fixName ?? f))}`);
		console.log(`  tnb fixes:   ${JSON.stringify((tFixes).map(f => f.fixName ?? f))}`);
	}
}

if (diff > 0) {
	for (const d of diffs) {
		console.log(`\n--- diff id=${d.id} cmd=${d.cmd} @ ${d.file}:${d.lineCol.line}:${d.lineCol.offset} ---`);
		console.log('TNB:', JSON.stringify(d.tnb, null, 2));
		console.log('STOCK:', JSON.stringify(d.stock, null, 2));
	}
}
process.exitCode = diff === 0 ? 0 : 1;
