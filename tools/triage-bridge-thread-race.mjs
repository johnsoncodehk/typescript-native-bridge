// triage-bridge-thread-race.mjs — exit-coded probe for the BridgeCall result
// buffer race under worker_threads (ESLint --concurrency loads the addon into
// N workers of one process; each worker owns a session but text responses
// shared one Go-global resultBuf).
//
//   node tools/triage-bridge-thread-race.mjs [path/to/bridge.node]
//
// Each worker hammers BridgeCall with unknown methods of thread-tagged,
// length-varying names; the error message must echo the caller's own method
// name. A foreign tag or garbled message = cross-thread buffer corruption;
// the length churn also forces realloc/free of the shared buffer, so the
// pre-fix binary typically dies with 0xC0000005 instead of finishing.
//
// Beyond the race, three loud-error contracts are pinned:
//   - cross-thread session misuse must throw on ALL paths (call, setArena,
//     callArena) — a silent undefined on the arena paths leaves JS decoding a
//     stale arena buffer
//   - a session a worker created and never disposed is disposed when the
//     worker's env finalizes; calling its dead id must throw loudly instead of
//     silently decoding (finalize_instance's BridgeDisposeSession sweep)
// Exit 0 = clean, 1 = corruption/loud-error violation observed, else = crash.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, threadId, workerData, parentPort } from "node:worker_threads";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Every require(bridge.node) site hands the lib dir to Go right after —
// idempotent across threads, and the only channel workers can receive
// (issue #37).
const libDir = path.join(repoRoot, "lib");

const WORKERS = 6;
const ITERS = 5000;

if (isMainThread) {
	const bridgePath = process.argv[2]
		? path.resolve(process.argv[2])
		: path.join(repoRoot, "native", "bridge.node");
	const results = await Promise.all(
		Array.from({ length: WORKERS }, () =>
			new Promise((resolve, reject) => {
				const w = new Worker(fileURLToPath(import.meta.url), { workerData: { bridgePath, mode: "race" } });
				w.on("message", resolve);
				w.on("error", reject);
				w.on("exit", (code) => code !== 0 && reject(new Error(`worker exit ${code}`)));
			}),
		),
	);
	const bad = results.reduce((n, r) => n + r.corrupt, 0);
	const total = WORKERS * ITERS;
	console.log(`bridge-thread-race: ${total} calls across ${WORKERS} workers, ${bad} corrupted`);
	for (const r of results.filter((r) => r.sample)) console.log(`  worker sample: ${r.sample}`);

	// Affinity guard: a session created here must not be callable from a
	// worker — the answer must be the loud guard error on every path, never
	// torn data or a silent undefined (a silent arena path would leave the
	// caller decoding a stale arena buffer).
	const addon = require(bridgePath);
	addon.setLibPath(libDir);
	const foreignSession = addon.newSession(process.cwd());
	const misuse = await new Promise((resolve, reject) => {
		const w = new Worker(fileURLToPath(import.meta.url), { workerData: { bridgePath, mode: "misuse", foreignSession } });
		w.on("message", resolve);
		w.on("error", reject);
		w.on("exit", (code) => code !== 0 && reject(new Error(`misuse worker exit ${code}`)));
	});
	addon.disposeSession(BigInt(foreignSession));
	console.log(`bridge-thread-race: cross-thread misuse -> call=${misuse.call}, setArena=${misuse.setArena}, callArena=${misuse.callArena}`);
	const misuseOk =
		misuse.call.includes("different thread") &&
		misuse.setArena.includes("different thread") &&
		misuse.callArena.includes("different thread");
	if (!misuseOk) console.log("  expected the affinity guard error ('session belongs to a different thread') on all three paths");

	// Env-teardown disposal: a session a worker created and never explicitly
	// disposed is disposed when the worker's env finalizes; the dead id must
	// then fail loudly as an unknown session instead of silently decoding a
	// stale arena (finalize_instance's BridgeDisposeSession sweep).
	const abandoned = await new Promise((resolve, reject) => {
		let info = null;
		const w = new Worker(fileURLToPath(import.meta.url), { workerData: { bridgePath, mode: "abandon" } });
		w.on("message", (m) => { info = m; });
		w.on("error", reject);
		w.on("exit", (code) => {
			if (code !== 0) return reject(new Error(`abandon worker exit ${code}`));
			if (!info) return reject(new Error("abandon worker exited without reporting its session"));
			resolve(info);
		});
	});
	let abandonedMsg = "";
	try {
		addon.callArena(BigInt(abandoned.session), "getTypeAtLocation");
	} catch (err) {
		abandonedMsg = String(err.message ?? err);
	}
	console.log(`bridge-thread-race: abandoned session call -> ${abandonedMsg || "no throw (silent undefined)"}`);
	const abandonedOk = abandonedMsg.includes("invalid session");
	if (!abandonedOk) console.log("  expected a loud 'invalid session handle' (the worker env's finalize should have disposed it)");
	process.exit(bad === 0 && misuseOk && abandonedOk ? 0 : 1);
} else if (workerData.mode === "misuse") {
	const addon = require(workerData.bridgePath);
	addon.setLibPath(libDir);
	const sess = BigInt(workerData.foreignSession);
	const misuse = { call: "", setArena: "", callArena: "" };
	try {
		addon.call(sess, "ping", null);
		misuse.call = "no-throw";
	} catch (err) {
		misuse.call = String(err.message ?? err);
	}
	try {
		addon.setArena(sess, Buffer.alloc(4 * 1024 * 1024));
		misuse.setArena = "no-throw";
	} catch (err) {
		misuse.setArena = String(err.message ?? err);
	}
	try {
		addon.callArena(sess, "getTypeAtLocation");
		misuse.callArena = "no-throw";
	} catch (err) {
		misuse.callArena = String(err.message ?? err);
	}
	parentPort.postMessage(misuse);
} else if (workerData.mode === "abandon") {
	const addon = require(workerData.bridgePath);
	addon.setLibPath(libDir);
	// Deliberately NOT disposed: env teardown (finalize) must dispose the
	// session and release its arena ref.
	const session = addon.newSession(process.cwd());
	addon.setArena(session, Buffer.alloc(4 * 1024 * 1024));
	parentPort.postMessage({ session });
} else {
	const addon = require(workerData.bridgePath);
	addon.setLibPath(libDir);
	const session = addon.newSession(process.cwd());
	const tag = `nosuchmethod_t${threadId}`;
	let corrupt = 0;
	let sample = "";
	for (let i = 0; i < ITERS; i++) {
		const method = `${tag}_${"x".repeat(i % 480)}`;
		let message = "";
		try {
			addon.call(BigInt(session), method, null);
		} catch (err) {
			message = String(err.message ?? err);
		}
		if (!message.includes(tag)) {
			corrupt++;
			if (!sample) sample = `sent ${method.length}-char ${tag}, got: ${message.slice(0, 160)}`;
		}
	}
	addon.disposeSession(BigInt(session));
	parentPort.postMessage({ corrupt, sample });
}
