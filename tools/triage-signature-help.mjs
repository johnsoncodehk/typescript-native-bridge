#!/usr/bin/env node
/**
 * Signature-help parity: TNB vs stock tsserver on self-built fixtures.
 * Fixtures live in /tmp/tnb-sighelp-fixtures/ (not in-repo).
 * Markers of the form slash-star-N-star-slash inside argument / type-arg
 * lists drive probe positions.
 *
 * Usage: node tools/triage-signature-help.mjs
 * Output: positions=N matched=M diff=D  (+ per-diff details when D>0)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const fixtureDir = '/tmp/tnb-sighelp-fixtures';
const fixtureFile = path.join(fixtureDir, 'sighelp.ts');
// Open under a throwaway project root so both servers share the same file path.
const projectRoot = fixtureDir;
const tsconfigPath = path.join(fixtureDir, 'tsconfig.json');

const harnessArgs = [
	'--disableAutomaticTypingAcquisition',
	'--suppressDiagnosticEvents',
];

function ensureFixtures() {
	fs.mkdirSync(fixtureDir, { recursive: true });
	if (!fs.existsSync(tsconfigPath)) {
		fs.writeFileSync(tsconfigPath, JSON.stringify({
			compilerOptions: {
				target: 'ES2020',
				module: 'ESNext',
				strict: true,
				noEmit: true,
			},
			include: ['*.ts'],
		}, null, 2));
	}
	if (!fs.existsSync(fixtureFile)) {
		throw new Error(`missing fixture ${fixtureFile}; expected handout fixtures`);
	}
}

/** Collect slash-star-N-star-slash marker offsets (probe just after the marker). */
function collectMarkers(content) {
	const re = /\/\*(\d+)\*\//g;
	const out = [];
	let m;
	while ((m = re.exec(content))) {
		out.push({
			id: Number(m[1]),
			// Probe at the first char after `/*N*/` (inside the arg slot).
			offset: m.index + m[0].length,
			markerOffset: m.index,
		});
	}
	out.sort((a, b) => a.id - b.id);
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

/** Strip session-volatile fields so JSON equality is meaningful. */
function normalizeHelp(res) {
	if (!res) return { success: false, body: null };
	const body = res.body;
	if (!body) {
		return { success: !!res.success, message: res.message ?? null, body: null };
	}
	return {
		success: !!res.success,
		body: {
			selectedItemIndex: body.selectedItemIndex,
			argumentIndex: body.argumentIndex,
			argumentCount: body.argumentCount,
			applicableSpan: body.applicableSpan
				? { start: body.applicableSpan.start, length: body.applicableSpan.length }
				: null,
			items: (body.items ?? []).map(normalizeItem),
		},
	};
}

function normalizeItem(item) {
	return {
		isVariadic: !!item.isVariadic,
		prefixDisplayParts: normalizeParts(item.prefixDisplayParts),
		suffixDisplayParts: normalizeParts(item.suffixDisplayParts),
		separatorDisplayParts: normalizeParts(item.separatorDisplayParts),
		parameters: (item.parameters ?? []).map(p => ({
			name: p.name,
			documentation: normalizeParts(p.documentation),
			displayParts: normalizeParts(p.displayParts),
			isOptional: !!p.isOptional,
		})),
		documentation: normalizeParts(item.documentation),
		tags: (item.tags ?? []).map(t => ({
			name: t.name,
			text: typeof t.text === 'string' ? t.text : normalizeParts(t.text),
		})),
	};
}

function normalizeParts(parts) {
	if (!parts) return [];
	if (typeof parts === 'string') return [{ text: parts, kind: 'text' }];
	return parts.map(p => ({ text: p.text, kind: p.kind }));
}

async function runAll(tsserverPath, env, content, markers) {
	return withTsserver({ tsserverPath, args: harnessArgs, env }, async ({ send }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: fixtureFile, fileContent: content, projectRootPath: projectRoot }],
		});
		const out = {};
		for (const mk of markers) {
			const pos = offsetToLineCol(content, mk.offset);
			const res = await send('signatureHelp', {
				file: fixtureFile,
				line: pos.line,
				offset: pos.offset,
				triggerReason: { kind: 'invoked' },
			});
			out[mk.id] = normalizeHelp(res);
		}
		return out;
	});
}

function deepEqual(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

ensureFixtures();
const content = fs.readFileSync(fixtureFile, 'utf8');
const markers = collectMarkers(content);
if (markers.length < 40) {
	console.error(`need ≥40 markers, got ${markers.length}`);
	process.exit(2);
}

const tnb = await runAll(tnbPath, tnbHarnessEnv(), content, markers);
const stock = await runAll(stockPath, process.env, content, markers);

let matched = 0;
const diffs = [];
for (const mk of markers) {
	const a = tnb[mk.id];
	const b = stock[mk.id];
	if (deepEqual(a, b)) matched++;
	else {
		diffs.push({
			id: mk.id,
			lineCol: offsetToLineCol(content, mk.offset),
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
		console.log(`\n--- diff id=${d.id} @ ${d.lineCol.line}:${d.lineCol.offset} ---`);
		console.log('TNB:', JSON.stringify(d.tnb, null, 2));
		console.log('STOCK:', JSON.stringify(d.stock, null, 2));
	}
}
process.exitCode = diff === 0 ? 0 : 1;
