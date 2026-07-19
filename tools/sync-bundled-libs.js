#!/usr/bin/env node
/**
 * Copy typescript-go bundled lib*.d.ts over TNB root lib/ (intersection only).
 * Keeps TNB disk libs byte-identical to tsgo's embedded libs so position-keyed
 * RPCs (hover/gtd/refs) that map by filename do not land on the wrong node.
 *
 * Separate from patch-lib-shims.js (GODEBUG guards only) so each step stays single-purpose.
 *
 * Usage: node tools/sync-bundled-libs.js
 * Output: sync-bundled-libs: copied=N changed=M asymmetric=[...]
 */
"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const bundledDir = path.join(repoRoot, "typescript-go", "internal", "bundled", "libs");
const libDir = path.join(repoRoot, "lib");

if (!fs.existsSync(bundledDir)) {
	console.error(`sync-bundled-libs: missing ${path.relative(repoRoot, bundledDir)}`);
	process.exit(1);
}
if (!fs.existsSync(libDir)) {
	console.error(`sync-bundled-libs: missing ${path.relative(repoRoot, libDir)} — run hereby lkg first`);
	process.exit(1);
}

const bundledNames = new Set(
	fs.readdirSync(bundledDir).filter((n) => n.startsWith("lib") && n.endsWith(".d.ts")),
);
const libNames = new Set(
	fs.readdirSync(libDir).filter((n) => n.startsWith("lib") && n.endsWith(".d.ts")),
);

const onlyBundled = [...bundledNames].filter((n) => !libNames.has(n)).sort();
const onlyLib = [...libNames].filter((n) => !bundledNames.has(n)).sort();
const intersection = [...bundledNames].filter((n) => libNames.has(n)).sort();

let changed = 0;
for (const name of intersection) {
	const src = path.join(bundledDir, name);
	const dest = path.join(libDir, name);
	const srcBuf = fs.readFileSync(src);
	const destBuf = fs.readFileSync(dest);
	if (!srcBuf.equals(destBuf)) {
		fs.copyFileSync(src, dest);
		changed++;
	}
}

const asymmetric = [
	...onlyBundled.map((n) => `bundled-only:${n}`),
	...onlyLib.map((n) => `lib-only:${n}`),
];

console.log(
	`sync-bundled-libs: copied=${intersection.length} changed=${changed} asymmetric=[${asymmetric.join(", ")}]`,
);
if (onlyBundled.length || onlyLib.length) {
	if (onlyBundled.length) {
		console.log(`  bundled-only (skipped, not in lib/): ${onlyBundled.join(", ")}`);
	}
	if (onlyLib.length) {
		console.log(`  lib-only (preserved, not in bundled): ${onlyLib.join(", ")}`);
	}
}
