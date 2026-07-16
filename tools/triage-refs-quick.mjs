#!/usr/bin/env node
// Minimal references probe after v7.0.2 upgrade: two tmp files, TNB only,
// dump the raw response/error for the `references` command.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const tnbPath = path.join(import.meta.dirname, '../lib/tsserver.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-refsq-'));
const tmpA = path.join(tmpRoot, 'a.ts');
const tmpB = path.join(tmpRoot, 'b.ts');
fs.writeFileSync(tmpA, 'export interface MyProps { foo: string }\n');
fs.writeFileSync(tmpB, "import { type MyProps } from './a';\nexport const x: MyProps = { foo: 'a' };\n");
fs.writeFileSync(path.join(tmpRoot, 'tsconfig.json'), JSON.stringify({ files: ['a.ts', 'b.ts'] }, null, 2));

await withTsserver({ tsserverPath: tnbPath, args: ['--disableAutomaticTypingAcquisition'], env: tnbHarnessEnv(), deadlineMs: 90_000 }, async ({ send }) => {
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [
		{ file: tmpA, projectRootPath: tmpRoot },
		{ file: tmpB, projectRootPath: tmpRoot },
	] });
	const qi = await send('quickinfo', { file: tmpA, line: 1, offset: 18 }, 30_000);
	console.log('quickinfo:', JSON.stringify({ success: qi?.success, str: qi?.body?.displayString }));
	const r = await send('references', { file: tmpA, line: 1, offset: 18 }, 30_000);
	console.log('references:', JSON.stringify(r, null, 2)?.slice(0, 2000));
});
