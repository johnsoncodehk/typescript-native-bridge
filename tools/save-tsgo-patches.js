"use strict";
// Regenerate patches/typescript-go/{overlay,*.patch} from the submodule working
// tree. Edit files inside typescript-go/, then run this to version the delta.
//   node tools/save-tsgo-patches.js

const path = require("path");
const { saveOverlay, savePatch } = require("./patch-common.js");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript-go");
const patchDir = path.join(repoRoot, "patches", "typescript-go");

const git = (args) => spawnSync("git", ["-C", subDir, ...args], { encoding: "utf8" });

saveOverlay(subDir, path.join(patchDir, "overlay"));
savePatch(subDir, path.join(patchDir, "0001-bridge-inplace.patch"), ["_packages/native-preview/tsconfig.json"]);

const outDirRel = "_packages/native-preview/tsconfig.json";
const outDirDiff = git(["diff", "--", outDirRel]);
if (outDirDiff.status !== 0) {
	console.error("save: git diff native-preview tsconfig failed\n" + outDirDiff.stderr);
	process.exit(1);
}
const outDirPatch = path.join(patchDir, "0003-native-preview-outdir.patch");
require("fs").writeFileSync(outDirPatch, outDirDiff.stdout);
console.log(`save: patch <- ${outDirDiff.stdout.length} bytes (${path.basename(outDirPatch)})`);
