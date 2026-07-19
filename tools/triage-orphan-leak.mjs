#!/usr/bin/env node
/**
 * IDE tsserver orphan-leak triage / acceptance.
 *
 * Spawns TNB + stock tsserver in IDE-like form (no TNB_PARENT_PID / harness),
 * forces the tsgo bridge up via a configured-project quickinfo, then asserts:
 *   - SIGTERM → exit within 2s
 *   - IPC disconnect / stdin close → exit within 2s
 *   - no leftover tsserver / tsgo / native-preview children
 *   - process counts for Code Helper|tsserver do not grow across the run
 *
 * Usage: node tools/triage-orphan-leak.mjs
 * Env:
 *   TNB_ORPHAN_TSSERVER  override TNB tsserver.js path
 *   STOCK_TSSERVER_PATH  override stock tsserver.js path (default /tmp/stock-ts-p3/...)
 *   TNB_ORPHAN_ONLY=tnb|stock  run one side only
 */
import { spawn, fork, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const volarRoot = resolveVolarRoot();
const tnbPath = process.env.TNB_ORPHAN_TSSERVER
	?? path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH
	?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const EXIT_MS = 2000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code !== 'ESRCH';
	}
}

function countPs(pattern) {
	try {
		const out = execSync(`ps ax -o pid=,ppid=,command=`, { encoding: 'utf8' });
		return out.split('\n').filter(line => new RegExp(pattern).test(line)).length;
	} catch {
		return 0;
	}
}

function countGoChildren() {
	try {
		const out = execSync(`ps ax -o pid=,command=`, { encoding: 'utf8' });
		return out.split('\n').filter(line => /tsgo|native-preview/.test(line) && !/rg |triage-orphan/.test(line)).length;
	} catch {
		return 0;
	}
}

function parseStdoutFramed(onMsg) {
	let buf = '';
	return chunk => {
		buf += chunk.toString();
		for (;;) {
			const m = buf.match(/^Content-Length:\s*(\d+)\r\n\r\n/);
			if (!m) break;
			const len = Number(m[1]);
			const start = m[0].length;
			if (buf.length < start + len) break;
			const body = buf.slice(start, start + len);
			buf = buf.slice(start + len);
			try {
				onMsg(JSON.parse(body));
			} catch {
				// ignore partial/garbage
			}
		}
	};
}

/**
 * IDE-like env: GODEBUG set so tnb-godebug skips re-exec (re-exec breaks IPC).
 * Deliberately omits TNB_PARENT_PID — that path is harness-only.
 */
function ideEnv(extra = {}) {
	return {
		...process.env,
		...extra,
		GODEBUG: 'asyncpreemptoff=1',
		TNB_GODEBUG_REEXEC: '1',
	};
}

async function withServer({ label, tsserverPath, mode }, fn) {
	const args = ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'];
	const child = mode === 'ipc'
		? fork(tsserverPath, ['--useNodeIpc', ...args], {
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			env: ideEnv(),
			execArgv: [],
		})
		: spawn(process.execPath, [tsserverPath, ...args], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: ideEnv(),
		});

	let stderr = '';
	child.stderr?.on('data', d => {
		stderr += d;
	});
	const responses = new Map();
	if (mode === 'ipc') {
		child.on('message', msg => {
			if (msg?.type === 'response') responses.set(msg.request_seq, msg);
		});
	} else {
		child.stdout.on('data', parseStdoutFramed(msg => {
			if (msg?.type === 'response') responses.set(msg.request_seq, msg);
		}));
	}

	let seq = 0;
	const send = (command, arguments_) => {
		seq++;
		const req = { seq, type: 'request', command, arguments: arguments_ };
		if (mode === 'ipc') child.send(req);
		else child.stdin.write(`${JSON.stringify(req)}\n`);
		return seq;
	};
	const waitSeq = async (n, ms = 120_000) => {
		const t0 = Date.now();
		while (!responses.has(n)) {
			if (!pidAlive(child.pid)) {
				throw new Error(`${label} died early; stderr=${stderr.slice(0, 600)}`);
			}
			if (Date.now() - t0 > ms) {
				throw new Error(`${label} timeout waiting seq=${n}; stderr=${stderr.slice(0, 600)}`);
			}
			await sleep(30);
		}
		return responses.get(n);
	};

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-orphan-leak-'));
	fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext' },
		include: ['*.ts'],
	}));
	const testFile = path.join(tmpDir, 'main.ts');
	fs.writeFileSync(testFile, 'const x: number = 1;\nx;\n');

	const forceKill = async () => {
		if (pidAlive(child.pid)) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {
				// gone
			}
			await sleep(200);
		}
	};

	try {
		await waitSeq(send('configure', { preferences: {} }));
		await waitSeq(send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{
				file: testFile,
				fileContent: fs.readFileSync(testFile, 'utf8'),
				projectRootPath: tmpDir,
			}],
		}));
		// Configured project → createTsgoProgram → koffi bridge load.
		const qi = await waitSeq(send('quickinfo', { file: testFile, line: 1, offset: 7 }));
		const banner = stderr.includes('TNB ACTIVE');
		return await fn({
			child,
			label,
			banner,
			qi,
			stderr,
			send,
			waitSeq,
			forceKill,
		});
	} finally {
		await forceKill();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function assertExitWithin({ child, label, how, ms = EXIT_MS }) {
	const t0 = Date.now();
	if (how === 'SIGTERM') {
		process.kill(child.pid, 'SIGTERM');
	} else if (how === 'disconnect') {
		if (typeof child.disconnect === 'function' && child.channel) child.disconnect();
		else if (child.stdin) child.stdin.end();
		else throw new Error(`${label}: no disconnect/stdin to close`);
	} else {
		throw new Error(`unknown how=${how}`);
	}
	let exited = false;
	while (Date.now() - t0 < ms) {
		if (!pidAlive(child.pid)) {
			exited = true;
			break;
		}
		await sleep(40);
	}
	const elapsed = Date.now() - t0;
	const alive = pidAlive(child.pid);
	const pass = exited && !alive;
	console.log(
		`  ${label} ${how}: within_${ms}ms=${exited} elapsed_ms=${elapsed} alive=${alive} => ${pass ? 'PASS' : 'FAIL'}`,
	);
	if (alive) {
		try {
			console.log(execSync(`ps -p ${child.pid} -o pid=,ppid=,pcpu=,etime=,command=`, { encoding: 'utf8' }).trim());
		} catch {
			// ignore
		}
	}
	return { pass, exited, elapsed, alive, pid: child.pid };
}

const only = process.env.TNB_ORPHAN_ONLY; // tnb | stock | undefined
const results = [];

function record(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
}

console.log(`triage-orphan-leak: repo=${repoRoot}`);
console.log(`  TNB=${tnbPath}`);
console.log(`  STOCK=${stockPath}`);

const beforeHelper = countPs('Code Helper|tsserver');
const beforeGo = countGoChildren();
console.log(`  pre counts: CodeHelper|tsserver=${beforeHelper} tsgo|native-preview=${beforeGo}`);

if (only !== 'stock') {
	console.log('\n--- TNB SIGTERM (stdio) ---');
	await withServer({ label: 'TNB', tsserverPath: tnbPath, mode: 'stdio' }, async ctx => {
		if (!ctx.banner) {
			record('TNB bridge init (banner)', false, 'TNB ACTIVE banner missing — bridge not loaded');
		} else {
			record('TNB bridge init (banner)', true);
		}
		record('TNB quickinfo', !!ctx.qi?.success, `success=${ctx.qi?.success}`);
		const r = await assertExitWithin({ child: ctx.child, label: 'TNB', how: 'SIGTERM' });
		record('TNB SIGTERM ≤2s', r.pass, `ms=${r.elapsed}`);
	});

	console.log('\n--- TNB IPC disconnect ---');
	await withServer({ label: 'TNB', tsserverPath: tnbPath, mode: 'ipc' }, async ctx => {
		const r = await assertExitWithin({ child: ctx.child, label: 'TNB', how: 'disconnect' });
		record('TNB IPC disconnect ≤2s', r.pass, `ms=${r.elapsed}`);
	});

	console.log('\n--- TNB stdin close ---');
	await withServer({ label: 'TNB', tsserverPath: tnbPath, mode: 'stdio' }, async ctx => {
		const r = await assertExitWithin({ child: ctx.child, label: 'TNB', how: 'disconnect' });
		record('TNB stdin close ≤2s', r.pass, `ms=${r.elapsed}`);
	});
}

if (only !== 'tnb') {
	if (!fs.existsSync(stockPath)) {
		record('STOCK path exists', false, stockPath);
	} else {
		console.log('\n--- STOCK SIGTERM (stdio) ---');
		await withServer({ label: 'STOCK', tsserverPath: stockPath, mode: 'stdio' }, async ctx => {
			record('STOCK quickinfo', !!ctx.qi?.success, `success=${ctx.qi?.success}`);
			const r = await assertExitWithin({ child: ctx.child, label: 'STOCK', how: 'SIGTERM' });
			record('STOCK SIGTERM ≤2s', r.pass, `ms=${r.elapsed}`);
		});

		console.log('\n--- STOCK IPC disconnect ---');
		await withServer({ label: 'STOCK', tsserverPath: stockPath, mode: 'ipc' }, async ctx => {
			const r = await assertExitWithin({ child: ctx.child, label: 'STOCK', how: 'disconnect' });
			record('STOCK IPC disconnect ≤2s', r.pass, `ms=${r.elapsed}`);
		});
	}
}

await sleep(500);
const afterHelper = countPs('Code Helper|tsserver');
const afterGo = countGoChildren();
const orphanOk = afterHelper <= beforeHelper;
const goOk = afterGo <= beforeGo;
console.log(`\n--- residue ---`);
console.log(`  CodeHelper|tsserver before=${beforeHelper} after=${afterHelper} => ${orphanOk ? 'PASS' : 'FAIL'}`);
console.log(`  tsgo|native-preview before=${beforeGo} after=${afterGo} => ${goOk ? 'PASS' : 'FAIL'}`);
record('orphan zero growth (Code Helper|tsserver)', orphanOk, `${beforeHelper}→${afterHelper}`);
record('Go child zero growth (tsgo|native-preview)', goOk, `${beforeGo}→${afterGo}`);

const failed = results.filter(r => !r.ok);
console.log('\n=== SUMMARY ===');
for (const r of results) {
	console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}
console.log(failed.length === 0 ? `\nALL PASS (${results.length})` : `\n${failed.length} FAIL / ${results.length} total`);
process.exit(failed.length === 0 ? 0 : 1);
