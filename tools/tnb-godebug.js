"use strict";
// Go reads GODEBUG when the runtime starts (process spawn / re-exec).
// Setting process.env in JS before require("bridge.node") is too late for parsedebugvars.

function ensureGodebugReexec() {
	if (process.env.TNB_SKIP_ASYNC_PREEMPT_OFF === "1") return;
	if (process.env.TNB_GODEBUG_REEXEC === "1") return;
	if (/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(process.env.GODEBUG ?? "")) return;

	const godebug = process.env.GODEBUG
		? `${process.env.GODEBUG},asyncpreemptoff=1`
		: "asyncpreemptoff=1";
	const env = { ...process.env, GODEBUG: godebug, TNB_GODEBUG_REEXEC: "1" };
	// Preserve execArgv (e.g. --require tnb-parent-watch.cjs) across the re-exec;
	// process.argv does not include it.
	const argv = [...process.execArgv, ...process.argv.slice(1)];
	const { spawnSync } = require("node:child_process");
	const stdio = ["inherit", "inherit", "inherit"];
	// node-ipc channel (VS Code --useNodeIpc): our bootstrap consumed
	// NODE_CHANNEL_FD when it wired process.send, so a plain stdio:"inherit"
	// re-exec would come up without ipc and die on the first response with
	// "process.send is not a function". Map the live channel fd into the child
	// at the same index and re-advertise it. (process.execve is NOT safe here:
	// the adopted channel fd is close-on-exec, so the replaced image would see
	// fd 3 recycled as something else and silently write ipc frames into it.)
	const channelFd = typeof process.channel?.fd === "number" ? process.channel.fd : -1;
	if (channelFd >= 3) {
		while (stdio.length < channelFd) stdio.push("ignore");
		stdio[channelFd] = channelFd;
		env.NODE_CHANNEL_FD = String(channelFd);
	}
	const result = spawnSync(process.execPath, argv, { env, stdio });
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
	timer.unref();
}

module.exports = { ensureGodebugReexec, startParentWatch };

// When loaded via `node -r typescript/lib/tnb-godebug.js`, re-exec before any
// embedder (vitest, vue-tsc) loads the Go bridge.
ensureGodebugReexec();
startParentWatch();
