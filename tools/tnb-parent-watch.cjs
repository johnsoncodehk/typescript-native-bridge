"use strict";
// Parent-watch: tsserver child exits when the harness parent dies.
// Loaded via `node --require tools/tnb-parent-watch.cjs` (works for stock and
// TNB tsserver alike). Reads TNB_PARENT_PID; polls with signal 0 every 2s and
// exits 0 on ESRCH. No-op when TNB_PARENT_PID is unset (IDE-managed tsserver).

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

module.exports = { startParentWatch };

startParentWatch();
