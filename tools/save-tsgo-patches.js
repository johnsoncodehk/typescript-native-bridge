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
const resolveExternalModuleSymbolRel = [
	"internal/api/proto.go",
	"internal/api/session.go",
	"_packages/native-preview/src/api/async/api.ts",
	"_packages/native-preview/src/api/sync/api.ts",
	"_packages/native-preview/test/sync/api.test.ts",
];
const noembedRel = "internal/bundled/noembed.go";

saveOverlay(subDir, path.join(patchDir, "overlay"));
savePatch(subDir, path.join(patchDir, "0001-bridge-inplace.patch"), [
	osvfsRel,
	...resolveExternalModuleSymbolRel,
	noembedRel,
]);

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

function saveFilesPatch(rels, patchName) {
	const diff = git(["diff", "--", ...rels]);
	if (diff.status !== 0) {
		console.error(`save: git diff ${rels.join(" ")} failed\n` + diff.stderr);
		process.exit(1);
	}
	const patchPath = path.join(patchDir, patchName);
	require("fs").writeFileSync(patchPath, diff.stdout);
	console.log(`save: patch <- ${diff.stdout.length} bytes (${patchName})`);
}

saveSingleFilePatch(osvfsRel, "0002-osvfs-executable-fallback.patch");
saveFilesPatch(resolveExternalModuleSymbolRel, "0004-resolve-external-module-symbol.patch");
saveSingleFilePatch(noembedRel, "0005-noembed-tnb-lib-path.patch");
