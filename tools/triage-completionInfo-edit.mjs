/**
 * completionInfo before/after a simulated edit — export map cache invalidation test.
 *
 * Sequence: open → completionInfo (cold, populates export map cache) →
 * completionInfo (warm, cache hit) → `change` request appending a comment at
 * EOF (keystroke simulation; marks the project dirty → next request runs
 * updateGraph and rebuilds the thin program) → completionInfo x2.
 *
 * With structureIsReused stubbed to Not, updateGraph clears the export map
 * cache and the post-edit completionInfo is slow (~cold time) again. With
 * structureIsReused reported as SafeModules for the content-only change, the
 * post-edit completionInfo should stay near the warm time.
 */
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
	const entries = res?.body?.entries;
	const autoImports = entries?.filter(e => e.hasAction && e.source).length;
	const detail = entries ? ` entries=${entries.length} autoImport=${autoImports}` : '';
	console.log(`${command}: ${Date.now() - t0}ms ok=${res.success ?? '(no response expected)'}${res.success === false ? ` msg=${res.message}` : ''}${detail}`);
	return res;
}

await send('configure', { preferences: { includeCompletionsForModuleExports: true } });
await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }] });
const line = content.slice(0, offset).split('\n').length;
const col = offset - content.lastIndexOf('\n', offset - 1);
const args = { file: testFile, line, offset: col, includeExternalModuleExports: true };

console.log('--- completionInfo #1 (cold)');
await send('completionInfo', args);
console.log('--- completionInfo #2 (warm, no edit)');
await send('completionInfo', args);

// Simulate a keystroke: append a comment at EOF (after the completion point,
// so line/offset stay valid). Content-only change — same file set.
console.log('--- change (simulated keystroke at EOF)');
await send('change', { file: testFile, line, offset: col, endLine: line, endOffset: col, insertString: ' ' });

console.log('--- completionInfo #3 (after edit)');
await send('completionInfo', { ...args, offset: col + 1 });
console.log('--- completionInfo #4 (after edit, repeat)');
await send('completionInfo', { ...args, offset: col + 1 });

// Second keystroke to confirm steady-state behavior.
console.log('--- change (second keystroke)');
await send('change', { file: testFile, line, offset: col + 1, endLine: line, endOffset: col + 1, insertString: ' ' });
console.log('--- completionInfo #5 (after second edit)');
await send('completionInfo', { ...args, offset: col + 2 });

server.kill?.();
