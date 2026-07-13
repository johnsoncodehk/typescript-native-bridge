#!/usr/bin/env node
/** TNB tsserver + TSGO_TRACE_SYM: trace symbol resolution for ''.toString gtd. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const volarRoot = resolveVolarRoot();
const tnbPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-tostring-trace-'));
const file = path.join(dir, 'a.ts');
const content = `''.toString;\n`;
fs.writeFileSync(file, content);
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));

const traceFile = '/tmp/tnb-tostring-trace-out.txt';
try { fs.unlinkSync(traceFile); } catch {}

await withTsserver({
	tsserverPath: tnbPath,
	args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'],
	env: tnbHarnessEnv({ TSGO_TRACE_SYM: '1', TSGO_TRACE_SYM_FILE: traceFile }),
}, async ({ send }) => {
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: content, projectRootPath: dir }] });
	const def = await send('definition-full', { file, line: 1, offset: 5 });
	console.log('definition-full body:', JSON.stringify(def?.body ?? def?.message)?.slice(0, 500));
});

if (fs.existsSync(traceFile)) {
	const lines = fs.readFileSync(traceFile, 'utf8').split('\n').filter(l => /toString|getSymbolAtLocation|remapSymbolDeclarations/.test(l));
	console.log(`\ntrace lines (${lines.length}):`);
	for (const l of lines.slice(-40)) console.log(l);
} else {
	console.log('no trace file written');
}
