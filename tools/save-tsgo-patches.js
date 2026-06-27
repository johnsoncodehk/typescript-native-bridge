"use strict";
// Regenerate patches/typescript-go/*.patch from the current working-tree diff of
// the typescript-go submodule. Mirrors golar's save-tsgo-patches.ts.
//
// Workflow: edit files inside typescript-go/ (e.g. bridge.go), then run this to
// refresh the patch files. Single-patch setup: the whole diff is written to
// 0001-Add-cgo-bridge.patch. To split into multiple patches later, extend this.
//
//   node tools/save-tsgo-patches.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript-go");
const patchDir = path.join(repoRoot, "patches", "typescript-go");

fs.mkdirSync(patchDir, { recursive: true });

// diff against the pinned submodule HEAD (clean upstream commit) so the patch
// captures exactly the additive delta (poc-napi/ + any tsgo edits).
const diff = spawnSync("git", ["-C", subDir, "diff"], { encoding: "utf8", maxBuffer: 1 << 28 });
if (diff.status !== 0) {
	console.error("save-patches: git diff failed\n" + diff.stderr);
	process.exit(1);
}

const outPath = path.join(patchDir, "0001-Add-cgo-bridge.patch");
fs.writeFileSync(outPath, diff.stdout);
if (diff.stdout.trim().length === 0) {
	console.log("save-patches: working tree clean — wrote empty patch to", outPath);
} else {
	console.log(`save-patches: wrote ${diff.stdout.length} bytes to ${path.relative(repoRoot, outPath)}`);
}
