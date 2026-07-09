/** css.ts: open buffer, type r, delete r — matches user report. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const pluginProbe = path.join(volarRoot, 'packages/language-server');
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');

const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
const server = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
], undefined, env);
let seq = 1;
const send = async (cmd, args, ms = 500) => {
	const res = await server.message({ seq: seq++, type: 'request', command: cmd, arguments: args });
	if (ms) await new Promise(r => setTimeout(r, ms));
	return res;
};
const codes = (res) => (res?.body?.diagnostics ?? res?.body ?? []).map(d => d.code);

await send('configure', {});
await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: 'let bar; ba', projectRootPath: volarRoot }] });
await send('geterr', { files: [testFile], delay: 0 }, 800);
console.log('step1:', codes(await send('semanticDiagnosticsSync', { file: testFile }, 0)));

await send('change', { file: testFile, line: 1, offset: 11, endLine: 1, endOffset: 11, insertString: 'r' });
await send('geterr', { files: [testFile], delay: 0 }, 800);
console.log('step2:', codes(await send('semanticDiagnosticsSync', { file: testFile }, 0)));

await send('change', { file: testFile, line: 1, offset: 12, endLine: 1, endOffset: 13, insertString: '' });
await send('geterr', { files: [testFile], delay: 0 }, 800);
console.log('step3:', codes(await send('semanticDiagnosticsSync', { file: testFile }, 0)));

server.kill?.();
