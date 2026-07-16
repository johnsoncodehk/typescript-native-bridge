"use strict";
// Copy @typescript/native-preview package skeleton plus built dist/ into
// vendor/native-preview/. dist must be built in place (outDir=dist) because
// the package's `#enums/*` imports self-resolve through dist/enums/*.enum.d.ts
// during its own tsc build; run this AFTER `tsc -b`.
//   node tools/sync-vendor-native-preview.js

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(repoRoot, "typescript-go", "_packages", "native-preview");
const destRoot = path.join(repoRoot, "vendor", "native-preview");

const COPY_DIRS = ["lib", "vendor", "bin", "dist"];
const COPY_FILES = ["package.json"];

function copyDir(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const name of fs.readdirSync(src)) {
		const srcPath = path.join(src, name);
		const destPath = path.join(dest, name);
		const st = fs.statSync(srcPath);
		if (st.isDirectory()) copyDir(srcPath, destPath);
		else fs.copyFileSync(srcPath, destPath);
	}
}

if (!fs.existsSync(srcRoot)) {
	console.error("sync-vendor-native-preview: native-preview submodule path missing");
	process.exit(1);
}

fs.mkdirSync(destRoot, { recursive: true });
for (const f of COPY_FILES) {
	const src = path.join(srcRoot, f);
	const dest = path.join(destRoot, f);
	fs.copyFileSync(src, dest);
}
for (const d of COPY_DIRS) {
	const src = path.join(srcRoot, d);
	if (!fs.existsSync(src)) continue;
	copyDir(src, path.join(destRoot, d));
}
console.log("sync-vendor-native-preview: vendor/native-preview skeleton updated");
