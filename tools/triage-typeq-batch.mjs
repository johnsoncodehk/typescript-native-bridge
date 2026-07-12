#!/usr/bin/env node
/**
 * Type/Symbol query batch parity for 22 TypeChecker RPCs (batch 1).
 * Dual-server: TNB vs stock. Fixtures in /tmp/tnb-typeq-fixtures/.
 *
 * Markers: slash-star-N:cmd-star-slash
 *   cmd = cf | ci | refs | qi | ar | er
 * Probe is the first char after the marker.
 *
 * Usage: node tools/triage-typeq-batch.mjs
 * Output: positions=N matched=M diff=D  (+ per-diff details when D>0)
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
const fixtureDir = '/tmp/tnb-typeq-fixtures';

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
		noImplicitAny: true,
	},
	include: ['*.ts', '*.tsx', '*.js'],
};

const TSCONFIG_JSX = {
	compilerOptions: {
		...TSCONFIG_BASE.compilerOptions,
		jsx: 'react-jsx',
		lib: ['ES2020', 'DOM'],
	},
	include: ['*.ts', '*.tsx'],
};

const TSCONFIG_JSDOC = {
	compilerOptions: {
		...TSCONFIG_BASE.compilerOptions,
		allowJs: true,
		checkJs: true,
		noEmit: true,
	},
	include: ['*.js', '*.ts'],
};

// ── Fixtures (one project root per construction class) ──────────────────────

/** getAwaitedType — 1064 fixReturnTypeInAsyncFunction */
const AWAITED = `// getAwaitedType
async function f(): /*1:cf*/number { return 1; }
`;

/** getUnmatchedProperties — 2741 fixMissingProperties */
const UNMATCHED = `// getUnmatchedProperties
type T = { a: number; b: string };
const x: T = /*2:cf*/{ a: 1 };
`;

/** getElementTypeOfArrayType + getTypeOfPropertyOfContextualType — completions */
const ELEM_CTX = `// getElementTypeOfArrayType / getTypeOfPropertyOfContextualType
declare function takeArr(x: { n: number }[]): void;
takeArr([{ /*3:ci*/ }]);
type Foo<T> = T;
const _f: Foo<{ x: string }> = { x: /*4:ci*/"" };
declare function takeObj(o: { foo: string; bar: number }): void;
takeObj({ /*5:ci*/ });
`;

/** getTypeOfPropertyOfType — JSX attr string completions */
const PROP_OF_TYPE = `// getTypeOfPropertyOfType
declare namespace JSX {
  interface IntrinsicElements {
    Comp: { prop: "red" | "blue"; other?: number };
  }
}
(<Comp prop="/*6:ci*/" />);
`;

/** getIndexInfoOfType — class incorrectly implements interface index */
const INDEX_INFO = `// getIndexInfoOfType
interface Dict { [k: string]: number; }
class C /*7:cf*/implements Dict {
  x = 1;
}
`;

/** isNullableType — optional-chain refactor */
const NULLABLE = `// isNullableType
declare const maybe: string | null;
const _n = maybe/*8:ar*/.length;
`;

/** containsArgumentsReference — convert arrow/function refactor */
const ARGS_REF = `// containsArgumentsReference
const fn = function() { return /*9:ar*/arguments; };
const clean = function(x: number) { return /*10:ar*/x + 1; };
`;

/** getPropertySymbolOfDestructuringAssignment — references */
const DESTRUCT = `// getPropertySymbolOfDestructuringAssignment
declare const obj: { foo: number; bar: string };
let foo: number;
({ /*11:refs*/foo } = obj);
`;

/** isEmptyAnonymousObjectType — jsx attribute completion style */
const EMPTY_ANON = `// isEmptyAnonymousObjectType
declare namespace JSX {
  interface IntrinsicElements {
    tag: { id?: string & {} };
  }
}
(<tag id=/*12:ci*/ />);
`;

/** getWidenedLiteralType + requiresAddingImplicitUndefined — missing type on exports */
const WIDEN_UNDEF = `// getWidenedLiteralType / requiresAddingImplicitUndefined
export const lit = /*13:cf*/1 as const;
export function g(x/*14:cf*/ = 1) { return x; }
`;

/** fillMissingTypeArguments — via helpers on generic export annotation path */
const FILL_ARGS = `// fillMissingTypeArguments
export function h/*15:cf*/<T = string>(x: T): T { return x; }
`;

/** symbolIsValue — convertToTypeOnlyImport */
const TYPE_ONLY = `// symbolIsValue / getTypeOnlyAliasDeclaration / resolveExternalModuleName
import { TypeOnly } from "./mod-type";
let _t: TypeOnly;
void _t;
import { /*16:cf*/TypeOnly as TO } from "./mod-type";
void 0 as TO;
`;

const MOD_TYPE = `export type TypeOnly = { z: number };
export const valueExport = 1;
`;

/** isLibType + getIndexInfosOfIndexSymbol — quickinfo on lib / index signature */
const LIB_INDEX = `// isLibType / getIndexInfosOfIndexSymbol
interface Indexed {
  [key: string]: number;
  prop: number;
}
declare const idx: Indexed;
idx./*17:qi*/prop;
const s: string = /*18:qi*/"hi";
`;

/** getNullableType — JSDoc nullable fix */
const JSDOC_NULL = `// getNullableType
/**
 * @param {string?} /*19:cf*/p
 */
function jdoc(p) { return p; }
`;

/** isSymbolAccessible — inferFromUsage producing type nodes */
const SYMBOL_ACC = `// isSymbolAccessible / inferFromUsage
function use(x/*20:cf*/) { return x.foo; }
use({ foo: 1 });
`;

/** getAugmentedPropertiesOfType — member completion on string (apparent props) */
const AUGMENTED = `// getAugmentedPropertiesOfType
declare const str: string;
str./*21:ci*/;
`;

/** resolveExternalModuleName / getTypeOnlyAliasDeclaration — import fixes */
const IMPORT_FIX = `// resolveExternalModuleName
const _ = new /*22:cf*/MissingClass();
`;

/** @typedef {{ dir: string; jsx?: boolean; jsdoc?: boolean; files: Record<string, string> }} Project */

/** @type {Project[]} */
const PROJECTS = [
	{ dir: 'q1-awaited', files: { 'awaited.ts': AWAITED } },
	{ dir: 'q2-unmatched', files: { 'unmatched.ts': UNMATCHED } },
	{ dir: 'q3-elem-ctx', files: { 'elem-ctx.ts': ELEM_CTX } },
	{ dir: 'q4-prop-type', jsx: true, files: { 'prop-type.tsx': PROP_OF_TYPE } },
	{ dir: 'q5-index-info', files: { 'index-info.ts': INDEX_INFO } },
	{ dir: 'q6-nullable', files: { 'nullable.ts': NULLABLE } },
	{ dir: 'q7-args', files: { 'args.ts': ARGS_REF } },
	{ dir: 'q8-destruct', files: { 'destruct.ts': DESTRUCT } },
	{ dir: 'q9-empty-anon', jsx: true, files: { 'empty-anon.tsx': EMPTY_ANON } },
	{ dir: 'q10-widen', files: { 'widen.ts': WIDEN_UNDEF } },
	{ dir: 'q11-fill', files: { 'fill.ts': FILL_ARGS } },
	{ dir: 'q12-typeonly', files: { 'type-only.ts': TYPE_ONLY, 'mod-type.ts': MOD_TYPE } },
	{ dir: 'q13-lib-index', files: { 'lib-index.ts': LIB_INDEX } },
	{ dir: 'q14-jsdoc', jsdoc: true, files: { 'jsdoc.js': JSDOC_NULL } },
	{ dir: 'q15-symacc', files: { 'symacc.ts': SYMBOL_ACC } },
	{ dir: 'q16-augmented', files: { 'augmented.ts': AUGMENTED } },
	{ dir: 'q17-import', files: { 'import-fix.ts': IMPORT_FIX } },
];

function ensureFixtures() {
	fs.rmSync(fixtureDir, { recursive: true, force: true });
	fs.mkdirSync(fixtureDir, { recursive: true });
	for (const proj of PROJECTS) {
		const root = path.join(fixtureDir, proj.dir);
		fs.mkdirSync(root, { recursive: true });
		const tsconfig = proj.jsx ? TSCONFIG_JSX : proj.jsdoc ? TSCONFIG_JSDOC : TSCONFIG_BASE;
		fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
		for (const [name, content] of Object.entries(proj.files)) {
			fs.writeFileSync(path.join(root, name), content);
		}
	}
}

/** @typedef {{ id: number; cmd: string; file: string; offset: number; content: string }} Marker */

function collectMarkers(file, content) {
	const re = /\/\*(\d+):(cf|ci|refs|qi|ar|er)\*\//g;
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

function normalizeQuickInfo(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	if (!body) return { success: !!res.success, message: res.message ?? null, body: null };
	return {
		success: !!res.success,
		body: {
			kind: body.kind,
			displayString: body.displayString ?? (body.displayParts ?? []).map(p => p.text).join(''),
			documentation: body.documentation ?? (body.documentation ?? []),
		},
	};
}

function normalizeRefactors(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	const list = (Array.isArray(body) ? body : []).map(r => ({
		name: r.name,
		description: r.description,
		actions: (r.actions ?? []).map(a => ({ name: a.name, description: a.description }))
			.sort((a, b) => String(a.name).localeCompare(String(b.name))),
	})).sort((a, b) => String(a.name).localeCompare(String(b.name)));
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

/**
 * Witness-style codefix: for every semantic diagnostic, request fixes on the
 * diagnostic span (not the marker span). Aggregate + normalize.
 */
async function runCodeFixesForFile(send, file) {
	const diags = await send('semanticDiagnosticsSync', { file, includeLinePosition: true });
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
	return normalizeCodeFixes({ success: true, body: allFixes });
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
	if (mk.cmd === 'qi') {
		return {
			cmd: 'qi',
			normalized: normalizeQuickInfo(await send('quickinfo', base)),
		};
	}
	if (mk.cmd === 'cf') {
		return {
			cmd: 'cf',
			normalized: await runCodeFixesForFile(send, mk.file),
		};
	}
	if (mk.cmd === 'ar') {
		const endPos = offsetToLineCol(mk.content, Math.min(mk.offset + 20, mk.content.length));
		return {
			cmd: 'ar',
			normalized: normalizeRefactors(await send('getApplicableRefactors', {
				file: mk.file,
				startLine: pos.line,
				startOffset: pos.offset,
				endLine: endPos.line,
				endOffset: endPos.offset,
			})),
		};
	}
	if (mk.cmd === 'er') {
		const endPos = offsetToLineCol(mk.content, Math.min(mk.offset + 20, mk.content.length));
		const refactors = await send('getApplicableRefactors', {
			file: mk.file,
			startLine: pos.line,
			startOffset: pos.offset,
			endLine: endPos.line,
			endOffset: endPos.offset,
		});
		const body = refactors?.body ?? [];
		let refactorName = '';
		let actionName = '';
		for (const r of Array.isArray(body) ? body : []) {
			if (r.actions?.length) {
				refactorName = r.name;
				actionName = r.actions[0].name;
				break;
			}
		}
		if (!refactorName) {
			return { cmd: 'er', normalized: { success: true, body: [] } };
		}
		return {
			cmd: 'er',
			normalized: normalizeEdits(await send('getEditsForRefactor', {
				file: mk.file,
				startLine: pos.line,
				startOffset: pos.offset,
				endLine: endPos.line,
				endOffset: endPos.offset,
				refactor: refactorName,
				action: actionName,
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
				jsxAttributeCompletionStyle: 'auto',
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
if (diff > 0) {
	for (const d of diffs) {
		console.log(`\n--- diff id=${d.id} cmd=${d.cmd} @ ${d.file}:${d.lineCol.line}:${d.lineCol.offset} ---`);
		console.log('TNB:', JSON.stringify(d.tnb, null, 2));
		console.log('STOCK:', JSON.stringify(d.stock, null, 2));
	}
}
process.exitCode = diff === 0 ? 0 : 1;
