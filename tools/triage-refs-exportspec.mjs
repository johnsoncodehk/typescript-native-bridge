#!/usr/bin/env node
// Triage: references/rename/documentHighlights on an imported re-exported class
// (b.tsx `new GenericClass(...)` → a.ts `export { GenericClass }`) — TNB vs stock.
// Regression witness for the getReferencesAtExportSpecifier Debug.checkDefined crash.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const aPath = '/tmp/tnb-sweep-fixtures/a.ts';
const bPath = '/tmp/tnb-sweep-fixtures/b.tsx';
const loc = { file: bPath, line: 20, offset: 18 };
const commands = ['implementation', 'references', 'rename', 'documentHighlights'];

async function run(label, tsserverPath, env) {
	return withTsserver({ tsserverPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env }, async ({ send }) => {
		await send('updateOpen', {
			changedFiles: [], closedFiles: [],
			openFiles: [
				{ file: aPath, fileContent: fs.readFileSync(aPath, 'utf8'), projectRootPath: '/tmp/tnb-sweep-fixtures' },
				{ file: bPath, fileContent: fs.readFileSync(bPath, 'utf8'), projectRootPath: '/tmp/tnb-sweep-fixtures' },
			],
		});
		const out = {};
		for (const cmd of commands) {
			const args = cmd === 'rename' ? { ...loc, findInStrings: false, findInComments: false }
				: cmd === 'documentHighlights' ? { ...loc, filesToSearch: [aPath, bPath] }
				: loc;
			let r;
			try { r = await send(cmd, args, 30_000); } catch (e) { r = { success: false, message: String(e?.message ?? e) }; }
			out[cmd] = { success: !!r?.success, message: r?.success ? '' : String(r?.message ?? '').split('\n')[0] };
			console.log(`[${label}] ${cmd}: success=${out[cmd].success} ${out[cmd].message}`);
		}
		return out;
	});
}

const tnb = await run('TNB', tnbPath, tnbHarnessEnv());
const stock = await run('STOCK', stockPath, process.env);
const parity = commands.every(c => tnb[c].success === stock[c].success);
console.log(`\nverdict: ${parity ? 'PARITY' : 'DIFF'}`);
process.exit(parity ? 0 : 1);
