#!/usr/bin/env node
/**
 * Witness: hover positions inside lib.es5.d.ts must not drift across the
 * TNB disk lib ↔ tsgo bundled mapping. Opens each side's own lib.es5.d.ts
 * and compares quickinfo at three positions located by content (not line #).
 *
 * Usage: node tools/triage-libhover-drift.mjs
 * Output: ... verdict: PARITY|DIFF
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const volarRoot = resolveVolarRoot();
const stockTsserver = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbTsserver = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const tnbLib = path.join(repoRoot, 'lib', 'lib.es5.d.ts');
const stockLib = process.env.STOCK_LIB_ES5 ?? '/tmp/stock-ts-p3/package/lib/lib.es5.d.ts';

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--suppressDiagnosticEvents',
];

function offsetToLineCol(text, off) {
	let line = 1, col = 1;
	for (let i = 0; i < off; i++) {
		if (text[i] === '\n') { line++; col = 1; } else col++;
	}
	return { line, offset: col };
}

/** Locate String.concat JSDoc /**, charCodeAt name, concat name — no hardcoded lines. */
function locatePositions(text) {
	const concatDecl = text.indexOf('    concat(...strings: string[]): string;');
	if (concatDecl < 0) throw new Error('concat(...strings) declaration not found');
	const jsdoc = text.lastIndexOf('/**', concatDecl);
	if (jsdoc < 0 || jsdoc < concatDecl - 400) throw new Error('concat JSDoc /** not found before declaration');
	const charDecl = text.lastIndexOf('    charCodeAt(index: number): number;', concatDecl);
	if (charDecl < 0) throw new Error('charCodeAt declaration not found before concat');
	const charName = charDecl + '    '.length; // start of identifier
	const concatName = concatDecl + '    '.length;
	return {
		a_jsdoc: { ...offsetToLineCol(text, jsdoc), byte: jsdoc, label: 'concat-jsdoc-/**' },
		b_charCodeAt: { ...offsetToLineCol(text, charName), byte: charName, label: 'charCodeAt-ident' },
		c_concat: { ...offsetToLineCol(text, concatName), byte: concatName, label: 'concat-ident' },
	};
}

/** Symbol-facing part of displayString (drop trailing doc-ish / overload-count noise). */
function symbolPart(displayString) {
	if (displayString == null) return null;
	// displayString is the signature line(s); take up to first blank line
	const s = String(displayString);
	const cut = s.search(/\n\s*\n/);
	let core = (cut >= 0 ? s.slice(0, cut) : s).trim();
	// Stock vs TNB/tsgo may differ on "(+N overload)" presentation for the same symbol.
	core = core.replace(/\s*\(\+\d+\s+overloads?\)\s*$/i, '').trim();
	return core;
}

function summarizeQi(qi) {
	const body = qi?.body;
	return {
		success: qi?.success ?? false,
		displayString: body?.displayString ?? null,
		symbol: symbolPart(body?.displayString ?? null),
		documentation: body?.documentation ?? null,
		kind: body?.kind ?? null,
	};
}

async function run(label, tsserverPath, libFile, env) {
	const fileContent = fs.readFileSync(libFile, 'utf8');
	const positions = locatePositions(fileContent);
	const projectRoot = path.dirname(libFile);
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: libFile, fileContent, projectRootPath: projectRoot }],
		});
		const out = { label, libFile, positions: {} };
		for (const [key, pos] of Object.entries(positions)) {
			const qi = await send('quickinfo', {
				file: libFile,
				line: pos.line,
				offset: pos.offset,
			});
			out.positions[key] = { pos, qi: summarizeQi(qi), rawSuccess: qi?.success, rawBody: qi?.body ?? null };
		}
		return out;
	});
}

function sameAbsentOrEqual(a, b) {
	const aAbsent = !a.success || a.displayString == null;
	const bAbsent = !b.success || b.displayString == null;
	if (aAbsent && bAbsent) return true;
	if (aAbsent !== bAbsent) return false;
	// both present: require identical response shape for (a) — symbol + kind
	return a.symbol === b.symbol && a.kind === b.kind;
}

function sameSymbol(a, b) {
	if (!a.success || !b.success) return false;
	if (a.symbol == null || b.symbol == null) return false;
	return a.symbol === b.symbol;
}

const tnb = await run('TNB', tnbTsserver, tnbLib, tnbHarnessEnv());
const stock = await run('STOCK', stockTsserver, stockLib, process.env);

for (const r of [tnb, stock]) {
	console.log(`\n=== ${r.label} lib=${r.libFile} ===`);
	for (const [key, entry] of Object.entries(r.positions)) {
		const { pos, qi } = entry;
		console.log(
			`${key} (${pos.label}) line=${pos.line} col=${pos.offset} success=${qi.success} kind=${JSON.stringify(qi.kind)}`,
		);
		console.log(`  displayString=${JSON.stringify(qi.displayString)}`);
		console.log(`  symbol=${JSON.stringify(qi.symbol)}`);
		console.log(`  documentation=${JSON.stringify(qi.documentation)?.slice(0, 200)}`);
	}
}

const checks = {
	a_jsdoc: sameAbsentOrEqual(tnb.positions.a_jsdoc.qi, stock.positions.a_jsdoc.qi),
	b_charCodeAt: sameSymbol(tnb.positions.b_charCodeAt.qi, stock.positions.b_charCodeAt.qi),
	c_concat: sameSymbol(tnb.positions.c_concat.qi, stock.positions.c_concat.qi),
};

console.log('\n--- checks ---');
for (const [k, ok] of Object.entries(checks)) {
	console.log(`${k}: ${ok ? 'PASS' : 'FAIL'}`);
}

// Report documentation diffs (expected when lib versions differ; not part of verdict)
for (const key of ['b_charCodeAt', 'c_concat']) {
	const td = tnb.positions[key].qi.documentation;
	const sd = stock.positions[key].qi.documentation;
	if (td !== sd) {
		console.log(`doc-diff ${key}: TNB=${JSON.stringify(td)?.slice(0, 160)} STOCK=${JSON.stringify(sd)?.slice(0, 160)}`);
	} else {
		console.log(`doc-diff ${key}: (identical)`);
	}
}

const parity = checks.a_jsdoc && checks.b_charCodeAt && checks.c_concat;
console.log(`\nverdict: ${parity ? 'PARITY' : 'DIFF'}`);
process.exitCode = parity ? 0 : 1;
