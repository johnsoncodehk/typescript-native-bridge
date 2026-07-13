"use strict";
// Build the cgo bridge into <repo>/native/bridge.<ext>
//   node tools/build-bridge.js

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const bridgeDir = path.join(repoRoot, "typescript-go", "bridge");
const nativeDir = path.join(repoRoot, "native");
const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
const outPath = path.join(nativeDir, `bridge.${ext}`);

fs.mkdirSync(nativeDir, { recursive: true });

const r = spawnSync(
	"go",
	["build", "-tags=noembed", "-buildmode=c-shared", "-o", outPath, "bridge.go"],
	{ cwd: bridgeDir, stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`build-bridge: ${outPath}`);
