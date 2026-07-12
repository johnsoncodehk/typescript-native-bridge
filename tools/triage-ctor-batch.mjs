#!/usr/bin/env node
/**
 * Constructor batch 7+8 parity for 6 TypeChecker methods:
 * createSymbol, createSignature, createAnonymousType, createIndexInfo,
 * createArrayType, createPromiseType.
 *
 * Dual-server: TNB vs stock. Fixtures in /tmp/tnb-ctor-fixtures/.
 *
 * Markers: slash-star-N:cmd-star-slash
 *   cf = semantic diags → getCodeFixes
 *
 * Usage: node tools/triage-ctor-batch.mjs
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
const fixtureDir = '/tmp/tnb-ctor-fixtures';

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
		lib: ['ES2020', 'DOM'],
	},
	include: ['*.ts'],
};

/** createArrayType — inferFromUsage via push on untyped param */
const ARRAY_PUSH = `// createArrayType
function f(x/*1:cf*/) { x.push(1); }
`;

/** createSymbol / createAnonymousType / createIndexInfo — object property inference */
const OBJ_PROPS = `// createSymbol / createAnonymousType / createIndexInfo
function f(o/*2:cf*/) { o.a = 1; o.b = "s"; return o; }
`;

/** createSignature — callback argN synthesis */
const CALLBACK = `// createSignature
function g(cb/*3:cf*/) { cb(1, "x"); }
`;

/** returnValueCorrect — labeled object branch */
const RVC_LABEL = `// returnValueCorrect labeled object
function make(): { label: number } {
  /*4:cf*/label: 1;
}
`;

/** returnValueCorrect — function wrap / Promise branch */
const RVC_FN = `// returnValueCorrect function wrap
async function h(): Promise<number> {
  /*5:cf*/1;
}
`;

/** createPromiseType via inferFromUsage Promise usage */
const PROMISE_USAGE = `// createPromiseType
function p(x/*6:cf*/) { return Promise.resolve(x).then(v => v); }
p(1);
`;

/** @typedef {{ dir: string; files: Record<string, string> }} Project */

/** @type {Project[]} */
const PROJECTS = [
	{ dir: 'c1-array', files: { 'array.ts': ARRAY_PUSH } },
	{ dir: 'c2-obj', files: { 'obj.ts': OBJ_PROPS } },
	{ dir: 'c3-cb', files: { 'cb.ts': CALLBACK } },
	{ dir: 'c4-rvc-label', files: { 'rvc-label.ts': RVC_LABEL } },
	{ dir: 'c5-rvc-fn', files: { 'rvc-fn.ts': RVC_FN } },
	{ dir: 'c6-promise', files: { 'promise.ts': PROMISE_USAGE } },
];

function ensureFixtures() {
	fs.rmSync(fixtureDir, { recursive: true, force: true });
	fs.mkdirSync(fixtureDir, { recursive: true });
	for (const proj of PROJECTS) {
		const root = path.join(fixtureDir, proj.dir);
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(TSCONFIG_BASE, null, 2));
		for (const [name, content] of Object.entries(proj.files)) {
			fs.writeFileSync(path.join(root, name), content);
		}
	}
}

/** @typedef {{ id: number; cmd: string; file: string; offset: number; content: string }} Marker */

function collectMarkers(file, content) {
	const re = /\/\*(\d+):(cf)\*\//g;
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
	const { normalized, diagCodes } = await runCodeFixesForFile(send, mk.file);
	return { cmd: 'cf', diagCodes, normalized };
}

async function runProject(tsserverPath, env, markers, openFiles) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', {
			preferences: { includeCompletionsForModuleExports: true },
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
			tnb: a,
			stock: b,
		});
		console.log(`id=${mk.id} DIFF file=${path.basename(mk.file)}`);
		console.log(`  stockDiags=${JSON.stringify(b?.diagCodes ?? [])}`);
		console.log(`  tnbDiags=${JSON.stringify(a?.diagCodes ?? [])}`);
		console.log(`  stock=${JSON.stringify(b?.normalized ?? null)}`);
		console.log(`  tnb=${JSON.stringify(a?.normalized ?? null)}`);
	}
}

const positions = allMarkers.length;
const diff = diffs.length;
console.log(`positions=${positions} matched=${matched} diff=${diff}`);
if (diff === 0) {
	for (const mk of allMarkers) console.log(`id=${mk.id} MATCHED file=${path.basename(mk.file)}`);
}
process.exitCode = diff > 0 ? 1 : 0;
