#!/usr/bin/env node
/**
 * Spelling (batch 3) + NodeBuilder AST (batch 4) parity for 10 TypeChecker RPCs.
 * Dual-server: TNB vs stock. Fixtures in /tmp/tnb-spellnb-fixtures/.
 *
 * Markers: slash-star-N:cmd-star-slash  (cmd = cf | er)
 * Witness via semanticDiagnosticsSync → getCodeFixes (or getEditsForRefactor).
 *
 * Usage: node tools/triage-spellnb-batch.mjs
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
const fixtureDir = '/tmp/tnb-spellnb-fixtures';

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
		noImplicitOverride: true,
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

// ── Spelling fixtures ───────────────────────────────────────────────────────

/** getSuggestedSymbolForNonexistentProperty — 2551 */
const SPELL_PROP = `// getSuggestedSymbolForNonexistentProperty
const obj = { foo: 1 };
obj./*1:cf*/fooo;
`;

/** getSuggestedSymbolForNonexistentSymbol — 2552 */
const SPELL_SYM = `// getSuggestedSymbolForNonexistentSymbol
/*2:cf*/consol.log(1);
`;

/** getSuggestedSymbolForNonexistentClassMember — override misspell */
const SPELL_CLASS = `// getSuggestedSymbolForNonexistentClassMember
class Base { method() {} }
class Child extends Base {
  override /*3:cf*/methood() {}
}
`;

/** getSuggestedSymbolForNonexistentJSXAttribute — JSX clss */
const SPELL_JSX = `// getSuggestedSymbolForNonexistentJSXAttribute
declare namespace JSX {
  interface IntrinsicElements {
    div: { className?: string; id?: string };
  }
}
const el = <div /*4:cf*/clss="x" />;
`;

/** getSuggestedSymbolForNonexistentModule — namespace misspell */
const SPELL_MOD = `// getSuggestedSymbolForNonexistentModule
namespace NS {
  export const value = 1;
}
NS./*5:cf*/valu;
`;

// ── NodeBuilder fixtures ────────────────────────────────────────────────────

/**
 * symbolToExpression — missing member whose type is enum-like
 * (tryGetValueFromType → symbolToExpression for enum default).
 */
const NB_ENUM = `// symbolToExpression (enum default via fixAddMissingMember)
enum Color { Red, Green }
interface HasColor { c: Color; }
const x: HasColor = /*6:cf*/{};
`;

/**
 * symbolToNode (+ symbolToEntityName INDIRECT) — missing props with
 * unique-symbol / computed-name transient symbols are hard to force;
 * object literal missing member still exercises fixAddMissingMember host
 * chain; computed branch is covered when symbol is transient.
 */
const NB_COMPUTED = `// symbolToNode / symbolToEntityName host (fixAddMissingMember)
const KEY = Symbol();
type Box = { [KEY]: number; plain: string };
const b: Box = /*7:cf*/{ plain: "a" };
`;

/** typePredicateToTypePredicateNode — infer return type with predicate */
const NB_PREDICATE = `// typePredicateToTypePredicateNode
function isStr(x: unknown)/*8:er*/ {
  return typeof x === "string";
}
`;

/** indexInfoToIndexSignatureDeclaration — class implements index iface (2420) */
const NB_INDEX = `// indexInfoToIndexSignatureDeclaration
interface Dict { [k: string]: number; }
class C /*9:cf*/implements Dict {
  x = 1;
}
`;

/**
 * getSuggestedSymbolForNonexistentModule via QualifiedName in type position.
 * Import-specifier path needs resolvedSourceFile.symbol (often missing on TNB);
 * `type T = NS.alpa` exercises the Module-flags QualifiedName branch instead.
 */
const SPELL_IMPORT = `// getSuggestedSymbolForNonexistentModule (QualifiedName type position)
namespace NS {
  export type alpha = number;
  export type beta = string;
}
type T = NS./*10:cf*/alpa;
`;

/** @typedef {{ dir: string; jsx?: boolean; files: Record<string, string> }} Project */

/** @type {Project[]} */
const PROJECTS = [
	{ dir: 's1-prop', files: { 'prop.ts': SPELL_PROP } },
	{ dir: 's2-sym', files: { 'sym.ts': SPELL_SYM } },
	{ dir: 's3-class', files: { 'class.ts': SPELL_CLASS } },
	{ dir: 's4-jsx', jsx: true, files: { 'jsx.tsx': SPELL_JSX } },
	{ dir: 's5-mod', files: { 'mod.ts': SPELL_MOD } },
	{ dir: 'n6-enum', files: { 'enum.ts': NB_ENUM } },
	{ dir: 'n7-computed', files: { 'computed.ts': NB_COMPUTED } },
	{ dir: 'n8-pred', files: { 'pred.ts': NB_PREDICATE } },
	{ dir: 'n9-index', files: { 'index.ts': NB_INDEX } },
	{ dir: 's10-import', files: { 'import.ts': SPELL_IMPORT } },
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
	const re = /\/\*(\d+):(cf|er)\*\//g;
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
	return {
		normalized: normalizeCodeFixes({ success: true, body: allFixes }),
		diagCodes: body.map(d => d.code),
	};
}

async function runCmd(send, mk) {
	const pos = offsetToLineCol(mk.content, mk.offset);
	if (mk.cmd === 'cf') {
		const { normalized, diagCodes } = await runCodeFixesForFile(send, mk.file);
		return { cmd: 'cf', diagCodes, normalized };
	}
	if (mk.cmd === 'er') {
		const endPos = offsetToLineCol(mk.content, Math.min(mk.offset + 30, mk.content.length));
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
			const actions = r.actions ?? [];
			for (const a of actions) {
				if (/return type|Infer|type annotation|predicate/i.test(`${r.name} ${a.name} ${a.description ?? ''}`)) {
					refactorName = r.name;
					actionName = a.name;
					break;
				}
			}
			if (refactorName) break;
		}
		if (!refactorName) {
			for (const r of Array.isArray(body) ? body : []) {
				if (r.actions?.length) {
					refactorName = r.name;
					actionName = r.actions[0].name;
					break;
				}
			}
		}
		if (!refactorName) {
			return { cmd: 'er', normalized: { success: true, body: [], refactors: body } };
		}
		try {
			return {
				cmd: 'er',
				refactor: refactorName,
				action: actionName,
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
		} catch (e) {
			return {
				cmd: 'er',
				refactor: refactorName,
				action: actionName,
				normalized: { success: false, error: String(e?.message ?? e) },
			};
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

// Spelling description对照 for ids 1–5,10
for (const id of [1, 2, 3, 4, 5, 10]) {
	const tFixes = tnb[id]?.normalized?.body ?? [];
	const sFixes = stock[id]?.normalized?.body ?? [];
	const tSpell = tFixes.filter(f => f.fixName === 'spelling' || /spelling|Change spelling/i.test(f.description ?? ''));
	const sSpell = sFixes.filter(f => f.fixName === 'spelling' || /spelling|Change spelling/i.test(f.description ?? ''));
	console.log(`\n[spelling id=${id}] stock: ${JSON.stringify(sSpell.map(f => f.description))}`);
	console.log(`[spelling id=${id}] tnb:   ${JSON.stringify(tSpell.map(f => f.description))}`);
	console.log(`[spelling id=${id}] diags stock=${JSON.stringify(stock[id]?.diagCodes)} tnb=${JSON.stringify(tnb[id]?.diagCodes)}`);
}

if (diff > 0) {
	for (const d of diffs) {
		console.log(`\n--- diff id=${d.id} cmd=${d.cmd} @ ${d.file}:${d.lineCol.line}:${d.lineCol.offset} ---`);
		console.log('TNB:', JSON.stringify(d.tnb, null, 2));
		console.log('STOCK:', JSON.stringify(d.stock, null, 2));
	}
}
process.exitCode = diff === 0 ? 0 : 1;
