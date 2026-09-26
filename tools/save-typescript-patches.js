"use strict";
// Regenerate patches/typescript/{overlay,*.patch} from the submodule working
// tree. Edit files inside typescript/src/compiler/, then run this to version it.
//   node tools/save-typescript-patches.js

const path = require("path");
const { saveOverlay, savePatch } = require("./patch-common.js");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript");
const patchDir = path.join(repoRoot, "patches", "typescript");

// Separate tracked edits, each in its own patch so overlay/hook changes can be
// rebased independently.
const lkgRel = "scripts/produceLKG.mjs";
const projectRel = "src/server/project.ts";

saveOverlay(subDir, path.join(patchDir, "overlay"));
savePatch(subDir, path.join(patchDir, "0001-tsgo-hooks.patch"), [".", `:(exclude)${lkgRel}`, `:(exclude)${projectRel}`]);
savePatch(subDir, path.join(patchDir, "0002-lkg-output-to-parent.patch"), [lkgRel]);
savePatch(subDir, path.join(patchDir, "0003-tsgo-tsserver-scriptinfo.patch"), [projectRel]);
