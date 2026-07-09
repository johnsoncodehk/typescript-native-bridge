/** Plain .ts tsserver completions — correct body parsing (body IS the entry array). */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };

function entryNames(body) {
	const entries = Array.isArray(body) ? body : body?.entries ?? [];
	return entries.map(e => e.name);
}

async function probe(label, content, marker) {
	const file = path.join(volarRoot, 'test-workspace/tsconfigProject/plain.ts');
	const offset = content.indexOf(marker);
	const body = content.slice(0, offset) + content.slice(offset + marker.length);
	const server = launchServer(tsserverPath, ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], undefined, env);
	let seq = 1;
	const send = async (command, arguments_, timeoutMs = 45_000) => {
		const t0 = Date.now();
		try {
			const res = await Promise.race([
				server.message({ seq: seq++, type: 'request', command, arguments: arguments_ }),
				new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
			]);
			return { ms: Date.now() - t0, res };
		} catch (e) {
			return { ms: Date.now() - t0, error: e.message };
		}
	};
	const cfg = await send('configure', {});
	if (!cfg.res?.success) { console.log(label, 'configure failed', cfg); server.kill?.(); return; }
	await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file, fileContent: body }] });
	const out = await send('completions', { file, position: offset });
	const names = entryNames(out.res?.body);
	console.log(`${label}: ${out.ms}ms ${out.error ?? `entries=${names.length}`} sample=${JSON.stringify(names.slice(0, 8))} hasFoo=${names.includes('foo')}`);
	server.kill?.();
}

await probe('identifier fo|', 'const foo = 1;\nfo|\n', '|');
await probe('member foo.|', 'const foo = 1;\nfoo.|\n', '|');
