"use strict";
// Apply the typescript-go customization delta onto the pinned upstream submodule.
//   node tools/patch-tsgo.js          # apply
//   node tools/patch-tsgo.js --check  # verify only, no writes
//
// Delta (see tools/patch-common.js for the convention):
//   patches/typescript-go/overlay/   net-new files (bridge/ cgo bridge)
//   patches/typescript-go/*.patch    in-place edits to existing tsgo files

const path = require("path");
const fs = require("fs");
const { applyOverlay, applyPatchFiles } = require("./patch-common.js");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript-go");
const patchDir = path.join(repoRoot, "patches", "typescript-go");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(path.join(subDir, ".git"))) {
	console.error("patch-tsgo: typescript-go submodule not present. Run `git submodule update --init` first.");
	process.exit(1);
}

applyOverlay(subDir, path.join(patchDir, "overlay"), checkOnly);
applyPatchFiles(subDir, patchDir, checkOnly);
