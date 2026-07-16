#!/usr/bin/env node
// Repro for `implementation` → "Cannot read properties of undefined (reading 'kind')"
// found by sweep-ls-throws after the v7.0.2 upgrade. Reuses the sweep fixtures.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const tnbPath = path.join(import.meta.dirname, '../lib/tsserver.js');
const FIXTURE_ROOT = '/tmp/tnb-impl-kind';
fs.mkdirSync(FIXTURE_ROOT, { recursive: true });

// Mirror sweep fixture line 1 (import statement) — sweep hit failures at a.ts:1.
const aTs = path.join(FIXTURE_ROOT, 'a.ts');
const content = "// sweep fixture a.ts — broad TypeScript surface for LS throw discovery\nexport const n = 1;\n";
fs.writeFileSync(aTs, content);
fs.writeFileSync(path.join(FIXTURE_ROOT, 'tsconfig.json'), '{"files":["a.ts"]}');

const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';
for (const [label, tsserverPath, env] of [['TNB', tnbPath, tnbHarnessEnv()], ['STOCK', stockPath, process.env]]) {
	if (label === 'STOCK' && !fs.existsSync(stockPath)) { console.log('STOCK missing, skip'); continue; }
	await withTsserver({ tsserverPath, args: ['--disableAutomaticTypingAcquisition'], env, deadlineMs: 90_000 }, async ({ send }) => {
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: aTs, fileContent: content, projectRootPath: FIXTURE_ROOT }] });
		for (const offset of [4, 27]) {
			const r = await send('implementation', { file: aTs, line: 1, offset }, 30_000);
			console.log(`${label} offset=${offset} success=${r?.success} msg=${(r?.message ?? '').split('\n')[0]}`);
		}
	});
}
