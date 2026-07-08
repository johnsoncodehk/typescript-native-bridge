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
	const result = spawnSync(process.execPath, process.argv.slice(1), {
		env: { ...process.env, GODEBUG: godebug, TNB_GODEBUG_REEXEC: "1" },
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}

module.exports = { ensureGodebugReexec };

// When loaded via `node -r typescript/lib/tnb-godebug.js`, re-exec before any
// embedder (vitest, vue-tsc) loads the Go bridge.
ensureGodebugReexec();
