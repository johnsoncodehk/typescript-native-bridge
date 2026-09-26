"use strict";
// Regenerate patches/typescript-go/{overlay,*.patch} from the submodule working
// tree. Edit files inside typescript-go/, then run this to version the delta.
//   node tools/save-tsgo-patches.js

const path = require("path");
const { saveOverlay, savePatch } = require("./patch-common.js");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript-go");
const patchDir = path.join(repoRoot, "patches", "typescript-go");

// Files carved out of 0001 into their own focused patch (each rebases
// independently).
const osvfsRel = "internal/vfs/osvfs/os.go";
const apiSurfaceRel = [
	"internal/api/proto.go",
	"internal/api/session.go",
	"_packages/native-preview/src/api/async/api.ts",
	"_packages/native-preview/src/api/sync/api.ts",
	"_packages/native-preview/test/sync/api.test.ts",
];
const noembedRel = "internal/bundled/noembed.go";

saveOverlay(subDir, path.join(patchDir, "overlay"));
const carved = [osvfsRel, ...apiSurfaceRel, noembedRel];
savePatch(subDir, path.join(patchDir, "0001-bridge-inplace.patch"), [".", ...carved.map(rel => `:(exclude)${rel}`)]);
savePatch(subDir, path.join(patchDir, "0002-osvfs-executable-fallback.patch"), [osvfsRel]);
savePatch(subDir, path.join(patchDir, "0004-api-surface.patch"), apiSurfaceRel);
savePatch(subDir, path.join(patchDir, "0005-noembed-lib-path.patch"), [noembedRel]);
