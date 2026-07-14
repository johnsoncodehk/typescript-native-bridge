#!/usr/bin/env node
/**
 * Minimal repro + H1/H2/H3 experiments for post-delete quickinfo success-semantics DIFF.
 *
 * Session2 SHORT: open → insert const → insert "(" → delete "(" → quickinfo @ L9:C11
 * Stock: success=false ("No content available.")
 * TNB:   success=true, displayString=""
 *
 * Usage: node tools/triage-qi-delete-min.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testWorkspacePath = path.join(volarRoot, 'test-workspace');
const vueFile = path.join(testWorkspacePath, 'component-meta/#5546/main.vue');
const require = createRequire(import.meta.url);

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
];

const originalVue = fs.readFileSync(vueFile, 'utf8');

/** Reproduce session2 steps 1–3 content end-state (in memory). */
function applySession2ToContent(src) {
	// step1: insert const at L5:C1
	let c = applyLC(src, 5, 1, 5, 1, 'const _tmp1 = 1;\n');
	// step2: insert "(" at L9:C11
	c = applyLC(c, 9, 11, 9, 11, '(');
	// step3: delete "(" at L9:C11–C12
	c = applyLC(c, 9, 11, 9, 12, '');
	return c;
}

function applyLC(text, sl, so, el, eo, newText) {
	const start = lineColToOffset(text, sl, so);
	const end = lineColToOffset(text, el, eo);
	return text.slice(0, start) + newText + text.slice(end);
}

function lineColToOffset(text, line, col) {
	let l = 1;
	let i = 0;
	while (i < text.length && l < line) {
		if (text[i] === '\n') l++;
		i++;
	}
	return Math.min(text.length, i + Math.max(0, col - 1));
}

function offsetToLineCol(text, offset) {
	let line = 1;
	let col = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === '\n') {
			line++;
			col = 1;
		} else col++;
	}
	return { line, offset: col };
}

function summarizeQi(res) {
	const body = res?.body;
	return {
		success: !!res?.success,
		message: res?.message ?? null,
		displayString: body?.displayString ?? null,
		kind: body?.kind ?? null,
		kindModifiers: body?.kindModifiers ?? null,
		start: body?.start ?? null,
		end: body?.end ?? null,
		documentation: body?.documentation ?? null,
		tagsLen: Array.isArray(body?.tags) ? body.tags.length : null,
		bodyKeys: body ? Object.keys(body) : [],
	};
}

function isDiff(tnb, stock) {
	return tnb.success !== stock.success
		|| (tnb.displayString ?? null) !== (stock.displayString ?? null);
}

async function runSide(label, tsserverPath, env, {
	file,
	projectRoot,
	openContent,
	edits, // [{start:{line,offset}, end:{line,offset}, newText}] applied via updateOpen
	qiLine,
	qiOffset,
	args = harnessArgs,
}) {
	return withTsserver({
		tsserverPath,
		args,
		env,
		deadlineMs: 120_000,
	}, async ({ send }) => {
		await send('configure', {
			preferences: {
				includeCompletionsForModuleExports: false,
				includeCompletionsWithInsertText: true,
			},
		});
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file, fileContent: openContent, projectRootPath: projectRoot }],
		});
		for (const tc of edits ?? []) {
			await send('updateOpen', {
				openFiles: [],
				closedFiles: [],
				changedFiles: [{
					fileName: file,
					textChanges: [tc],
				}],
			});
		}
		const res = await send('quickinfo', { file, line: qiLine, offset: qiOffset }, 30_000);
		return summarizeQi(res);
	});
}

async function compareBoth(tag, opts, { tnbEnvExtra = {} } = {}) {
	const tnb = await runSide('TNB', tnbPath, tnbHarnessEnv(tnbEnvExtra), opts);
	const stock = await runSide('STOCK', stockPath, process.env, opts);
	const diff = isDiff(tnb, stock);
	console.log(`\n=== ${tag} ===`);
	console.log(`DIFF=${diff}`);
	console.log('TNB  ', JSON.stringify(tnb));
	console.log('STOCK', JSON.stringify(stock));
	return { tag, diff, tnb, stock };
}

function dumpTokenAt(content, line, offset, label) {
	// Use stock typescript for a canonical token dump (AST of the same final text).
	const stockTsPath = path.join(path.dirname(stockPath), 'typescript.js');
	const ts = require(fs.existsSync(stockTsPath) ? stockTsPath : path.join(volarRoot, 'node_modules/typescript/lib/typescript.js'));
	const sf = ts.createSourceFile('probe.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const pos = lineColToOffset(content, line, offset);
	// Position past last char of line: clamp into file for getTokenAtPosition.
	const clamp = Math.min(pos, Math.max(0, content.length - 1));
	const tok = ts.getTokenAtPosition(sf, clamp);
	const touch = ts.getTouchingPropertyName(sf, clamp);
	const kindName = (k) => ts.SyntaxKind[k] ?? String(k);
	const info = {
		label,
		line,
		offset,
		bytePos: pos,
		clampPos: clamp,
		charAtClamp: JSON.stringify(content[clamp] ?? '<eof>'),
		charBefore: JSON.stringify(content[clamp - 1] ?? '<sof>'),
		tokenKind: kindName(tok.kind),
		tokenText: JSON.stringify(tok.getText(sf)),
		tokenSpan: `${tok.getStart(sf)}..${tok.end}`,
		touchKind: kindName(touch.kind),
		touchText: JSON.stringify(touch.getText(sf)),
		touchSpan: `${touch.getStart(sf)}..${touch.end}`,
	};
	console.log(`TOKEN ${label}:`, JSON.stringify(info));
	return info;
}

// ─── Final content after session2 steps 1–3 ───
const finalVue = applySession2ToContent(originalVue);
const qiLine = 9;
const qiOffset = 11;
console.log('--- finalVue around L9 ---');
const finalLines = finalVue.split('\n');
for (let i = 6; i <= 10 && i < finalLines.length; i++) {
	console.log(`L${i + 1}: ${JSON.stringify(finalLines[i])}`);
}
console.log(`probe L${qiLine}:C${qiOffset} → byte ${lineColToOffset(finalVue, qiLine, qiOffset)}`);

const session2Edits = [
	{ start: { line: 5, offset: 1 }, end: { line: 5, offset: 1 }, newText: 'const _tmp1 = 1;\n' },
	{ start: { line: 9, offset: 11 }, end: { line: 9, offset: 11 }, newText: '(' },
	{ start: { line: 9, offset: 11 }, end: { line: 9, offset: 12 }, newText: '' },
];

const results = [];

// ─── MIN1: exact ≤3-step edit path on .vue ───
results.push(await compareBoth('MIN1_vue_edit_path', {
	file: vueFile,
	projectRoot: testWorkspacePath,
	openContent: originalVue,
	edits: session2Edits,
	qiLine,
	qiOffset,
}));

// ─── MIN2: fresh server, open already-final content (no edits) ───
results.push(await compareBoth('MIN2_vue_fresh_final', {
	file: vueFile,
	projectRoot: testWorkspacePath,
	openContent: finalVue,
	edits: [],
	qiLine,
	qiOffset,
}));

// ─── MIN3: open after-step1, only paren insert+delete (2 edits) ───
const afterStep1 = applyLC(originalVue, 5, 1, 5, 1, 'const _tmp1 = 1;\n');
results.push(await compareBoth('MIN3_vue_paren_only', {
	file: vueFile,
	projectRoot: testWorkspacePath,
	openContent: afterStep1,
	edits: [
		{ start: { line: 9, offset: 11 }, end: { line: 9, offset: 11 }, newText: '(' },
		{ start: { line: 9, offset: 11 }, end: { line: 9, offset: 12 }, newText: '' },
	],
	qiLine,
	qiOffset,
}));

// ─── MIN4: pure .ts in /tmp — minimal type with `close: []` EOL after `]` ───
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-qi-del-'));
const tsFile = path.join(tmpDir, 'repro.ts');
const tsContent = [
	'type Emits = {',
	'	close: []',
	'}',
	'',
].join('\n');
// L2 = `	close: []` — C11 = EOL after `]`
fs.writeFileSync(tsFile, tsContent);
fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { strict: true, target: 'ESNext', module: 'ESNext' },
	include: ['*.ts'],
}));
const tsArgs = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];
const tsQi = { line: 2, offset: 11 };
results.push(await compareBoth('MIN4_pure_ts_fresh', {
	file: tsFile,
	projectRoot: tmpDir,
	openContent: tsContent,
	edits: [],
	qiLine: tsQi.line,
	qiOffset: tsQi.offset,
	args: tsArgs,
}));

// Edit path on pure .ts: insert+delete "(" at EOL
results.push(await compareBoth('MIN5_pure_ts_edit_path', {
	file: tsFile,
	projectRoot: tmpDir,
	openContent: tsContent,
	edits: [
		{ start: { line: 2, offset: 11 }, end: { line: 2, offset: 11 }, newText: '(' },
		{ start: { line: 2, offset: 11 }, end: { line: 2, offset: 12 }, newText: '' },
	],
	qiLine: tsQi.line,
	qiOffset: tsQi.offset,
	args: tsArgs,
}));

// Even smaller: `const x: []` QI after `]`
const ts2 = path.join(tmpDir, 'tiny.ts');
const tiny = 'const x: [] = [];\n';
// `const x: [] = [];` — find `]` of type (first `]`) end+1
const firstClose = tiny.indexOf(']');
const tinyPos = offsetToLineCol(tiny, firstClose + 1); // after first ]
fs.writeFileSync(ts2, tiny);
results.push(await compareBoth('MIN6_tiny_const_fresh', {
	file: ts2,
	projectRoot: tmpDir,
	openContent: tiny,
	edits: [],
	qiLine: tinyPos.line,
	qiOffset: tinyPos.offset,
	args: tsArgs,
}));

// ─── H1: TRACE_SYM on edit-path vs fresh ───
const traceEdit = '/tmp/tnb-qi-del-trace-edit.txt';
const traceFresh = '/tmp/tnb-qi-del-trace-fresh.txt';
for (const f of [traceEdit, traceFresh]) {
	try { fs.unlinkSync(f); } catch { /* */ }
}

console.log('\n=== H1_TRACE edit-path (TSGO_TRACE_SYM) ===');
const h1Edit = await runSide('TNB', tnbPath, tnbHarnessEnv({
	TSGO_TRACE_SYM: '1',
	TSGO_TRACE_SYM_FILE: traceEdit,
}), {
	file: vueFile,
	projectRoot: testWorkspacePath,
	openContent: originalVue,
	edits: session2Edits,
	qiLine,
	qiOffset,
});
console.log('TNB QI', JSON.stringify(h1Edit));
if (fs.existsSync(traceEdit)) {
	const lines = fs.readFileSync(traceEdit, 'utf8').split('\n').filter(l => /getSymbolAtLocation return path=/.test(l));
	console.log(`trace return-path lines (${lines.length}):`);
	for (const l of lines.slice(-20)) console.log(l);
	const paths = lines.map(l => (l.match(/path=(\S+)/) || [])[1]).filter(Boolean);
	console.log('path histogram:', JSON.stringify(Object.fromEntries(
		[...paths.reduce((m, p) => m.set(p, (m.get(p) || 0) + 1), new Map())],
	)));
} else {
	console.log('NO TRACE FILE for edit');
}

console.log('\n=== H1_TRACE fresh-final (TSGO_TRACE_SYM) ===');
const h1Fresh = await runSide('TNB', tnbPath, tnbHarnessEnv({
	TSGO_TRACE_SYM: '1',
	TSGO_TRACE_SYM_FILE: traceFresh,
}), {
	file: vueFile,
	projectRoot: testWorkspacePath,
	openContent: finalVue,
	edits: [],
	qiLine,
	qiOffset,
});
console.log('TNB QI', JSON.stringify(h1Fresh));
if (fs.existsSync(traceFresh)) {
	const lines = fs.readFileSync(traceFresh, 'utf8').split('\n').filter(l => /getSymbolAtLocation return path=/.test(l));
	console.log(`trace return-path lines (${lines.length}):`);
	for (const l of lines.slice(-20)) console.log(l);
	const paths = lines.map(l => (l.match(/path=(\S+)/) || [])[1]).filter(Boolean);
	console.log('path histogram:', JSON.stringify(Object.fromEntries(
		[...paths.reduce((m, p) => m.set(p, (m.get(p) || 0) + 1), new Map())],
	)));
} else {
	console.log('NO TRACE FILE for fresh');
}

// H1 verdict
const editDiff = results.find(r => r.tag === 'MIN1_vue_edit_path')?.diff;
const freshDiff = results.find(r => r.tag === 'MIN2_vue_fresh_final')?.diff;
console.log('\n=== H1 VERDICT ===');
console.log(`editDiff=${editDiff} freshDiff=${freshDiff}`);
if (editDiff && freshDiff) {
	console.log('H1 REJECTED (cache pollution): fresh server also DIFF → not edit-cache residue');
} else if (editDiff && !freshDiff) {
	console.log('H1 CONFIRMED: only edit path DIFF → cache invalidation issue');
} else {
	console.log('H1 INCONCLUSIVE / no DIFF on edit path');
}

// ─── H2: token dump on final content ───
console.log('\n=== H2 TOKEN DUMP ===');
// Extract script block for plain-TS token analysis approximating Volar script AST.
const scriptMatch = finalVue.match(/<script[^>]*>([\s\S]*?)<\/script>/);
const scriptBody = scriptMatch ? scriptMatch[1].replace(/^\n/, '') : finalVue;
// Map vue L9 → script-local: vue L1 is <script>, so script line 1 = vue L2.
// Vue L9 after edits = `	close: []` which is script-relative.
const scriptLines = scriptBody.split('\n');
console.log('scriptBody lines around probe:');
for (let i = 0; i < scriptLines.length; i++) {
	if (i >= 5 && i <= 9) console.log(`scriptL${i + 1}: ${JSON.stringify(scriptLines[i])}`);
}
// Find `close: []` line in script and probe at col 11
let closeLine = scriptLines.findIndex(l => l.includes('close: []')) + 1;
const tokenVueApprox = dumpTokenAt(scriptBody, closeLine, 11, 'script_close_EOL');
dumpTokenAt(tsContent, 2, 11, 'pure_ts_close_EOL');
dumpTokenAt(tiny, tinyPos.line, tinyPos.offset, 'tiny_after_type_bracket');

// Also: what does QI body span map to in content?
const tnbBody = results.find(r => r.tag === 'MIN1_vue_edit_path')?.tnb;
if (tnbBody?.start && tnbBody?.end) {
	const sl = tnbBody.start.line;
	const so = tnbBody.start.offset;
	const el = tnbBody.end.line;
	const eo = tnbBody.end.offset;
	const a = lineColToOffset(finalVue, sl, so);
	const b = lineColToOffset(finalVue, el, eo);
	console.log('TNB textSpan text:', JSON.stringify(finalVue.slice(a, b)));
	console.log('TNB textSpan loc:', JSON.stringify({ start: tnbBody.start, end: tnbBody.end }));
}

console.log('\n=== H2 VERDICT ===');
console.log(`tokenKind=${tokenVueApprox.tokenKind} touchKind=${tokenVueApprox.touchKind}`);
if (/CloseBracket|CloseBrace|OpenParen|CloseParen|Comma|Colon|Equals|Semicolon/.test(tokenVueApprox.touchKind)
	|| /CloseBracket|CloseBrace/.test(tokenVueApprox.tokenKind)) {
	console.log('H2 LIKELY: probe sits on punctuation; stock empty-family; TNB may positional-RPC neighbor');
} else {
	console.log('H2 unclear from token kind alone');
}

// ─── H3: display-layer — already have body fields; call out empty vs null ───
console.log('\n=== H3 DISPLAY LAYER ===');
const sample = results.find(r => r.tag === 'MIN1_vue_edit_path');
console.log('TNB body fields:', JSON.stringify({
	kind: sample?.tnb?.kind,
	kindModifiers: sample?.tnb?.kindModifiers,
	start: sample?.tnb?.start,
	end: sample?.tnb?.end,
	displayString: sample?.tnb?.displayString,
	documentation: sample?.tnb?.documentation,
	tagsLen: sample?.tnb?.tagsLen,
}));
console.log('STOCK:', JSON.stringify({
	success: sample?.stock?.success,
	message: sample?.stock?.message,
	bodyKeys: sample?.stock?.bodyKeys,
}));
const hasSubstance = !!(sample?.tnb?.kind && sample.tnb.kind !== '' && sample.tnb.kind !== 'unknown'
	&& sample?.tnb?.displayString);
const hasSpanOnly = !!(sample?.tnb?.success && sample?.tnb?.displayString === ''
	&& sample?.tnb?.start && sample?.tnb?.kind);
console.log(`H3: hasSubstance=${hasSubstance} hasSpanOnly=${hasSpanOnly}`);
if (sample?.tnb?.success && sample.tnb.displayString === '' && sample?.tnb?.kind) {
	console.log('H3 PARTIAL: TNB returns a QuickInfo shell (kind/spans) with empty displayString — success wrapped around empty parts');
	console.log('  (root cause still likely symbol mis-hit producing empty/low-info display, not displayString formatting alone)');
} else {
	console.log('H3 REJECTED as sole cause');
}

// ─── Summary table ───
console.log('\n=== SUMMARY TABLE ===');
for (const r of results) {
	console.log(`${r.tag}\tdiff=${r.diff}\ttnb=${r.tnb.success}/${JSON.stringify(r.tnb.displayString)}\tstock=${r.stock.success}/${JSON.stringify(r.stock.displayString)}`);
}

console.log(`\ntmpDir=${tmpDir}`);
console.log('done');
