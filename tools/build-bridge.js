"use strict";
// Build the cgo bridge into <repo>/native/bridge.<ext>
//   node tools/build-bridge.js

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const bridgeDir = path.join(repoRoot, "typescript-go", "bridge");
const nativeDir = path.join(repoRoot, "native");
// GOOS (when set, cross-compile) decides the artifact extension; otherwise the host.
const goos = process.env.GOOS || (process.platform === "win32" ? "windows" : process.platform);
const ext = goos === "darwin" ? "dylib" : goos === "windows" ? "dll" : "so";
const outPath = path.join(nativeDir, `bridge.${ext}`);

fs.mkdirSync(nativeDir, { recursive: true });

const args = ["build", "-tags=noembed", "-buildmode=c-shared"];
// TNB_STRIP=1: drop debug symbols for shipped binaries (release matrix).
if (process.env.TNB_STRIP === "1") args.push("-ldflags=-s -w");
args.push("-o", outPath, "bridge.go");

const r = spawnSync("go", args, { cwd: bridgeDir, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`build-bridge: ${outPath}`);
