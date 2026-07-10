"use strict";
// Go reads GODEBUG when the runtime starts (process spawn / re-exec).
// Setting process.env in JS before koffi.load is too late for parsedebugvars.

function ensureGodebugReexec() {
	if (process.env.TNB_SKIP_ASYNC_PREEMPT_OFF === "1") return;
	if (process.env.TNB_GODEBUG_REEXEC === "1") return;
	if (/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(process.env.GODEBUG ?? "")) return;

	const { spawnSync } = require("node:child_process");
	const godebug = process.env.GODEBUG
		? `${process.env.GODEBUG},asyncpreemptoff=1`
		: "asyncpreemptoff=1";
	// Preserve execArgv (e.g. --require tnb-parent-watch.cjs) across the re-exec;
	// process.argv does not include it.
	const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
		env: { ...process.env, GODEBUG: godebug, TNB_GODEBUG_REEXEC: "1" },
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}

// Parent-watch: exit when the original harness caller (TNB_PARENT_PID) dies.
// The env var survives the GODEBUG re-exec, so the final child always watches
// the original caller, not the re-exec intermediate. Same global guard as
// tools/tnb-parent-watch.cjs so double-loading starts a single timer.
function startParentWatch() {
	if (globalThis.__tnbParentWatchStarted) return;
	const pid = Number(process.env.TNB_PARENT_PID);
	if (!Number.isInteger(pid) || pid <= 0) return;
	globalThis.__tnbParentWatchStarted = true;
	const timer = setInterval(() => {
		try {
			process.kill(pid, 0);
		} catch (err) {
			// EPERM means the pid exists but belongs to another user — still alive.
			if (err && err.code === "ESRCH") process.exit(0);
		}
	}, 2000);
	if (typeof timer.unref === "function") timer.unref();
}

module.exports = { ensureGodebugReexec, startParentWatch };

// When loaded via `node -r typescript/lib/tnb-godebug.js`, re-exec before any
// embedder (vitest, vue-tsc) loads the Go bridge.
ensureGodebugReexec();
startParentWatch();
