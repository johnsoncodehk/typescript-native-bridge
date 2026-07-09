/** Repro: ba error clears after bar→ba revert (stale overlay sync). */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-diag-revert-'));
const testFile = path.join(tmpDir, 'test.ts');
fs.writeFileSync(testFile, 'let bar;\nbar\n'); // disk: valid
fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['**/*'] }, null, 2));

const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
const server = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
], undefined, env);

let seq = 1;
const send = async (command, args, timeoutMs = 45_000) => {
	const res = await Promise.race([
		server.message({ seq: seq++, type: 'request', command, arguments: args }),
		new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
	]);
	return res;
};

const diagCodes = (res) => (res?.body?.diagnostics ?? res?.body ?? []).map(d => d.code ?? d.text?.match(/\((\d+)\)/)?.[1]);

const contentA = 'let bar;\nba';
const contentB = 'let bar;\nbar';

await send('configure', {});
await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: contentA, projectRootPath: tmpDir }] });
const d1 = await send('semanticDiagnosticsSync', { file: testFile, includeLinePosition: false });
console.log('step1 ba:', diagCodes(d1), 'has2304=', diagCodes(d1).includes(2304) || diagCodes(d1).includes('2304'));

await send('change', { file: testFile, line: 2, offset: 1, endLine: 2, endOffset: 3, insertString: 'bar' });
await send('geterr', { files: [testFile], delay: 0 });
const d2 = await send('semanticDiagnosticsSync', { file: testFile, includeLinePosition: false });
console.log('step2 bar:', diagCodes(d2), 'has2304=', diagCodes(d2).includes(2304) || diagCodes(d2).includes('2304'));

await send('change', { file: testFile, line: 2, offset: 1, endLine: 2, endOffset: 4, insertString: 'ba' });
await send('geterr', { files: [testFile], delay: 0 });
const d3 = await send('semanticDiagnosticsSync', { file: testFile, includeLinePosition: false });
console.log('step3 ba again:', diagCodes(d3), 'has2304=', diagCodes(d3).includes(2304) || diagCodes(d3).includes('2304'));

server.kill?.();
fs.rmSync(tmpDir, { recursive: true, force: true });
