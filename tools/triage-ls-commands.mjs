/** Compare tsserver LS commands: which hang under TNB? */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-ls-'));
const testFile = path.join(tmpDir, 'app.ts');
fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
const content = 'const foo = 1;\nconst bar = foo;\nfoo.\n';
const dotOffset = content.indexOf('foo.') + 4;
const fooOffset = content.indexOf('foo');

const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
const server = launchServer(tsserverPath, ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], undefined, env);
let seq = 1;
async function send(command, args, timeoutMs = 15_000) {
	const t0 = Date.now();
	try {
		const res = await Promise.race([
			server.message({ seq: seq++, type: 'request', command, arguments: args }),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
		]);
		console.log(`${command}: ${Date.now() - t0}ms ok=${res.success} body=${JSON.stringify(res.body)?.slice(0, 120)}`);
		return res;
	} catch (e) {
		console.log(`${command}: ${Date.now() - t0}ms ${e.message}`);
		return undefined;
	}
}

await send('configure', {});
await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: content, projectRootPath: tmpDir }] });
await send('geterr', { delay: 0, files: [{ file: testFile }] });
await send('quickinfo', { file: testFile, position: fooOffset });
await send('definition', { file: testFile, position: fooOffset });
await send('documentHighlights', { file: testFile, position: fooOffset, filesToSearch: [testFile] });
await send('completions', { file: testFile, position: dotOffset });
await send('completionInfo', { file: testFile, position: dotOffset });
server.kill?.();
fs.rmSync(tmpDir, { recursive: true, force: true });
