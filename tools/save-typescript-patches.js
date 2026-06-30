"use strict";
// Regenerate patches/typescript/{overlay,*.patch} from the submodule working
// tree. Edit files inside typescript/src/compiler/, then run this to version it.
//   node tools/save-typescript-patches.js

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { saveOverlay, savePatch } = require("./patch-common.js");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript");
const patchDir = path.join(repoRoot, "patches", "typescript");

const git = (dir, args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

saveOverlay(subDir, path.join(patchDir, "overlay"));
savePatch(subDir, path.join(patchDir, "0001-tsgo-hooks.patch"), ["scripts/produceLKG.mjs", "src/server/project.ts"]);

// produceLKG.mjs is a separate tracked edit — keep it in its own patch so
// overlay/hook changes can be rebased independently.
const lkgRel = "scripts/produceLKG.mjs";
const lkgDiff = git(subDir, ["diff", "--", lkgRel]);
if (lkgDiff.status !== 0) {
	console.error("save: git diff produceLKG failed\n" + lkgDiff.stderr);
	process.exit(1);
}
const lkgPatch = path.join(patchDir, "0002-lkg-output-to-parent.patch");
fs.writeFileSync(lkgPatch, lkgDiff.stdout);
console.log(`save: patch <- ${lkgDiff.stdout.length} bytes (${path.basename(lkgPatch)})`);

const projectRel = "src/server/project.ts";
const projectDiff = git(subDir, ["diff", "--", projectRel]);
if (projectDiff.status !== 0) {
	console.error("save: git diff project.ts failed\n" + projectDiff.stderr);
	process.exit(1);
}
const projectPatch = path.join(patchDir, "0003-tsgo-tsserver-scriptinfo.patch");
fs.writeFileSync(projectPatch, projectDiff.stdout);
console.log(`save: patch <- ${projectDiff.stdout.length} bytes (${path.basename(projectPatch)})`);
