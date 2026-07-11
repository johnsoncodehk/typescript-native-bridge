#!/usr/bin/env node
/**
 * Dump the multiset of auto-import entries (name@source) for css.ts EOF to a
 * file, for cross-session/side diffing.
 *
 * Usage: node tools/triage-css-auto-dump.mjs [--stock] --out /tmp/x.txt
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const args = process.argv.slice(2);
const useStock = args.includes('--stock');
const outPath = args[args.indexOf('--out') + 1];

const volarRoot = resolveVolarRoot();
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.split('\n').length;
const tsserverPath = useStock ? '/tmp/stock-ts-p3/package/lib/tsserver.js' : path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const env = useStock ? process.env : tnbHarnessEnv();

const res = await withTsserver({ tsserverPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env }, async ({ send }) => {
	await send('configure', { preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } });
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }] });
	return send('completionInfo', { file: testFile, offset, line, prefix: '' });
});
const entries = (res?.body?.entries ?? []).filter(e => e.source);
const lines = entries.map(e => `${e.name}@${e.source}`).sort();
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`${useStock ? 'stock' : 'tnb'} auto=${lines.length} written=${outPath}`);
