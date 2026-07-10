/**
 * Safe wrapper around Volar @typescript/server-harness launchServer.
 *
 * Defense layers:
 *  1. Parent-watch: every spawned tsserver gets TNB_PARENT_PID + a --require'd
 *     watcher (tools/tnb-parent-watch.cjs) that exits when this process dies —
 *     even via SIGKILL. Spawning without a parent PID is refused.
 *  2. Repo-level file lock (.tnb-harness.lock): max 1 concurrent harness
 *     process. Stale locks (dead holder) are reclaimed; otherwise fail fast.
 *     There is deliberately NO bypass and NO queue.
 *  3. try/finally kill, process exit/signal hooks, and a hard deadline that
 *     calls process.exit(124) when promises never settle.
 *
 * Usage:
 *   import { withTsserver, tnbHarnessEnv } from './tsserver-harness.mjs';
 *   await withTsserver({ tsserverPath, args: [...] }, async ({ send, server }) => { ... });
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');
const parentWatchPath = path.join(toolsDir, 'tnb-parent-watch.cjs');
const lockPath = path.join(repoRoot, '.tnb-harness.lock');

const live = new Set();
let ownsLock = false;

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: exists but owned by another user — treat as alive.
		return err?.code !== 'ESRCH';
	}
}

function readLockHolder() {
	try {
		return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Acquire the repo-wide harness lock (max 1 concurrent harness process).
 * Reentrant within this process. Fails fast when another live process holds
 * it — no queue, no force bypass.
 */
function acquireHarnessLock() {
	if (ownsLock) return;
	const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			fs.writeFileSync(lockPath, payload, { flag: 'wx' });
			ownsLock = true;
			return;
		} catch (err) {
			if (err?.code !== 'EEXIST') throw err;
			const holder = readLockHolder();
			if (holder?.pid === process.pid) {
				ownsLock = true;
				return;
			}
			if (!holder || !Number.isInteger(holder.pid) || !pidAlive(holder.pid)) {
				// Stale lock (unreadable or dead holder): reclaim and retry.
				try {
					fs.rmSync(lockPath, { force: true });
				} catch {
					// ignore; retry loop will surface persistent failures
				}
				continue;
			}
			throw new Error(
				`Refusing to spawn tsserver: harness lock ${lockPath} held by live pid ${holder.pid} ` +
					`(since ${holder.startedAt ?? 'unknown'}). Only 1 concurrent harness is allowed; ` +
					'wait for it to finish or kill it first.',
			);
		}
	}
	throw new Error(`Failed to acquire harness lock ${lockPath} after reclaiming stale locks.`);
}

function releaseHarnessLock() {
	if (!ownsLock) return;
	ownsLock = false;
	try {
		const holder = readLockHolder();
		if (holder?.pid === process.pid) fs.rmSync(lockPath, { force: true });
	} catch {
		// ignore
	}
}

function killServer(server) {
	if (!server) return;
	try {
		const result = server.kill?.();
		if (result?.catch) result.catch(() => {});
	} catch {
		// ignore
	}
}

function killAllLive() {
	for (const server of live) killServer(server);
	releaseHarnessLock();
}

if (!globalThis.__tnbTsserverHarnessHooksInstalled) {
	globalThis.__tnbTsserverHarnessHooksInstalled = true;
	process.on('exit', killAllLive);
	for (const sig of ['SIGINT', 'SIGTERM']) {
		process.on(sig, () => {
			killAllLive();
			process.exit(1);
		});
	}
}

/**
 * Default env for TNB harness runs (prevents tnb-godebug re-exec orphan) and
 * parent-watch (tsserver exits when this process dies). TNB_PARENT_PID is
 * always forced to this process — it must not be overridden.
 */
export function tnbHarnessEnv(extra = {}) {
	const godebug = process.env.GODEBUG ?? '';
	const mergedGodebug = /(?:^|,)asyncpreemptoff=1(?:,|$)/.test(godebug)
		? godebug
		: (godebug ? `${godebug},asyncpreemptoff=1` : 'asyncpreemptoff=1');
	return {
		...process.env,
		...extra,
		GODEBUG: mergedGodebug,
		TNB_GODEBUG_REEXEC: '1',
		TNB_PARENT_PID: String(process.pid),
	};
}

let launchServerLoader;

/** @returns {import('@typescript/server-harness').launchServer} */
export async function resolveLaunchServer(volarRoot = resolveVolarRoot()) {
	if (!launchServerLoader) {
		const harnessEntry = path.join(
			volarRoot,
			'packages/language-server/node_modules/@typescript/server-harness/dist/index.js',
		);
		const mod = await import(pathToFileURL(harnessEntry).href);
		launchServerLoader = mod.launchServer;
	}
	return launchServerLoader;
}

/**
 * @param {{
 *   tsserverPath: string;
 *   args?: string[];
 *   env?: Record<string, string | undefined>;
 *   deadlineMs?: number;
 *   volarRoot?: string;
 *   onEvent?: (event: unknown) => void;
 * }} options
 * @param {(ctx: {
 *   send: (command: string, arguments_?: object, timeoutMs?: number) => Promise<unknown>;
 *   server: ReturnType<Awaited<ReturnType<typeof resolveLaunchServer>>>;
 * }) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withTsserver(options, fn) {
	const {
		tsserverPath,
		args = [],
		env = {},
		deadlineMs = 180_000,
		volarRoot = resolveVolarRoot(),
		onEvent,
	} = options;

	acquireHarnessLock();

	const childEnv = tnbHarnessEnv(env);
	if (!childEnv.TNB_PARENT_PID) {
		throw new Error('Refusing to spawn tsserver without TNB_PARENT_PID (parent-watch).');
	}
	if (!fs.existsSync(parentWatchPath)) {
		throw new Error(`Refusing to spawn tsserver: missing parent-watch module ${parentWatchPath}`);
	}
	const execArgv = [...process.execArgv, '--require', parentWatchPath];

	const launchServer = await resolveLaunchServer(volarRoot);
	const server = launchServer(tsserverPath, args, execArgv, childEnv);
	live.add(server);

	if (onEvent) server.on?.('event', onEvent);

	const watchdog = setTimeout(() => {
		killServer(server);
		process.exit(124);
	}, deadlineMs);

	let seq = 1;
	const send = (command, arguments_, timeoutMs = 60_000) => Promise.race([
		server.message({ seq: seq++, type: 'request', command, arguments: arguments_ }),
		new Promise((_, reject) => {
			setTimeout(() => reject(new Error(`${command} timeout after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);

	try {
		return await fn({ send, server });
	} finally {
		clearTimeout(watchdog);
		killServer(server);
		live.delete(server);
	}
}
