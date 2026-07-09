/** Repro completions at exact volar css.ts path */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const testFile = path.join(volarRoot, 'packages/language-service/lib/plugins/css.ts');
const content = fs.readFileSync(testFile, 'utf8');
const offset = content.length; // cursor after "ba"
const projectRoot = path.join(volarRoot, 'packages/language-service');

const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
const server = launchServer(tsserverPath, ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], undefined, env);
let seq = 1;
const send = async (command, args, timeoutMs = 45_000) => {
	const t0 = Date.now();
	try {
		const res = await Promise.race([
			server.message({ seq: seq++, type: 'request', command, arguments: args }),
			new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
		]);
		console.log(`${command}: ${Date.now() - t0}ms ok=${res.success} msg=${(res.message ?? '').slice(0, 80)}`);
		return res;
	} catch (e) {
		console.log(`${command}: ${Date.now() - t0}ms ${e.message}`);
		return undefined;
	}
};

await send('configure', {});
for (const args of [
	{ openFiles: [{ file: testFile, projectRootPath: volarRoot }] },
	{ openFiles: [{ file: testFile, projectRootPath: projectRoot }] },
	{ openFiles: [{ file: testFile, fileContent: content, projectRootPath: volarRoot }] },
	{ openFiles: [{ file: testFile, fileContent: content, projectRootPath: projectRoot }] },
]) {
	console.log('--- updateOpen', JSON.stringify(args));
	const uo = await send('updateOpen', { changedFiles: [], closedFiles: [], ...args });
	if (!uo?.success) continue;
	const comp = await send('completions', { file: testFile, position: offset });
	const entries = Array.isArray(comp?.body) ? comp.body : comp?.body?.entries ?? [];
	const names = entries.map(e => e.name);
	console.log(`offset=${offset} entries=${names.length} hasBar=${names.includes('bar')} sample=${JSON.stringify(names.slice(0, 8))}`);
}
server.kill?.();
