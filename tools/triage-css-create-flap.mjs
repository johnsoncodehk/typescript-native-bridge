#!/usr/bin/env node
/**
 * Flap probe: within one TNB tsserver session, request css.ts EOF completions
 * N times and report per-run presence of the local `create` entry and the
 * count of auto-import `create`/`process` entries.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;
const line = content.split('\n').length;
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const rounds = Number(process.argv[2] ?? 6);

await withTsserver({ tsserverPath: tnbPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env: tnbHarnessEnv() }, async ({ send }) => {
	await send('configure', { preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } });
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }] });
	for (let i = 0; i < rounds; i++) {
		const res = await send('completionInfo', { file: testFile, offset, line, prefix: '' });
		const entries = res?.body?.entries ?? [];
		const localCreate = entries.some(e => e.name === 'create' && !e.source);
		const autoCreate = entries.filter(e => e.name === 'create' && e.source).length;
		const autoProcess = entries.filter(e => e.name === 'process' && e.source).length;
		const auto = entries.filter(e => e.source).length;
		const local = entries.filter(e => !e.source && !e.data).length;
		console.log(`round=${i + 1} total=${entries.length} auto=${auto} local=${local} localCreate=${localCreate} autoCreate=${autoCreate} autoProcess=${autoProcess}`);
	}
});
