"use strict";
// Regenerate patches/typescript-go/{overlay,*.patch} from the submodule working
// tree. Edit files inside typescript-go/, then run this to version the delta.
//   node tools/save-tsgo-patches.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { saveOverlay, savePatch } = require("./patch-common.js");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript-go");
const patchDir = path.join(repoRoot, "patches", "typescript-go");

// One patch per subsystem, so each rebases independently. Entries own
// directories (trailing `/`) or single files; the file sets are disjoint, so
// apply order carries no meaning. An edited file no entry owns fails the save:
// a catch-all would regrow the monolith.
const PATCHES = [
	["0001-checker.patch", ["internal/checker/"]],
	["0002-osvfs-executable-fallback.patch", ["internal/vfs/osvfs/os.go"]],
	["0003-project-program.patch", ["internal/project/", "internal/compiler/", "internal/tsoptions/", "internal/module/", "internal/execute/"]],
	["0004-api-rpc.patch", ["internal/api/"]],
	["0005-noembed-lib-path.patch", ["internal/bundled/noembed.go"]],
	["0006-ls.patch", ["internal/ls/"]],
	["0007-native-preview-client.patch", ["_packages/native-preview/"]],
];

const owns = (spec, rel) => spec.endsWith("/") ? rel.startsWith(spec) : rel === spec;

const edited = spawnSync("git", ["-C", subDir, "diff", "--name-only", "HEAD"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
for (const rel of edited) {
	const owners = PATCHES.filter(([, specs]) => specs.some(s => owns(s, rel)));
	if (owners.length !== 1) {
		console.error(`save: ${rel} is owned by ${owners.length} patches (${owners.map(([n]) => n).join(", ") || "none"}) — add it to exactly one PATCHES entry`);
		process.exit(1);
	}
}

saveOverlay(subDir, path.join(patchDir, "overlay"));
const names = new Set(PATCHES.map(([name]) => name));
for (const f of fs.readdirSync(patchDir)) {
	if (f.endsWith(".patch") && !names.has(f)) fs.rmSync(path.join(patchDir, f));
}
for (const [name, specs] of PATCHES) savePatch(subDir, path.join(patchDir, name), specs);
