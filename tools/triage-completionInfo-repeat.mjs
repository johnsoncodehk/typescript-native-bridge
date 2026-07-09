/** Same-session completionInfo x3 — export map cache hit test. */
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
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length;

const server = launchServer(tsserverPath, [
	'--disableAutomaticTypingAcquisition',
	'--globalPlugins', '@vue/typescript-plugin',
	'--pluginProbeLocations', pluginProbe,
	'--suppressDiagnosticEvents',
	'--logVerbosity', 'verbose',
], undefined, { ...process.env, GODEBUG: 'asyncpreemptoff=1' });

let seq = 1;
async function send(command, args) {
	const t0 = Date.now();
	const res = await server.message({ seq: seq++, type: 'request', command, arguments: args });
	console.log(`${command}: ${Date.now() - t0}ms ok=${res.success}`);
	return res;
}

await send('configure', { preferences: { includeCompletionsForModuleExports: true } });
await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }] });
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);
const args = { file: testFile, line, offset: col, includeExternalModuleExports: true };
for (let i = 1; i <= 3; i++) {
	console.log(`--- completionInfo #${i}`);
	await send('completionInfo', args);
}
server.kill?.();
