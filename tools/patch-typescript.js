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
const { applyOverlay, applyPatchFiles } = require("./patch-common.js");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript");
const patchDir = path.join(repoRoot, "patches", "typescript");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(path.join(subDir, ".git"))) {
	console.error("patch-typescript: typescript submodule not present. Run `git submodule update --init` first.");
	process.exit(1);
}

// The overlay's tsgoChecker does require("@typescript/native-preview") + koffi at
// run time. koffi is a normal dep (found via parent node_modules walk); link the
// locally-built tsgo package so Node's resolver finds it too. Idempotent.
if (!checkOnly) {
	const npDest = path.join(repoRoot, "node_modules", "@typescript", "native-preview");
	const npSrc = path.join("..", "..", "typescript-go", "_packages", "native-preview");
	fs.mkdirSync(path.dirname(npDest), { recursive: true });
	let ok = false;
	try { ok = fs.readlinkSync(npDest) === npSrc; } catch { /* missing */ }
	if (!ok) {
		try { fs.rmSync(npDest, { recursive: true, force: true }); } catch { /* ignore */ }
		fs.symlinkSync(npSrc, npDest);
		console.log("patch-typescript: linked @typescript/native-preview");
	}
}

applyOverlay(subDir, path.join(patchDir, "overlay"), checkOnly);
applyPatchFiles(subDir, patchDir, checkOnly);
