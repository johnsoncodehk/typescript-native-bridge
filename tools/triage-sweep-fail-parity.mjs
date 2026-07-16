#!/usr/bin/env node
// Spot-check sweep failures against stock: for every failure recorded in
// /tmp/tnb-sweep-failures.json (quickinfo/signatureHelp/completionInfo),
// replay the same request on stock tsserver with the same fixtures and
// count positions where stock succeeds but TNB failed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withTsserver } from './tsserver-harness.mjs';

const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
const FIXTURE_ROOT = '/tmp/tnb-sweep-fixtures';
const failures = JSON.parse(fs.readFileSync('/tmp/tnb-sweep-failures.json', 'utf8'))
	.filter(f => f.command !== 'implementation');

const files = {};
for (const base of ['a.ts', 'b.tsx']) {
	files[base] = fs.readFileSync(path.join(FIXTURE_ROOT, base), 'utf8');
}

let same = 0;
let stockOk = 0;
const diffs = [];
await withTsserver({ tsserverPath: stockPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env: process.env, deadlineMs: 600_000 }, async ({ send }) => {
	await send('configure', { preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } });
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: Object.keys(files).map(base => ({ file: path.join(FIXTURE_ROOT, base), fileContent: files[base], projectRootPath: FIXTURE_ROOT })) });
	for (const f of failures) {
		const args = { file: path.join(FIXTURE_ROOT, f.file), line: f.line, offset: f.col };
		let r;
		try { r = await send(f.command, args, 30_000); } catch (e) { r = { success: false, message: String(e) }; }
		if (r?.success) { stockOk++; diffs.push({ ...f, stockMsg: 'SUCCESS' }); }
		else same++;
	}
});
console.log(`replayed=${failures.length} bothFail=${same} stockOnlyOk=${stockOk}`);
fs.writeFileSync('/tmp/tnb-sweep-fail-parity.json', JSON.stringify(diffs, null, 1));
if (diffs.length) console.log('sample stock-only-ok:', JSON.stringify(diffs.slice(0, 8), null, 1));
