#!/usr/bin/env node
// Assemble the per-platform bridge sub-packages and inject them into the main
// package's optionalDependencies (esbuild/@typescript/native-preview model).
//
//   node tools/pack-platform-packages.mjs <stagingDir> <bridgesDir> <outDir>
//
//   stagingDir  main package contents (package.json, lib/, vendor/, bin/, …)
//   bridgesDir  CI artifact layout: bridge-<os>-<arch>/bridge.<ext> per platform
//   outDir      created; one sub-directory per platform, ready to npm publish
//
// The main package.json in stagingDir is updated in place with the seven
// optionalDependencies pinned to its own version. Sub-package manifests carry
// os/cpu so npm installs only the matching one (non-matching optional deps are
// skipped silently).

import fs from "node:fs";
import path from "node:path";

const SCOPE = "@typescript-native-bridge";
const PLATFORMS = [
	{ os: "darwin", arch: "arm64", ext: "dylib" },
	{ os: "darwin", arch: "x64", ext: "dylib" },
	{ os: "linux", arch: "x64", ext: "so" },
	{ os: "linux", arch: "arm64", ext: "so" },
	{ os: "linux", arch: "arm", ext: "so" },
	{ os: "win32", arch: "x64", ext: "dll" },
	{ os: "win32", arch: "arm64", ext: "dll" },
];

const [stagingDir, bridgesDir, outDir] = process.argv.slice(2);
if (!stagingDir || !bridgesDir || !outDir) {
	console.error("usage: node tools/pack-platform-packages.mjs <stagingDir> <bridgesDir> <outDir>");
	process.exit(2);
}

const mainPkgPath = path.join(stagingDir, "package.json");
const mainPkg = JSON.parse(fs.readFileSync(mainPkgPath, "utf8"));
const version = mainPkg.version;

const missing = [];
for (const p of PLATFORMS) {
	const bin = path.join(bridgesDir, `bridge-${p.os}-${p.arch}`, `bridge.${p.ext}`);
	if (!fs.existsSync(bin)) missing.push(bin);
}
if (missing.length) {
	console.error(`pack-platform-packages: missing bridge binaries:\n  ${missing.join("\n  ")}`);
	process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });

for (const p of PLATFORMS) {
	const id = `${p.os}-${p.arch}`;
	const pkgDir = path.join(outDir, id);
	const nativeDir = path.join(pkgDir, "native");
	fs.mkdirSync(nativeDir, { recursive: true });
	fs.copyFileSync(path.join(bridgesDir, `bridge-${id}`, `bridge.${p.ext}`), path.join(nativeDir, `bridge.${p.ext}`));
	for (const extra of ["LICENSE", "NOTICE"]) {
		const src = path.join(stagingDir, extra);
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pkgDir, extra));
	}
	const subPkg = {
		name: `${SCOPE}/${id}`,
		version,
		license: mainPkg.license ?? "Apache-2.0",
		description: `tsgo bridge binary for ${p.os} ${p.arch} (typescript-native-bridge)`,
		repository: mainPkg.repository,
		os: [p.os],
		cpu: [p.arch],
		files: ["native", "LICENSE", "NOTICE"],
		publishConfig: { access: "public" },
	};
	fs.writeFileSync(pkgDir + "/package.json", JSON.stringify(subPkg, null, "\t") + "\n");
}

mainPkg.optionalDependencies = Object.fromEntries(PLATFORMS.map(p => [`${SCOPE}/${p.os}-${p.arch}`, version]));
fs.writeFileSync(mainPkgPath, JSON.stringify(mainPkg, null, "\t") + "\n");

console.log(`pack-platform-packages: ${PLATFORMS.length} sub-packages at ${outDir}; optionalDependencies injected into ${mainPkgPath}`);
