#!/usr/bin/env node
/**
 * Ghost auto-import entries from a closed tab (volar "Foo" flake).
 *
 * A file opened with in-memory content joins the tsgo session as an API-open
 * extra program root (updateAPIRootFiles) with its overlay content. The JS
 * side historically sent only openFiles — never closeFiles — and the Go
 * session's OpenFiles handling is additive-only (ref-counted, session.go), so
 * a closed tab stayed an extra root forever: its exports kept surfacing in
 * includeCompletionsForModuleExports completions until some unrelated program
 * change flushed them. In the volar suite (shared tsserver across specs) a
 * renaming spec opening test-workspace/tsconfigProject/foo.vue — absent on
 * disk — leaked a "Foo" suggestion into a later completions spec whenever the
 * spec order put the opener first.
 *
 * Repro shape: open ghost.ts (absent on disk) exporting Foo, complete in
 * main.ts (Foo must appear — the open-tab export is legitimate), close
 * ghost.ts, open another file in the project to force a snapshot refresh
 * (mirrors the volar flow opening empty.vue), complete again (Foo must be
 * gone). Stock tsserver is the control: it never adopts a disk-absent tab
 * into the configured project, so its closed state is clean by construction.
 *
 * Usage: node tools/triage-ghost-close.mjs
 * Env:
 *   TNB_GHOST_TSSERVER   override TNB tsserver.js path (default <repo>/lib/tsserver.js)
 *   STOCK_TSSERVER_PATH  override stock tsserver.js path (default /tmp/stock-ts-p3/...);
 *                        stock side is skipped when the file is missing
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tnbPath = process.env.TNB_GHOST_TSSERVER ?? path.join(repoRoot, 'lib', 'tsserver.js');
const stockPath = process.env.STOCK_TSSERVER_PATH ?? '/tmp/stock-ts-p3/package/lib/tsserver.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-ghost-close-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ include: ['**/*'] }));
fs.writeFileSync(path.join(dir, 'main.ts'), '');
fs.writeFileSync(path.join(dir, 'other.ts'), '');
const main = path.join(dir, 'main.ts');
const ghost = path.join(dir, 'ghost.ts'); // deliberately absent on disk
const other = path.join(dir, 'other.ts');

/** tsserver answers Content-Length framed; requests go in as ndjson. */
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
			try { onMsg(JSON.parse(body)); } catch { /* partial/garbage */ }
		}
	};
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code !== 'ESRCH';
	}
}

async function withServer(label, tsserverPath, fn) {
	// GODEBUG at spawn so tnb-godebug skips the re-exec (it would detach stdin).
	const child = spawn(process.execPath, [tsserverPath, '--disableAutomaticTypingAcquisition'], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, GODEBUG: 'asyncpreemptoff=1', TNB_GODEBUG_REEXEC: '1' },
	});
	let stderr = '';
	child.stderr.on('data', d => { stderr += d; });
	const responses = new Map();
	child.stdout.on('data', parseStdoutFramed(msg => {
		if (msg?.type === 'response') responses.set(msg.request_seq, msg);
	}));
	let seq = 0;
	const send = async (command, arguments_, ms = 120_000) => {
		const n = ++seq;
		child.stdin.write(`${JSON.stringify({ seq: n, type: 'request', command, arguments: arguments_ })}\n`);
		const t0 = Date.now();
		while (!responses.has(n)) {
			if (!pidAlive(child.pid)) throw new Error(`${label} died early; stderr=${stderr.slice(0, 600)}`);
			if (Date.now() - t0 > ms) throw new Error(`${label} timeout on ${command}; stderr=${stderr.slice(0, 600)}`);
			await new Promise(r => setTimeout(r, 5));
		}
		return responses.get(n);
	};
	try {
		return await fn(send);
	} finally {
		child.kill('SIGKILL');
	}
}

async function fooEntries(send) {
	const res = await send('completionInfo', {
		file: main, line: 1, offset: 3,
		includeExternalModuleExports: true, includeInsertTextCompletions: true,
	});
	return (res.body?.entries ?? []).filter(e => e.name === 'Foo').map(e => `${e.name} from ${e.source}`);
}

async function runSide(label, tsserverPath, { expectWhileOpen }) {
	return withServer(label, tsserverPath, async send => {
		const failures = [];
		await send('configure', { preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [
			{ file: main, fileContent: 'Fo' },
			{ file: ghost, fileContent: 'export const Foo = 1;\n' },
		] });
		const whileOpen = await fooEntries(send);
		if (expectWhileOpen && whileOpen.length === 0) {
			failures.push(`${label} whileOpen: open-tab export missing from completions (over-close?)`);
		}
		// Close the ghost tab, then open another project file — the refresh
		// trigger that mirrors the volar flow (empty.vue opening after the
		// renaming spec closed foo.vue).
		await send('updateOpen', { changedFiles: [], closedFiles: [ghost], openFiles: [] });
		await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [{ file: other, fileContent: 'const x = 1;' }] });
		const afterReopen = await fooEntries(send);
		if (afterReopen.length) {
			failures.push(`${label} after close+refresh: ghost entries ${JSON.stringify(afterReopen)} — closed tab still an API-open root`);
		}
		await send('updateOpen', { changedFiles: [], closedFiles: [other], openFiles: [] });
		const afterAll = await fooEntries(send);
		if (afterAll.length) {
			failures.push(`${label} after closeOther: ghost entries ${JSON.stringify(afterAll)}`);
		}
		return failures;
	});
}

const failures = [];
failures.push(...await runSide('TNB', tnbPath, { expectWhileOpen: true }));
if (fs.existsSync(stockPath)) {
	failures.push(...await runSide('stock', stockPath, { expectWhileOpen: false }));
}

if (failures.length) {
	console.error('FAIL');
	for (const f of failures) console.error('  ' + f);
	process.exit(1);
}
console.log('ok closed tab no longer leaks auto-import exports (open-tab export still offered while open)');
