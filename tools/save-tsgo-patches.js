"use strict";
// Regenerate patches/typescript-go/{overlay,*.patch} from the submodule working
// tree. Edit files inside typescript-go/, then run this to version the delta.
//   node tools/save-tsgo-patches.js

const path = require("path");
const { saveOverlay, savePatch } = require("./patch-common.js");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript-go");
const patchDir = path.join(repoRoot, "patches", "typescript-go");

saveOverlay(subDir, path.join(patchDir, "overlay"));
savePatch(subDir, path.join(patchDir, "0001-bridge-inplace.patch"));
