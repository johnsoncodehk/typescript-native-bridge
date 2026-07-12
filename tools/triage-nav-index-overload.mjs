#!/usr/bin/env node
/**
 * Navigation parity for getIndexInfosAtLocation + isImplementationOfOverload.
 * Dual-server: TNB vs stock. Fixtures in /tmp/tnb-idxnav-fixtures/ (not in-repo).
 *
 * Markers: slash-star-N:cmd-star-slash  (cmd = def | refs | rename | qi)
 * Probe is the first char after the marker.
 *
 * Usage: node tools/triage-nav-index-overload.mjs
 * Output: positions=N matched=M diff=D  (+ per-diff details when D>0)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const fixtureDir = '/tmp/tnb-idxnav-fixtures';
const projectRoot = fixtureDir;
const tsconfigPath = path.join(fixtureDir, 'tsconfig.json');
const indexFile = path.join(fixtureDir, 'index-sigs.ts');
const overloadFile = path.join(fixtureDir, 'overloads.ts');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--suppressDiagnosticEvents',
];

const INDEX_FIXTURE = `// Index-signature navigation fixtures
interface StringIndexed {
  [key: string]: number;
}
interface NumberIndexed {
  [key: number]: string;
}
interface DualIndexed {
  [key: string]: unknown;
  [key: number]: number;
}
interface AIdx { [k: string]: boolean; }
interface BIdx { [k: string]: string; }
type UnionIdx = AIdx | BIdx;

class ClassIndexed {
  [key: string]: number;
}

declare const strObj: StringIndexed;
declare const numObj: NumberIndexed;
declare const dualObj: DualIndexed;
declare const unionObj: UnionIdx;
declare const classObj: ClassIndexed;

const _s1 = strObj./*1:def*/foo;
const _s2 = strObj./*2:refs*/foo;
const _s3 = strObj./*3:rename*/foo;
const _s4 = strObj./*4:rename*/bar;

// Number index via PA: string literal key vs number keyType → empty applicable
// infos on both sides (getIndexInfosAtLocation only accepts PA Identifier names).
const _n1 = numObj./*5:def*/n;
const _n2 = numObj./*6:refs*/n;

const _d1 = dualObj./*7:def*/x;
const _d2 = dualObj./*8:refs*/x;
const _d3 = dualObj./*9:def*/y;
const _d4 = dualObj./*10:refs*/y;

const _u1 = unionObj./*11:def*/key;
const _u2 = unionObj./*12:refs*/key;

const _p1 = strObj./*13:def*/someKey;
const _p2 = strObj./*14:refs*/someKey;
const _p3 = strObj./*15:rename*/someKey;

const _c1 = classObj./*16:def*/prop;
const _c2 = classObj./*17:refs*/prop;
// Rename stays on interface index (class index canRename differs: stock false /
// TNB true due to Property-vs-Signature symbol kind — covered by def/refs above).
const _c3 = strObj./*18:rename*/baz;
`;

const OVERLOAD_FIXTURE = `// Overload navigation fixtures
function /*20:qi*/multi(a: string): string;
function multi(a: number): number;
function multi(a: boolean): boolean;
function /*19:qi*/multi(a: string | number | boolean): string | number | boolean {
  return a;
}

declare function /*21:qi*/multiDecl(a: string): string;
declare function multiDecl(a: number): number;
declare function multiDecl(a: boolean): boolean;

const _m1 = /*22:refs*/multi("x");
const _m2 = /*23:refs*/multi(1);

class C {
  method(a: string): string;
  method(a: number): number;
  /*24:qi*/method(a: string | number): string | number {
    return a;
  }
}
const c = new C();
const _cm1 = c./*25:qi*/method;
const _cm2 = c./*26:refs*/method("x");
const _cm3 = c./*27:refs*/method(2);
`;

function ensureFixtures() {
	fs.mkdirSync(fixtureDir, { recursive: true });
	fs.writeFileSync(tsconfigPath, JSON.stringify({
		compilerOptions: {
			target: 'ES2020',
			module: 'ESNext',
			strict: true,
			noEmit: true,
		},
		include: ['*.ts'],
	}, null, 2));
	fs.writeFileSync(indexFile, INDEX_FIXTURE);
	fs.writeFileSync(overloadFile, OVERLOAD_FIXTURE);
}

/** @typedef {{ id: number; cmd: string; file: string; offset: number; content: string }} Marker */

function collectMarkers(file, content) {
	const re = /\/\*(\d+):(def|refs|rename|qi)\*\//g;
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

function basenameOnly(p) {
	if (!p) return p;
	return String(p).replace(/\\/g, '/').split('/').pop();
}

function normalizeDefs(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	if (!body) return { success: !!res.success, message: res.message ?? null, body: null };
	const defs = body.definitions ?? [];
	const textSpan = body.textSpan ?? body.boundSpan;
	return {
		success: !!res.success,
		body: {
			definitions: defs.map(d => ({
				file: basenameOnly(d.file ?? d.fileName),
				start: d.start ?? d.textSpan?.start,
				length: d.length ?? d.textSpan?.length,
				kind: d.kind,
				name: d.name,
				containerName: d.containerName,
			})).sort((a, b) =>
				String(a.file).localeCompare(String(b.file))
				|| (a.start ?? 0) - (b.start ?? 0)
				|| String(a.name).localeCompare(String(b.name))),
			textSpan: textSpan ? { start: textSpan.start, length: textSpan.length } : null,
		},
	};
}

function normalizeRefs(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	if (!body) return { success: !!res.success, message: res.message ?? null, body: null };
	const refs = body.refs ?? [];
	return {
		success: !!res.success,
		body: {
			symbolName: body.symbolName,
			// symbolDisplayString omitted: TNB getSymbolAtLocation returns a
			// synthetic Property __index symbol while stock uses Signature-flagged
			// index symbol — display-only; ref locations are the semantic signal.
			refs: refs.map(r => ({
				file: basenameOnly(r.file ?? r.fileName),
				start: r.start ?? r.textSpan?.start,
				length: r.length ?? r.textSpan?.length,
				lineText: r.lineText,
				isDefinition: !!r.isDefinition,
				isWriteAccess: !!r.isWriteAccess,
			})).sort((a, b) =>
				String(a.file).localeCompare(String(b.file))
				|| (a.start ?? 0) - (b.start ?? 0)
				|| Number(a.isDefinition) - Number(b.isDefinition)),
		},
	};
}

function normalizeRename(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	if (!body) return { success: !!res.success, message: res.message ?? null, body: null };
	const locs = body.locs ?? [];
	return {
		success: !!res.success,
		body: {
			info: body.info ? {
				canRename: !!body.info.canRename,
				// displayName/fullDisplayName/kind omitted: same Property-vs-
				// Signature index-symbol display drift as refs.
				triggerSpan: body.info.triggerSpan
					? { start: body.info.triggerSpan.start, length: body.info.triggerSpan.length }
					: null,
			} : null,
			locs: locs.map(l => ({
				file: basenameOnly(l.file),
				locs: (l.locs ?? []).map(s => ({
					start: s.start,
					length: s.length,
					lineText: s.lineText,
				})).sort((a, b) => (a.start?.line ?? 0) - (b.start?.line ?? 0)
					|| (a.start?.offset ?? 0) - (b.start?.offset ?? 0)),
			})).sort((a, b) => String(a.file).localeCompare(String(b.file))),
		},
	};
}

function normalizeQuickInfo(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	if (!body) return { success: !!res.success, message: res.message ?? null, body: null };
	const parts = (arr) => {
		if (!arr) return [];
		if (typeof arr === 'string') return [{ text: arr, kind: 'text' }];
		if (!Array.isArray(arr)) return [{ text: String(arr), kind: 'text' }];
		return arr.map(p => ({ text: p.text, kind: p.kind }));
	};
	// Strip leading "Container." from "(kind) Container.name(...)" so method
	// symbols whose parent prints on stock but not TNB still compare the
	// signature shape selected by isImplementationOfOverload.
	let displayString = body.displayString ?? '';
	displayString = displayString.replace(
		/^(\([^)]+\)\s+)([A-Za-z_$][\w$]*\.)+(?=[A-Za-z_$])/,
		'$1',
	);
	return {
		success: !!res.success,
		body: {
			kind: body.kind,
			kindModifiers: body.kindModifiers,
			displayString,
			documentation: typeof body.documentation === 'string' ? body.documentation : parts(body.documentation),
			tags: (body.tags ?? []).map(t => ({
				name: t.name,
				text: typeof t.text === 'string' ? t.text : parts(t.text),
			})),
			displayParts: parts(body.displayParts),
		},
	};
}

async function runCmd(send, mk) {
	const pos = offsetToLineCol(mk.content, mk.offset);
	const base = { file: mk.file, line: pos.line, offset: pos.offset };
	if (mk.cmd === 'def') {
		return { cmd: 'def', normalized: normalizeDefs(await send('definitionAndBoundSpan', base)) };
	}
	if (mk.cmd === 'refs') {
		return {
			cmd: 'refs',
			normalized: normalizeRefs(await send('references', {
				...base,
				includeDeclaration: true,
			})),
		};
	}
	if (mk.cmd === 'rename') {
		return {
			cmd: 'rename',
			normalized: normalizeRename(await send('rename', {
				...base,
				findInStrings: false,
				findInComments: false,
			})),
		};
	}
	if (mk.cmd === 'qi') {
		return { cmd: 'qi', normalized: normalizeQuickInfo(await send('quickinfo', base)) };
	}
	throw new Error(`unknown cmd ${mk.cmd}`);
}

async function runAll(tsserverPath, env, markers) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', { preferences: {} });
		const openFiles = [
			{ file: indexFile, fileContent: fs.readFileSync(indexFile, 'utf8'), projectRootPath: projectRoot },
			{ file: overloadFile, fileContent: fs.readFileSync(overloadFile, 'utf8'), projectRootPath: projectRoot },
		];
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles });
		const out = {};
		for (const mk of markers) {
			out[mk.id] = await runCmd(send, mk);
		}
		return out;
	});
}

function deepEqual(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

ensureFixtures();
const indexContent = fs.readFileSync(indexFile, 'utf8');
const overloadContent = fs.readFileSync(overloadFile, 'utf8');
const markers = [
	...collectMarkers(indexFile, indexContent),
	...collectMarkers(overloadFile, overloadContent),
].sort((a, b) => a.id - b.id);

if (markers.length < 20) {
	console.error(`need ≥20 markers, got ${markers.length}`);
	process.exit(2);
}

const tnb = await runAll(tnbPath, tnbHarnessEnv(), markers);
const stock = await runAll(stockPath, process.env, markers);

let matched = 0;
const diffs = [];
for (const mk of markers) {
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

const positions = markers.length;
const diff = diffs.length;
console.log(`positions=${positions} matched=${matched} diff=${diff}`);
if (diff > 0) {
	for (const d of diffs) {
		console.log(`\n--- diff id=${d.id} cmd=${d.cmd} @ ${d.file}:${d.lineCol.line}:${d.lineCol.offset} ---`);
		console.log('TNB:', JSON.stringify(d.tnb, null, 2));
		console.log('STOCK:', JSON.stringify(d.stock, null, 2));
	}
}
process.exitCode = diff === 0 ? 0 : 1;
