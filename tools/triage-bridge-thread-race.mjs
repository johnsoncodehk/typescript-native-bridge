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
// Exit 0 = clean, 1 = corruption observed, anything else = crash.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, threadId, workerData, parentPort } from "node:worker_threads";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.TNB_LIB_PATH ??= path.join(repoRoot, "lib");

const WORKERS = 6;
const ITERS = 5000;

if (isMainThread) {
	const bridgePath = process.argv[2]
		? path.resolve(process.argv[2])
		: path.join(repoRoot, "native", "bridge.node");
	const results = await Promise.all(
		Array.from({ length: WORKERS }, () =>
			new Promise((resolve, reject) => {
				const w = new Worker(fileURLToPath(import.meta.url), { workerData: { bridgePath } });
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
	process.exit(bad === 0 ? 0 : 1);
} else {
	const addon = require(workerData.bridgePath);
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
