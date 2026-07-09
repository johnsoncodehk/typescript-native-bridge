/** After tsserver updateOpen: inspect SourceFile type + getContextualType hang */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const ts = require(path.resolve('lib/typescript.js'));
const volarRoot = resolveVolarRoot();
const harnessEntry = path.join(volarRoot, 'packages/language-server/node_modules/@typescript/server-harness/dist/index.js');
const { launchServer } = await import(pathToFileURL(harnessEntry).href);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-tss-'));
const testFile = path.join(tmpDir, 'app.ts');
const content = 'const foo = 1;\nfoo.\n';
const dotPos = content.indexOf('foo.') + 4;
fs.writeFileSync(testFile, content);
fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));

const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
const server = launchServer(
	path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js'),
	['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'],
	undefined,
	env,
);
let seq = 1;
const send = (command, args) => server.message({ seq: seq++, type: 'request', command, arguments: args });
await send('configure', {});
await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: testFile, fileContent: content, projectRootPath: tmpDir }] });

// Use compiler API on same process after tsserver warmed up - can't easily.
// Instead: completionInfo with short timeout + rpc trace
console.log('dotPos', dotPos, 'char', JSON.stringify(content[dotPos - 1]));
const t0 = Date.now();
try {
	const comp = await Promise.race([
		send('completions', { file: testFile, position: dotPos }),
		new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
	]);
	const body = comp.body?.entries ?? comp.body ?? [];
	console.log(`completions: ${Date.now() - t0}ms entries=${Array.isArray(body) ? body.length : 'n/a'}`);
} catch (e) {
	console.log(`completions: ${Date.now() - t0}ms ${e.message}`);
}
server.kill?.();
fs.rmSync(tmpDir, { recursive: true, force: true });
