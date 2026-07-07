#!/usr/bin/env node
// Ensure overlay → submodule → lib/ are in sync. Fails if lib/ was hand-edited
// or rebuild was skipped after changing patches/typescript/overlay/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlay = path.join(root, "patches/typescript/overlay/src/compiler/tsgoChecker.ts");
const submodule = path.join(root, "typescript/src/compiler/tsgoChecker.ts");
const libTs = path.join(root, "lib/typescript.js");
const libTsc = path.join(root, "lib/_tsc.js");

const errors = [];

function fail(msg) {
	errors.push(msg);
}

// 1. overlay applied to submodule
if (!fs.existsSync(overlay)) {
	fail(`missing overlay: ${path.relative(root, overlay)}`);
} else if (!fs.existsSync(submodule)) {
	fail(`missing submodule source: ${path.relative(root, submodule)} (run npm run patch:ts)`);
} else if (fs.readFileSync(overlay, "utf8") !== fs.readFileSync(submodule, "utf8")) {
	fail("typescript/src/compiler/tsgoChecker.ts differs from patches/typescript/overlay/ — run npm run patch:ts");
}

// 2. lib bundles exist and share the same banner shape (compiled JS uses \u escapes)
const stale = ["1;42;30", "1;42;30m", '\\u2501".repeat(56)'];
const required = [
	"TNB ACTIVE",
	'\\u2500".repeat(inner)',
	'\\u2514" + "\\u2500"',
];

for (const lib of [libTs, libTsc]) {
	const rel = path.relative(root, lib);
	if (!fs.existsSync(lib)) {
		fail(`missing ${rel} — run npm run build:lib`);
		continue;
	}
	const text = fs.readFileSync(lib, "utf8");
	if (!text.includes("TNB ACTIVE")) {
		fail(`${rel}: missing TNB banner — run npm run build:lib`);
		continue;
	}
	for (const s of stale) {
		if (text.includes(s)) {
			fail(`${rel}: stale banner artifact (${JSON.stringify(s)}) — run npm run build:lib; do not hand-edit lib/`);
		}
	}
	for (const s of required) {
		if (!text.includes(s)) {
			fail(`${rel}: banner out of date (missing ${JSON.stringify(s)}) — run npm run build:lib`);
		}
	}
	// top-left corner: compiler may emit \u250c or \u250C
	if (!/\\u250[cC]/.test(text)) {
		fail(`${rel}: banner out of date (missing box corner) — run npm run build:lib`);
	}
}

// 2.5 SIGURG signal-storm guard must be compiled into BOTH bundles.
// A bundle that carries the bridge loader but not the GODEBUG guard can
// dlopen bridge.dylib with async preemption enabled — the 23h orphan bug.
for (const lib of [libTs, libTsc]) {
	if (!fs.existsSync(lib)) continue;
	const text = fs.readFileSync(lib, "utf8");
	if (text.includes("koffi") && !text.includes("asyncpreemptoff=1")) {
		fail(`${path.relative(root, lib)}: has bridge loader but no GODEBUG asyncpreemptoff guard — stale build, run npm run build:lib`);
	}
}

// 3. both bundles use the same border style (not divergent hand patches)
if (fs.existsSync(libTs) && fs.existsSync(libTsc)) {
	const ts = fs.readFileSync(libTs, "utf8");
	const tsc = fs.readFileSync(libTsc, "utf8");
	const borderRe = /const top = "\\u250[cC]" \+ "\\u2500"\.repeat\(inner\) \+ "\\u2510"/;
	if (borderRe.test(ts) !== borderRe.test(tsc)) {
		fail("lib/typescript.js and lib/_tsc.js banner code diverged — run npm run build:lib");
	}
}

if (errors.length) {
	console.error("check:lib-sync failed:\n");
	for (const e of errors) console.error(`  • ${e}`);
	process.exit(1);
}

console.log("check:lib-sync ok (overlay, submodule, lib/typescript.js, lib/_tsc.js)");
