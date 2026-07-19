"use strict";
// Apply the TypeScript customization delta onto the pinned upstream submodule.
//   node tools/patch-typescript.js          # apply
//   node tools/patch-typescript.js --check  # verify only, no writes
//
// Delta (see tools/patch-common.js for the convention):
//   patches/typescript/overlay/   net-new files (src/compiler/tsgo*.ts)
//   patches/typescript/*.patch    in-place hooks (program/parser/_namespaces)

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { applyOverlay, applyPatchFiles } = require("./patch-common.js");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript");
const patchDir = path.join(repoRoot, "patches", "typescript");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(path.join(subDir, ".git"))) {
	console.error("patch-typescript: typescript submodule not present. Run `git submodule update --init` first.");
	process.exit(1);
}

if (!checkOnly) {
	const result = spawnSync(process.execPath, [path.join(__dirname, "sync-vendor-native-preview.js")], { stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

applyOverlay(subDir, path.join(patchDir, "overlay"), checkOnly);
applyPatchFiles(subDir, patchDir, checkOnly);
