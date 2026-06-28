"use strict";
// Regenerate patches/typescript/{overlay,*.patch} from the submodule working
// tree. Edit files inside typescript/src/compiler/, then run this to version it.
//   node tools/save-typescript-patches.js

const path = require("path");
const { saveOverlay, savePatch } = require("./patch-common.js");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript");
const patchDir = path.join(repoRoot, "patches", "typescript");

saveOverlay(subDir, path.join(patchDir, "overlay"));
savePatch(subDir, path.join(patchDir, "0001-tsgo-hooks.patch"));
