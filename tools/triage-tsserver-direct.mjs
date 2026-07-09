/** Spawn tsserver directly; capture stderr during completions. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveVolarRoot } from './volar-root.mjs';

const volarRoot = resolveVolarRoot();
const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-direct-'));
const testFile = path.join(tmpDir, 'app.ts');
fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
const content = 'const foo = 1;\nfoo.\n';
const dotOffset = content.indexOf('foo.') + 4;

const env = {
	...process.env,
	GODEBUG: 'asyncpreemptoff=1',
	TNB_GODEBUG_REEXEC: '1',
	TNB_RPC_TRACE: '1',
	TSGO_PROFILE: '1',
};

const child = spawn(process.execPath, [tsserverPath, '--disableAutomaticTypingAcquisition'], {
	env,
	stdio: ['pipe', 'pipe', 'pipe'],
});

child.stderr.on('data', (buf) => process.stderr.write(`[stderr] ${buf}`));
child.stdout.on('data', (buf) => {
	const s = buf.toString();
	if (s.includes('"type":"event"') || s.includes('"type":"response"')) {
		process.stdout.write(`[stdout] ${s.slice(0, 500)}\n`);
	}
});

let seq = 0;
function send(command, args) {
	seq++;
	const msg = JSON.stringify({ seq, type: 'request', command, arguments: args });
	const payload = `Content-Length: ${Buffer.byteLength(msg, 'utf8')}\r\n\r\n${msg}`;
	child.stdin.write(payload);
}

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

send('configure', {});
await wait(500);
send('updateOpen', {
	changedFiles: [],
	closedFiles: [],
	openFiles: [{ file: testFile, fileContent: content, projectRootPath: tmpDir }],
});
await wait(1000);
console.log('--- sending completions ---');
send('completions', { file: testFile, position: dotOffset });
await wait(20000);
console.log('--- done waiting ---');
child.kill();
fs.rmSync(tmpDir, { recursive: true, force: true });
