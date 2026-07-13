#!/usr/bin/env node
// Triage: quickinfo empty-result parity — positions where stock returns
// success=false ("No content available.") but TNB historically returned
// success=true. Sweep-fixture witnesses: comment interiors, template-literal
// interiors, import-keyword column-1 tokens.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const aPath = '/tmp/tnb-sweep-fixtures/a.ts';
const bPath = '/tmp/tnb-sweep-fixtures/b.tsx';
const positions = [
	{ file: aPath, line: 27, offset: 35 },
	{ file: aPath, line: 67, offset: 38 },
	{ file: aPath, line: 67, offset: 43 },
	{ file: aPath, line: 75, offset: 10 },
	{ file: aPath, line: 75, offset: 16 },
	{ file: aPath, line: 75, offset: 25 },
	{ file: aPath, line: 75, offset: 33 },
	{ file: bPath, line: 2, offset: 1 },
	{ file: bPath, line: 3, offset: 1 },
	{ file: bPath, line: 4, offset: 1 },
	{ file: bPath, line: 45, offset: 80 },
	{ file: bPath, line: 45, offset: 85 },
];

async function run(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env }, async ({ send }) => {
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [
				{ file: aPath, fileContent: fs.readFileSync(aPath, 'utf8'), projectRootPath: '/tmp/tnb-sweep-fixtures' },
				{ file: bPath, fileContent: fs.readFileSync(bPath, 'utf8'), projectRootPath: '/tmp/tnb-sweep-fixtures' },
			],
		});
		const out = [];
		for (const pos of positions) {
			let r;
			try { r = await send('quickinfo', pos, 30_000); } catch (e) { r = { success: false, message: String(e?.message ?? e) }; }
			out.push({ pos, success: !!r?.success, display: r?.body?.displayString ?? null });
		}
		return out;
	});
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = await run('STOCK', stockPath, process.env);
let diff = 0;
for (let i = 0; i < positions.length; i++) {
	const p = positions[i];
	const match = tnb[i].success === stock[i].success && tnb[i].display === stock[i].display;
	if (!match) diff++;
	console.log(`${path.basename(p.file)}:${p.line}:${p.offset} ${match ? 'MATCH' : 'DIFF'} tnb=${tnb[i].success}/${JSON.stringify(tnb[i].display)} stock=${stock[i].success}/${JSON.stringify(stock[i].display)}`);
}
console.log(`\npositions=${positions.length} diff=${diff}`);
console.log(`verdict: ${diff === 0 ? 'PARITY' : 'DIFF'}`);
process.exit(diff === 0 ? 0 : 1);
