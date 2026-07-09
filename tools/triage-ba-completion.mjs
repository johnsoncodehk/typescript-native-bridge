/** Repro: let bar; ba| identifier completion */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-ba-'));
const testFile = path.join(tmpDir, 'app.ts');
const content = 'let bar;\nba|\n';
const offset = content.indexOf('|');
const body = content.slice(0, offset) + content.slice(offset + 1);
fs.writeFileSync(testFile, body);
fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));

const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
const server = launchServer(tsserverPath, ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], undefined, env);
let seq = 1;
const send = async (command, args, timeoutMs = 20_000) => {
	const t0 = Date.now();
	try {
		const res = await Promise.race([
			server.message({ seq: seq++, type: 'request', command, arguments: args }),
			new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
		]);
		console.log(`${command}: ${Date.now() - t0}ms ok=${res.success}`);
		return res;
	} catch (e) {
		console.log(`${command}: ${Date.now() - t0}ms ${e.message}`);
		return undefined;
	}
};

await send('configure', {});
await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: body, projectRootPath: tmpDir }] });
const comp = await send('completions', { file: testFile, position: offset });
const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
const names = entries.map(e => e.name);
console.log(`entries=${names.length} hasBar=${names.includes('bar')} sample=${JSON.stringify(names.slice(0, 10))}`);
server.kill?.();
fs.rmSync(tmpDir, { recursive: true, force: true });
