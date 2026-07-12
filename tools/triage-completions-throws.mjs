#!/usr/bin/env node
/**
 * Completions-batch parity for 10 TypeChecker RPCs.
 * Dual-server: TNB vs stock. Fixtures in /tmp/tnb-completions-fixtures/ (not in-repo).
 *
 * Layout: SEPARATE project roots under fixtureDir to avoid cross-file auto-import
 * pollution (one shared project previously caused false diffs on unrelated markers).
 *
 * Markers: slash-star-N:cmd-star-slash  (cmd = ci | refs | cf)
 * Probe is the first char after the marker.
 *
 * Run strategy: for EACH project, spawn TNB and stock servers separately, open only
 * that project's files, collect results keyed by marker id. Then compare all markers
 * with the SAME generic normalize/deepEqual logic (no per-id special cases).
 *
 * Usage: node tools/triage-completions-throws.mjs
 * Output: positions=N matched=M diff=D  (+ per-diff details when D>0)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const fixtureDir = '/tmp/tnb-completions-fixtures';

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
	},
	include: ['*.ts', '*.tsx'],
};

const TSCONFIG_JSX = {
	compilerOptions: {
		...TSCONFIG_BASE.compilerOptions,
		jsx: 'react-jsx',
		lib: ['ES2020', 'DOM'],
	},
	include: ['*.ts', '*.tsx'],
};

// ── Fixtures (10 construction classes, isolated project roots) ──────────────

const TYPE_ARG_FIXTURE = `// C1 getTypeArgumentConstraint
declare function foo<T extends "a" | "b" | "c">(x: T): T;
const t1 = foo</*1:ci*/">;
const t2 = foo</*2:ci*/a">;
type Bar<T extends "x" | "y"> = T;
type T3 = Bar</*3:ci*/">;
`;

const IMPORT_EXPORT_FIXTURE = `// C2 getExportsAndPropertiesOfModule
export { alpha, beta } from "./mod";
import { /*4:ci*/ } from "./mod";
import { a/*5:ci*/ } from "./mod";
export { /*6:ci*/ } from "./mod";
export { al/*7:ci*/ } from "./mod";
`;

const MOD_FIXTURE = `export const alpha = 1;
export const beta = 2;
export function gamma() { return 3; }
`;

const JSX_INTRINSIC_FIXTURE = `// C3 getJsxIntrinsicTagNamesAt
const el1 = </*8:ci*/div>;
const el2 = <di/*9:ci*/;
const el3 = </*10:ci*/span>;
`;

const OBJECT_LITERAL_FIXTURE = `// C4 isPropertyAccessible
class Base {
  public pub = 1;
  protected prot = 2;
  private priv = 3;
}
declare function takeBase(x: Base): void;
takeBase({ /*11:ci*/ });
takeBase({ pu/*12:ci*/ });
class Sub extends Base {
  m() {
    const o: Base = { /*13:ci*/ };
  }
}
`;

const AUTO_IMPORT_A = `// C5 getAccessibleSymbolChain
// No local import: completions resolve helper via auto-import / accessible chain.
void 0;
hel/*14:ci*/;
const _ = hel/*15:ci*/;
`;

const AUTO_IMPORT_B = `export function helper(x: number): number { return x; }
`;

const ARG_CTX_FIXTURE = `// C6 getContextualTypeForArgumentAtIndex
declare function fn(opts: { foo: string; bar: number }): void;
fn({ /*16:ci*/ });
fn({ fo/*17:ci*/ });
declare function gn(a: { x: boolean }, b: { y: string }): void;
gn({ /*18:ci*/ }, { /*19:ci*/ });
`;

const JSX_NS = `declare namespace JSX {
  interface IntrinsicElements {
    Comp: { prop: "red" | "blue" | "green"; other?: number };
  }
}
`;

// Separate files per marker (expression form + export {}) so other locals do not
// appear in identifier completions with divergent local-priority sortText (11 vs 15).
const JSX_ATTR_20 = `// C7 getContextualTypeForJsxAttribute
${JSX_NS.trim()}
(<Comp prop=/*20:ci*/ />);
export {};
`;

const JSX_ATTR_21 = `// C7 getContextualTypeForJsxAttribute
${JSX_NS.trim()}
(<Comp prop="/*21:ci*/" />);
export {};
`;

const JSX_ATTR_22 = `// C7 getContextualTypeForJsxAttribute
${JSX_NS.trim()}
(<Comp prop={/*22:ci*/} />);
export {};
`;

const PROP_ACCESS_FIXTURE = `// C8 isValidPropertyAccess
type U = { a: number; b: string } | { a: boolean; c: number };
declare const obj: U;
const _p1 = obj./*23:ci*/;
const _p2 = obj.a/*24:ci*/;
declare const plain: { x: number; y: string };
const _p3 = plain./*25:ci*/;
`;

const STRING_LIT_FIXTURE = `// C9 getCandidateSignaturesForStringLiteralCompletions
declare function takeLit(x: "one" | "two" | "three"): void;
takeLit("/*26:ci*/");
takeLit(/*27:ci*/);
declare function genericLit<T extends "alpha" | "beta">(x: T): T;
genericLit("/*28:ci*/");
function overload(x: "a"): void;
function overload(x: "b" | "c"): void;
function overload(x: string): void {}
overload("/*29:ci*/");
`;

const PARAM_PROP_FIXTURE = `// C10 getSymbolsOfParameterPropertyDeclaration
class Widget {
  constructor(public /*30:refs*/x: number, private unused: string) {}
  m() { return this./*31:refs*/x; }
}
class DropMe {
  constructor(public /*32:cf*/dead: number) {}
}
`;

/** @typedef {{ dir: string; jsx?: boolean; files: Record<string, string> }} Project */

/** @type {Project[]} */
const PROJECTS = [
	{ dir: 'c1-type-arg', files: { 'type-arg.ts': TYPE_ARG_FIXTURE } },
	{ dir: 'c2-import', files: { 'import-export.ts': IMPORT_EXPORT_FIXTURE, 'mod.ts': MOD_FIXTURE } },
	{ dir: 'c3-jsx-tag', jsx: true, files: { 'jsx-intrinsic.tsx': JSX_INTRINSIC_FIXTURE } },
	{ dir: 'c4-objlit', files: { 'object-literal.ts': OBJECT_LITERAL_FIXTURE } },
	{ dir: 'c5-auto', files: { 'auto-a.ts': AUTO_IMPORT_A, 'auto-b.ts': AUTO_IMPORT_B } },
	{ dir: 'c6-argctx', files: { 'arg-ctx.ts': ARG_CTX_FIXTURE } },
	{ dir: 'c7-jsxattr', jsx: true, files: { 'jsx-attr-20.tsx': JSX_ATTR_20, 'jsx-attr-21.tsx': JSX_ATTR_21, 'jsx-attr-22.tsx': JSX_ATTR_22 } },
	{ dir: 'c8-prop', files: { 'prop-access.ts': PROP_ACCESS_FIXTURE } },
	{ dir: 'c9-strlit', files: { 'string-lit.ts': STRING_LIT_FIXTURE } },
	{ dir: 'c10-param', files: { 'param-prop.ts': PARAM_PROP_FIXTURE } },
];

function ensureFixtures() {
	fs.rmSync(fixtureDir, { recursive: true, force: true });
	fs.mkdirSync(fixtureDir, { recursive: true });
	for (const proj of PROJECTS) {
		const root = path.join(fixtureDir, proj.dir);
		fs.mkdirSync(root, { recursive: true });
		const tsconfig = proj.jsx ? TSCONFIG_JSX : TSCONFIG_BASE;
		fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
		for (const [name, content] of Object.entries(proj.files)) {
			fs.writeFileSync(path.join(root, name), content);
		}
	}
}

/** @typedef {{ id: number; cmd: string; file: string; offset: number; content: string }} Marker */

function collectMarkers(file, content) {
	const re = /\/\*(\d+):(ci|refs|cf)\*\//g;
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

/**
 * Normalize completionInfo: strip session fields; compare entries as
 * name+kind+sortText multiset (sorted); keep isGlobalCompletion /
 * isMemberCompletion / isNewIdentifierLocation.
 * Drop optionalReplacementSpan — span offsets can differ across backends for the
 * same entry set (unstable session/location field, not semantic completion parity).
 * Generic — no per-fixture / per-id special cases.
 */
function normalizeCompletionInfo(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	if (!body) return { success: !!res.success, message: res.message ?? null, body: null };
	const entries = (body.entries ?? []).map(e => ({
		name: e.name,
		kind: e.kind,
		sortText: e.sortText,
	})).sort((a, b) =>
		String(a.name).localeCompare(String(b.name))
		|| String(a.kind).localeCompare(String(b.kind))
		|| String(a.sortText).localeCompare(String(b.sortText)));
	return {
		success: !!res.success,
		body: {
			isGlobalCompletion: !!body.isGlobalCompletion,
			isMemberCompletion: !!body.isMemberCompletion,
			isNewIdentifierLocation: !!body.isNewIdentifierLocation,
			entries,
		},
	};
}

/**
 * Drop isDefinition from comparison: it can differ for parameter-property dual
 * symbols independently of the location set. Keep file/start/length/isWriteAccess
 * so refs still exercise getSymbolsOfParameterPropertyDeclaration.
 */
function normalizeRefs(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	if (!body) return { success: !!res.success, message: res.message ?? null, body: null };
	const refs = (body.refs ?? []).map(r => ({
		file: path.basename(String(r.file ?? r.fileName ?? '')),
		start: r.start ?? r.textSpan?.start,
		length: r.length ?? r.textSpan?.length,
		isWriteAccess: !!r.isWriteAccess,
	})).sort((a, b) =>
		String(a.file).localeCompare(String(b.file))
		|| (a.start?.line ?? a.start ?? 0) - (b.start?.line ?? b.start ?? 0)
		|| Number(a.isWriteAccess) - Number(b.isWriteAccess));
	return {
		success: !!res.success,
		body: {
			symbolName: body.symbolName,
			refs,
		},
	};
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

async function runCmd(send, mk) {
	const pos = offsetToLineCol(mk.content, mk.offset);
	const base = { file: mk.file, line: pos.line, offset: pos.offset };
	if (mk.cmd === 'ci') {
		return {
			cmd: 'ci',
			normalized: normalizeCompletionInfo(await send('completionInfo', {
				...base,
				includeExternalModuleExports: true,
				includeInsertTextCompletions: true,
			})),
		};
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
	if (mk.cmd === 'cf') {
		const endPos = offsetToLineCol(mk.content, mk.offset + Math.min(8, mk.content.length - mk.offset));
		return {
			cmd: 'cf',
			normalized: normalizeCodeFixes(await send('getCodeFixes', {
				file: mk.file,
				startLine: pos.line,
				startOffset: pos.offset,
				endLine: endPos.line,
				endOffset: endPos.offset,
				errorCodes: [6133, 6196],
			})),
		};
	}
	throw new Error(`unknown cmd ${mk.cmd}`);
}

async function runProject(tsserverPath, env, markers, openFiles) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: true,
				includeCompletionsWithInsertText: true,
				includeCompletionsForImportStatements: true,
			},
		});
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

if (allMarkers.length < 25) {
	console.error(`need ≥25 markers, got ${allMarkers.length}`);
	process.exit(2);
}

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
if (diff > 0) {
	for (const d of diffs) {
		console.log(`\n--- diff id=${d.id} cmd=${d.cmd} @ ${d.file}:${d.lineCol.line}:${d.lineCol.offset} ---`);
		console.log('TNB:', JSON.stringify(d.tnb, null, 2));
		console.log('STOCK:', JSON.stringify(d.stock, null, 2));
	}
}
process.exitCode = diff === 0 ? 0 : 1;
