#!/usr/bin/env node
// Guard: the skeleton SourceFile must not set imports=[].
//
// createSkeletonSourceFile poisoned the tsgo-backed skeleton with imports=[],
// which blocked getTsgoBackedSourceFile from preserving the RemoteSourceFile's
// decoded imports. That caused ensureHostSourceFileModuleRefs to rebuild a
// shorter list from statements (missing ambient-module-body imports), making
// explainFiles crash on out-of-range indices (issue #54).
//
// This gate fails if the pattern reappears in the built lib.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = path.join(root, "lib", "typescript.js");
const src = fs.readFileSync(lib, "utf8");

// Match `anySf.imports = []` with surrounding context.
const re = /anySf\.imports\s*=\s*\[\]/g;
const hits = [];
let m;
while ((m = re.exec(src)) !== null) {
	const start = Math.max(0, m.index - 50);
	const end = Math.min(src.length, m.index + 50);
	hits.push(`  ${src.slice(start, end).replace(/\n/g, "\\n")}`);
}

if (hits.length) {
	console.error("check:skeleton-imports failed:\n");
	console.error(`  skeleton imports=[] poison found (${hits.length} site(s)):`);
	for (const h of hits) console.error(h);
	console.error("\n  Fix: remove the `imports = []` line from createSkeletonSourceFile.");
	process.exit(1);
}

console.log("check:skeleton-imports ok (no imports=[] poison on skeleton)");
