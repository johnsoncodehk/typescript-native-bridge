#!/usr/bin/env node
/**
 * Acceptance test for the tsserver parent-watch (kill -9 orphan defense).
 *
 * Parent mode (default):
 *   1. spawns this script with --child (a real withTsserver harness run),
 *   2. reads harness + tsserver pids from the child's stdout,
 *   3. SIGKILLs the harness parent,
 *   4. polls up to 10s until the tsserver child is gone.
 *
 * Child mode (--child): opens a tiny inferred project through withTsserver,
 * prints pids, then idles so the parent can kill -9 it mid-session.
 *
 * Usage: node tools/triage-parent-watch-acceptance.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(selfPath), '..');

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code !== 'ESRCH';
	}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

if (process.argv.includes('--child')) {
	const { withTsserver } = await import('./tsserver-harness.mjs');
	const volarRoot = resolveVolarRoot();
	const tsserverPath = path.join(volarRoot, 'node_modules/typescript/lib/tsserver.js');

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-parent-watch-'));
	const testFile = path.join(tmpDir, 'main.ts');
	fs.writeFileSync(testFile, 'const answer: number = 42;\n');

	await withTsserver({
		tsserverPath,
		args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'],
	}, async ({ send, server }) => {
		await send('configure', { preferences: {} });
		await send('updateOpen', {
			changedFiles: [],
			closedFiles: [],
			openFiles: [{ file: testFile, fileContent: fs.readFileSync(testFile, 'utf8'), projectRootPath: tmpDir }],
		});
		console.log(`CHILD_READY harness=${process.pid} tsserver=${server.pid}`);
		// Idle: parent will SIGKILL us here. If it doesn't, exit cleanly.
		await sleep(60_000);
	});
	process.exit(0);
}

console.log('parent-watch acceptance: spawning harness child...');
const child = spawn(process.execPath, [selfPath, '--child'], {
	cwd: repoRoot,
	stdio: ['ignore', 'pipe', 'inherit'],
});

const pids = await new Promise((resolve, reject) => {
	let buf = '';
	const timeout = setTimeout(() => {
		child.kill('SIGKILL');
		reject(new Error('child never reached CHILD_READY within 120s'));
	}, 120_000);
	child.stdout.on('data', chunk => {
		buf += chunk;
		process.stdout.write(chunk);
		const m = buf.match(/CHILD_READY harness=(\d+) tsserver=(\d+)/);
		if (m) {
			clearTimeout(timeout);
			resolve({ harness: Number(m[1]), tsserver: Number(m[2]) });
		}
	});
	child.on('exit', code => {
		clearTimeout(timeout);
		reject(new Error(`child exited early (code ${code}) before CHILD_READY`));
	});
});

console.log(`kill -9 harness parent ${pids.harness}...`);
process.kill(pids.harness, 'SIGKILL');

let tsserverGone = false;
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
	if (!pidAlive(pids.tsserver)) {
		tsserverGone = true;
		break;
	}
	await sleep(250);
}

if (!tsserverGone) {
	console.error(`FAIL: tsserver ${pids.tsserver} still alive 10s after harness parent was SIGKILL'd`);
	try {
		process.kill(pids.tsserver, 'SIGKILL');
		console.error('(cleaned up leaked tsserver with SIGKILL)');
	} catch {
		// already gone or unkillable
	}
	process.exit(1);
}

// The SIGKILL'd child could not release the harness lock; verify stale-lock
// cleanup semantics and tidy up.
const lockPath = path.join(repoRoot, '.tnb-harness.lock');
if (fs.existsSync(lockPath)) {
	try {
		const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
		if (Number.isInteger(holder?.pid) && pidAlive(holder.pid)) {
			console.error(`FAIL: harness lock still held by live pid ${holder.pid}`);
			process.exit(1);
		}
	} catch {
		// unreadable lock counts as stale
	}
	fs.rmSync(lockPath, { force: true });
	console.log('stale harness lock removed (holder dead, as expected)');
}

console.log(`PASS: tsserver ${pids.tsserver} exited after harness parent kill -9`);
