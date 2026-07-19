"use strict";
// Build the cgo bridge (NAPI addon) into <repo>/native/bridge.node
//   node tools/build-bridge.js
//
// Node headers come from the running Node's include dir (override with
// NODE_INCLUDE); NAPI is ABI-stable, so any recent Node 24 headers work for
// every target, including cross builds. Windows targets additionally need
// the import library for the host process's napi_* symbols — pass it via
// TNB_NODE_LIB (release workflow downloads node.lib per arch).

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const bridgeDir = path.join(repoRoot, "typescript-go", "bridge");
const nativeDir = path.join(repoRoot, "native");
const outPath = path.join(nativeDir, "bridge.node");

const nodeInclude =
	process.env.NODE_INCLUDE ??
	path.join(path.dirname(process.execPath), "..", "include", "node");
if (!fs.existsSync(path.join(nodeInclude, "node_api.h"))) {
	console.error(`build-bridge: node_api.h not found under ${nodeInclude} (set NODE_INCLUDE)`);
	process.exit(1);
}

fs.mkdirSync(nativeDir, { recursive: true });

const args = ["build", "-tags=noembed", "-buildmode=c-shared"];
// TNB_STRIP=1: drop debug symbols for shipped binaries (release matrix).
if (process.env.TNB_STRIP === "1") args.push("-ldflags=-s -w");
// Build the package (not just bridge.go) so platform-split files
// (killself_unix.go / killself_windows.go) and the NAPI shim are included.
args.push("-o", outPath, ".");

const env = { ...process.env };
env.CGO_CFLAGS = `${env.CGO_CFLAGS ?? ""} -I${nodeInclude}`.trim();
// napi_* symbols resolve from the host process at dlopen time; on macOS the
// linker must be told to allow undefined symbols (Linux allows them in shared
// libraries by default; Windows links node.lib instead — see TNB_NODE_LIB).
const goos = process.env.GOOS || process.platform;
if (goos === "darwin") {
	env.CGO_LDFLAGS = `${env.CGO_LDFLAGS ?? ""} -Wl,-undefined,dynamic_lookup`.trim();
}
if (process.env.TNB_NODE_LIB) {
	env.CGO_LDFLAGS = `${env.CGO_LDFLAGS ?? ""} "${process.env.TNB_NODE_LIB}"`.trim();
}

const r = spawnSync("go", args, { cwd: bridgeDir, stdio: "inherit", env });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`build-bridge: ${outPath}`);
