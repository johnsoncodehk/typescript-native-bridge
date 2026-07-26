// triage-worker-libpath.mjs — exit-coded probe for issue #37: booting the
// bridge from a worker_thread must not depend on any env handoff.
//
//   node tools/triage-worker-libpath.mjs
//
// worker_threads never propagate process.env writes to the environ Go reads
// (Node has no worker setenv — setenv is not thread-safe), so the old
// TNB_LIB_PATH handoff was structurally dead there: bundled.LibPath() fell
// back to the node binary's directory, found no lib.d.ts, and panicked
// across the NAPI boundary — a Go panic cannot unwind through cgo, so the
// process died SIGABRT (134). The NAPI handoff (setLibPath, called by the
// loader right after require) is the only channel that reaches Go from
// every thread.
//
// Shape: a worker requires lib/typescript.js fresh (workers get their own
// module registry) and type-checks a tiny tsconfig project — the issue's
// repro, configFilePath included (without it the fork takes the JS-checker
// path and never loads the bridge). The main thread then does the same.
// Both run with TNB_LIB_PATH deleted, so only the NAPI handoff can locate
// the bundled lib. Exit 0 = both threads type-checked; pre-fix the process
// dies SIGABRT inside the worker's first newSession.

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

// The knob is gone — a stray inherited value must not mask a regression.
delete process.env.TNB_LIB_PATH;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsPath = path.join(repoRoot, "lib", "typescript.js");

function typeCheckInThisThread() {
	const require = createRequire(import.meta.url);
	const ts = require(tsPath);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnb-worker-libpath-"));
	// Promise only exists in lib.es2015+: a clean check proves the bundled lib
	// was found (a lib-less session errors instead of producing a program).
	fs.writeFileSync(path.join(dir, "index.ts"), "export const p: Promise<number> = Promise.resolve(1);\n");
	const configPath = path.join(dir, "tsconfig.json");
	fs.writeFileSync(configPath, JSON.stringify({
		compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true },
		include: ["index.ts"],
	}));

	// Issue #37's repro shape: the parsed options carry configFilePath, which
	// is what routes createProgram onto the tsgo NAPI backend.
	const parsed = ts.getParsedCommandLineOfConfigFile(
		configPath,
		{ noEmit: true },
		{ ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} },
	);
	const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
	const diags = program.getSemanticDiagnostics();
	if (diags.length) {
		throw new Error(`unexpected diagnostics: ${diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ")}`);
	}
	// Sweep guard: the loader must not resurrect the env knob.
	if ("TNB_LIB_PATH" in process.env) throw new Error("TNB_LIB_PATH reappeared — the env handoff is back");
}

if (isMainThread) {
	// Worker FIRST: pre-fix, a main-thread bridge boot would write the env var
	// through the main thread's setenv and mask the worker failure.
	await new Promise((resolve, reject) => {
		const w = new Worker(fileURLToPath(import.meta.url));
		w.on("message", resolve);
		w.on("error", reject);
		w.on("exit", (code) => code !== 0 && reject(new Error(`worker exit ${code}`)));
	});
	console.log("worker: type-checked clean (bundled lib found, no env handoff)");
	typeCheckInThisThread();
	console.log("main:   type-checked clean (bundled lib found, no env handoff)");
	console.log("VERDICT: PASS");
} else {
	typeCheckInThisThread();
	parentPort.postMessage("ok");
}
