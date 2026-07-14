#!/usr/bin/env node
/**
 * Family-1 whitespace print-shape matrix: same object type shape in
 * (a) variable QI, (b) parameter QI, (c) type alias QI, (d) return-type QI.
 * Dual-diff via withTsserver. Fixture lives under /tmp (not in-repo).
 *
 * Usage: node tools/triage-f1-ws-matrix.mjs
 * Exit 1 if any site DIFF.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { printQiDiff, quickinfoBoth } from './triage-f1-qi-common.mjs';

const fixtureDir = '/tmp/tnb-f1-ws-matrix';
const fixtureFile = path.join(fixtureDir, 'matrix.ts');

// Inline object types for (a)(b)(d) so QI expands the literal (alias names hide whitespace).
// (c) uses a type alias whose body is the same shape.
const SRC = [
	'type Obj = { value: string; };',
	'',
	'const varInline: { value: string } = { value: "a" };',
	'',
	'function takes(param: { value: string }) { return param; }',
	'',
	'function returns(): { value: string } { return { value: "a" }; }',
	'',
].join('\n');

function ensureFixture() {
	fs.mkdirSync(fixtureDir, { recursive: true });
	fs.writeFileSync(fixtureFile, SRC);
	fs.writeFileSync(
		path.join(fixtureDir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: { target: 'ES2020', module: 'ESNext', strict: true, noEmit: true },
			include: ['*.ts'],
		}, null, 2),
	);
}

function findIdent(content, ident, occurrence = 1) {
	let from = 0;
	for (let n = 0; n < occurrence; n++) {
		const idx = content.indexOf(ident, from);
		if (idx < 0) throw new Error(`ident ${ident} #${occurrence} not found`);
		// Ensure identifier boundary
		const before = idx === 0 ? '' : content[idx - 1];
		const after = content[idx + ident.length] ?? '';
		if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) {
			from = idx + ident.length;
			n--;
			continue;
		}
		if (n === occurrence - 1) {
			let line = 1;
			let col = 1;
			for (let j = 0; j < idx; j++) {
				if (content[j] === '\n') {
					line++;
					col = 1;
				}
				else col++;
			}
			return { line, offset: col };
		}
		from = idx + ident.length;
	}
	throw new Error(`ident ${ident} #${occurrence} not found`);
}

ensureFixture();
const content = fs.readFileSync(fixtureFile, 'utf8');

const sites = [
	{
		id: 'a-var-inline',
		title: '(a) variable QI — inline object type',
		...findIdent(content, 'varInline'),
		note: 'typeToDisplayParts ORs MultilineObjectLiterals',
	},
	{
		id: 'b-param-name',
		title: '(b) parameter name QI — inline object type',
		...findIdent(content, 'param'),
		note: 'parameter symbol; type annotation via typeToDisplayParts',
	},
	{
		id: 'c-type-alias',
		title: '(c) type alias QI — Obj body',
		...findIdent(content, 'Obj'),
		note: 'type alias = multiline body in stock',
	},
	{
		id: 'd-returns',
		title: '(d) function QI — inline object return type',
		...findIdent(content, 'returns'),
		note: 'function signature print (alias-free return type)',
	},
	{
		id: 'b-takes-fn',
		title: '(b′′) function QI — inline object param type',
		...findIdent(content, 'takes'),
		note: 'whole-function signature; nested object in param list',
	},
];

let diffs = 0;
let matches = 0;
const rows = [];

console.log('### F1 whitespace print-shape matrix');
console.log(`fixture=${fixtureFile}`);

for (const site of sites) {
	const pos = {
		file: fixtureFile,
		line: site.line,
		offset: site.offset,
		vue: false,
		projectRoot: fixtureDir,
		content,
		label: site.id,
	};
	try {
		const result = await quickinfoBoth(pos);
		const match = printQiDiff(`matrix :: ${site.title}`, result);
		if (site.note) console.log(`note: ${site.note}`);
		const tnb = result.tnb.displayString ?? '';
		const stock = result.stock.displayString ?? '';
		rows.push({
			id: site.id,
			verdict: match ? 'MATCH' : 'DIFF',
			stockShape: stock.includes('\n') ? 'multiline' : 'single-line',
			tnbShape: tnb.includes('\n') ? 'multiline' : 'single-line',
			stock,
			tnb,
			kindTnb: result.tnb.kind,
			kindStock: result.stock.kind,
		});
		if (match) matches++;
		else diffs++;
	}
	catch (e) {
		console.log(`ERROR ${site.id}: ${e?.stack ?? e}`);
		diffs++;
		rows.push({ id: site.id, verdict: 'ERROR', stockShape: '?', tnbShape: '?' });
	}
}

console.log('\n### MATRIX SUMMARY');
console.log('id\tverdict\tstock\ttnb\tkind');
for (const r of rows) {
	console.log(`${r.id}\t${r.verdict}\t${r.stockShape}\t${r.tnbShape}\t${r.kindStock ?? '?'}`);
}
console.log(`\nTOTAL MATCH=${matches} DIFF=${diffs}`);

const outPath = '/tmp/tnb-f1-ws-matrix.txt';
fs.writeFileSync(
	outPath,
	rows.map(r => {
		const sep = '='.repeat(60);
		return `${sep}\n${r.id} verdict=${r.verdict} stock=${r.stockShape} tnb=${r.tnbShape} kind=${r.kindStock}\n---TNB---\n${r.tnb ?? ''}\n---STOCK---\n${r.stock ?? ''}\n`;
	}).join('\n') + `\nTOTAL MATCH=${matches} DIFF=${diffs}\n`,
);
console.log(`wrote ${outPath}`);
process.exit(diffs > 0 ? 1 : 0);
