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

// Files carved out of 0001 into their own focused patch (each rebases
// independently). savePatch realigns EOL to HEAD first, so the per-file
// diffs below inherit the same normalization.
const osvfsRel = "internal/vfs/osvfs/os.go";
const outDirRel = "_packages/native-preview/tsconfig.json";

saveOverlay(subDir, path.join(patchDir, "overlay"));
savePatch(subDir, path.join(patchDir, "0001-bridge-inplace.patch"), [osvfsRel, outDirRel]);

function saveSingleFilePatch(rel, patchName) {
	const diff = git(["diff", "--", rel]);
	if (diff.status !== 0) {
		console.error(`save: git diff ${rel} failed\n` + diff.stderr);
		process.exit(1);
	}
	const patchPath = path.join(patchDir, patchName);
	require("fs").writeFileSync(patchPath, diff.stdout);
	console.log(`save: patch <- ${diff.stdout.length} bytes (${patchName})`);
}

saveSingleFilePatch(osvfsRel, "0002-osvfs-executable-fallback.patch");
saveSingleFilePatch(outDirRel, "0003-native-preview-outdir.patch");
