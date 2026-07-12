#!/usr/bin/env node
/**
 * Final-3 batch parity for the last 3 REACHABLE TypeChecker throws:
 *   getMemberOverrideModifierStatus, getSymbolOfExpando, getSymbolWalker.
 *
 * Dual-server: TNB vs stock. Fixtures in /tmp/tnb-final3-fixtures/.
 *
 * Markers: slash-star-N:cmd-star-slash
 *   ci  = completionInfo (override insertText)
 *   sg  = suggestionDiagnosticsSync (80002 convert-to-class)
 *   er  = getApplicableRefactors + getEditsForRefactor (extract → <T>)
 *
 * Usage: node tools/triage-final3-batch.mjs
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
const fixtureDir = '/tmp/tnb-final3-fixtures';

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--suppressDiagnosticEvents',
];

const TSCONFIG_OVERRIDE = {
	compilerOptions: {
		target: 'ES2020',
		module: 'ESNext',
		moduleResolution: 'bundler',
		strict: true,
		noEmit: true,
		noImplicitOverride: true,
		lib: ['ES2020'],
	},
	include: ['*.ts'],
};

const TSCONFIG_JS = {
	compilerOptions: {
		target: 'ES2020',
		module: 'ESNext',
		moduleResolution: 'bundler',
		allowJs: true,
		checkJs: true,
		noEmit: true,
		lib: ['ES2020'],
	},
	include: ['*.js'],
};

const TSCONFIG_EXTRACT = {
	compilerOptions: {
		target: 'ES2020',
		module: 'ESNext',
		moduleResolution: 'bundler',
		strict: true,
		noEmit: true,
		lib: ['ES2020'],
	},
	include: ['*.ts'],
};

/** getMemberOverrideModifierStatus — complete inherited member → override prefix */
const OVERRIDE = `// getMemberOverrideModifierStatus
class Base {
  method() { return 1; }
  prop = 2;
}
class Child extends Base {
  /*1:ci*/
}
`;

/** getSymbolOfExpando — JS function expression + static expando → 80002 */
const EXPANDO = `// getSymbolOfExpando
var /*2:sg*/f = function() {};
f.x = 1;
`;

/** getSymbolWalker — extract expr whose type mentions type param T (start/end markers). */
const EXTRACT = `// getSymbolWalker
function outer<T>(x: T[]) {
  const y = /*3:er*/x.map(v => v)/*3e:er*/;
  return y;
}
`;

/** @typedef {{ dir: string; tsconfig: object; files: Record<string, string> }} Project */

/** @type {Project[]} */
const PROJECTS = [
	{ dir: 'f1-override', tsconfig: TSCONFIG_OVERRIDE, files: { 'override.ts': OVERRIDE } },
	{ dir: 'f2-expando', tsconfig: TSCONFIG_JS, files: { 'expando.js': EXPANDO } },
	{ dir: 'f3-extract', tsconfig: TSCONFIG_EXTRACT, files: { 'extract.ts': EXTRACT } },
];

function ensureFixtures() {
	fs.rmSync(fixtureDir, { recursive: true, force: true });
	fs.mkdirSync(fixtureDir, { recursive: true });
	for (const proj of PROJECTS) {
		const root = path.join(fixtureDir, proj.dir);
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(proj.tsconfig, null, 2));
		for (const [name, content] of Object.entries(proj.files)) {
			fs.writeFileSync(path.join(root, name), content);
		}
	}
}

/** @typedef {{ id: number; cmd: string; file: string; offset: number; endOffset?: number; content: string }} Marker */

function collectMarkers(file, content) {
	const re = /\/\*(\d+)(e)?:(ci|sg|er)\*\//g;
	/** @type {Map<number, Marker>} */
	const byId = new Map();
	let m;
	while ((m = re.exec(content))) {
		const id = Number(m[1]);
		const isEnd = !!m[2];
		const cmd = m[3];
		const pos = m.index + m[0].length;
		if (isEnd) {
			const existing = byId.get(id);
			if (existing) existing.endOffset = m.index;
			else byId.set(id, { id, cmd, file, offset: pos, endOffset: m.index, content });
		} else {
			const existing = byId.get(id);
			if (existing) {
				existing.offset = pos;
			} else {
				byId.set(id, { id, cmd, file, offset: pos, content });
			}
		}
	}
	return [...byId.values()];
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
	if (!body) return { success: !!res.success, body: null };
	const entries = (body.entries ?? []).map(e => ({
		name: e.name,
		kind: e.kind,
		insertText: e.insertText ?? null,
		isSnippet: !!e.isSnippet,
		hasAction: !!e.hasAction,
	})).filter(e => e.name === 'method' || e.name === 'prop' || (e.insertText && /override/.test(String(e.insertText))))
		.sort((a, b) => String(a.name).localeCompare(String(b.name)));
	return {
		success: !!res.success,
		isGlobalCompletion: !!body.isGlobalCompletion,
		isMemberCompletion: !!body.isMemberCompletion,
		entries,
	};
}

function normalizeSuggestions(res) {
	if (!res) return { success: false, body: null };
	const body = Array.isArray(res.body) ? res.body : [];
	const list = body.map(d => ({
		code: d.code,
		category: d.category,
		message: d.message ?? d.text ?? null,
	})).filter(d => d.code === 80002 || /converted to a class/i.test(String(d.message ?? '')))
		.sort((a, b) => (a.code ?? 0) - (b.code ?? 0));
	return { success: !!res.success, body: list, allCodes: body.map(d => d.code).sort((a, b) => a - b) };
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

function pickExtractAction(body) {
	const list = Array.isArray(body) ? body : [];
	// Prefer extract to function in global/module scope (carries type params).
	for (const r of list) {
		for (const a of r.actions ?? []) {
			const desc = String(a.description ?? '');
			if (/extract to function in (global|module) scope/i.test(desc)) {
				return { refactorName: r.name, actionName: a.name, description: a.description };
			}
		}
	}
	for (const r of list) {
		for (const a of r.actions ?? []) {
			if (/extract.*function/i.test(`${r.name} ${a.name} ${a.description ?? ''}`)) {
				return { refactorName: r.name, actionName: a.name, description: a.description };
			}
		}
	}
	for (const r of list) {
		if (r.actions?.length) {
			return { refactorName: r.name, actionName: r.actions[0].name, description: r.actions[0].description };
		}
	}
	return null;
}

async function runCmd(send, mk) {
	const pos = offsetToLineCol(mk.content, mk.offset);
	if (mk.cmd === 'ci') {
		const res = await send('completionInfo', {
			file: mk.file,
			line: pos.line,
			offset: pos.offset,
			includeExternalModuleExports: false,
			includeInsertTextCompletions: true,
		});
		return { cmd: 'ci', normalized: normalizeCompletionInfo(res) };
	}
	if (mk.cmd === 'sg') {
		const res = await send('suggestionDiagnosticsSync', { file: mk.file, includeLinePosition: true });
		return { cmd: 'sg', normalized: normalizeSuggestions(res) };
	}
	if (mk.cmd === 'er') {
		const endOff = mk.endOffset ?? Math.min(mk.offset + 20, mk.content.length);
		const endPos = offsetToLineCol(mk.content, endOff);
		const refactors = await send('getApplicableRefactors', {
			file: mk.file,
			startLine: pos.line,
			startOffset: pos.offset,
			endLine: endPos.line,
			endOffset: endPos.offset,
		});
		const picked = pickExtractAction(refactors?.body ?? []);
		if (!picked) {
			return {
				cmd: 'er',
				normalized: {
					success: true,
					body: [],
					refactors: (refactors?.body ?? []).map(r => ({
						name: r.name,
						actions: (r.actions ?? []).map(a => ({ name: a.name, description: a.description })),
					})),
				},
			};
		}
		try {
			const edits = await send('getEditsForRefactor', {
				file: mk.file,
				startLine: pos.line,
				startOffset: pos.offset,
				endLine: endPos.line,
				endOffset: endPos.offset,
				refactor: picked.refactorName,
				action: picked.actionName,
			});
			return {
				cmd: 'er',
				refactor: picked.refactorName,
				action: picked.actionName,
				description: picked.description,
				normalized: normalizeEdits(edits),
			};
		} catch (e) {
			return {
				cmd: 'er',
				refactor: picked.refactorName,
				action: picked.actionName,
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
				includeCompletionsForModuleExports: false,
				includeCompletionsWithInsertText: true,
				includeCompletionsWithSnippetText: true,
				includeCompletionsWithClassMemberSnippets: true,
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
/** @type {Record<number, unknown>} */
const tnb = {};
/** @type {Record<number, unknown>} */
const stock = {};

const traceFile = process.env.TNB_TRACE_THROW_FILE;
const baseEnv = tnbHarnessEnv();
if (process.env.TNB_TRACE_THROW) {
	baseEnv.TNB_TRACE_THROW = process.env.TNB_TRACE_THROW;
}
if (traceFile) {
	baseEnv.TNB_TRACE_THROW_FILE = traceFile;
	try { fs.unlinkSync(traceFile); } catch { /* ok */ }
}

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

	const tnbPart = await runProject(tnbPath, baseEnv, markers, openFiles);
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
	if (deepEqual(a?.normalized, b?.normalized)) matched++;
	else {
		diffs.push({ id: mk.id, cmd: mk.cmd, file: path.basename(mk.file), tnb: a, stock: b });
		console.log(`id=${mk.id} DIFF file=${path.basename(mk.file)} cmd=${mk.cmd}`);
		console.log(`  stock=${JSON.stringify(b?.normalized ?? null, null, 2)}`);
		console.log(`  tnb=${JSON.stringify(a?.normalized ?? null, null, 2)}`);
		if (mk.cmd === 'er') {
			console.log(`  stockEditsFull=${JSON.stringify(b, null, 2)}`);
			console.log(`  tnbEditsFull=${JSON.stringify(a, null, 2)}`);
		}
	}
}

const positions = allMarkers.length;
const diff = diffs.length;
console.log(`positions=${positions} matched=${matched} diff=${diff}`);
if (diff === 0) {
	for (const mk of allMarkers) console.log(`id=${mk.id} MATCHED file=${path.basename(mk.file)} cmd=${mk.cmd}`);
}

if (traceFile && fs.existsSync(traceFile)) {
	const lines = fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean);
	const counts = {};
	for (const line of lines) {
		try {
			const j = JSON.parse(line);
			const m = j.method ?? j.name ?? '?';
			counts[m] = (counts[m] ?? 0) + 1;
		} catch { /* ignore */ }
	}
	console.log(`traceFile=${traceFile} hits=${lines.length} counts=${JSON.stringify(counts)}`);
} else if (traceFile) {
	console.log(`traceFile=${traceFile} hits=0 (file absent)`);
}

process.exitCode = diff > 0 ? 1 : 0;
