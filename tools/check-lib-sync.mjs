#!/usr/bin/env node
// Ensure overlay → submodule → lib/ are in sync. Fails if lib/ was hand-edited
// or rebuild was skipped after changing patches/typescript/overlay/.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libTs = path.join(root, "lib/typescript.js");
const libTsc = path.join(root, "lib/_tsc.js");

const errors = [];

function fail(msg) {
	errors.push(msg);
}

function walkFiles(dir, rel = "") {
	const out = [];
	const abs = path.join(dir, rel);
	if (!fs.existsSync(abs)) return out;
	for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
		const childRel = rel ? path.posix.join(rel, e.name) : e.name;
		if (e.isDirectory()) out.push(...walkFiles(dir, childRel));
		else out.push(childRel);
	}
	return out;
}

// 1. overlay applied to submodule: every file under patches/<sub>/overlay/
// mirrors a submodule-relative path (same rule for both submodules) and must
// be byte-identical to it — saveOverlay copies net-new submodule files into
// the overlay, so this is the gate that patch:ts / patch:tsgo actually ran.
function checkOverlaySync(subName, patchScript) {
	const overlayDir = path.join(root, "patches", subName, "overlay");
	const subDir = path.join(root, subName);
	if (!fs.existsSync(overlayDir)) {
		fail(`missing overlay dir: ${path.relative(root, overlayDir)}`);
		return;
	}
	const rels = walkFiles(overlayDir).sort();
	for (const rel of rels) {
		const overlayFile = path.join(overlayDir, rel);
		const subFile = path.join(subDir, rel);
		if (!fs.existsSync(subFile)) {
			fail(`${subName}/${rel}: overlay file missing from submodule — run npm run ${patchScript}`);
		} else if (!fs.readFileSync(overlayFile).equals(fs.readFileSync(subFile))) {
			fail(`${subName}/${rel} differs from patches/${subName}/overlay/${rel} — run npm run ${patchScript}`);
		}
	}
}

// 1.5 no staged changes inside either submodule: save flows diff against HEAD
// (patch-common.js), so anything staged would be silently dropped from the
// saved patches. Surface it here instead of losing it at save time.
function checkNoStaged(subName) {
	const st = spawnSync("git", ["-C", path.join(root, subName), "diff", "--cached", "--quiet"], { encoding: "utf8" });
	if (st.status !== 0) {
		fail(`${subName}/: staged changes present — save-patches diffs against HEAD and would silently drop them; unstage first (git restore --staged .)`);
	}
}

checkOverlaySync("typescript", "patch:ts");
checkOverlaySync("typescript-go", "patch:tsgo");
checkNoStaged("typescript");
checkNoStaged("typescript-go");

// 2. lib bundles exist and share the same banner shape (compiled JS uses \u escapes)
const stale = ["1;42;30", '\\u2501".repeat(56)', '\\u2500".repeat(inner)', '\\u2514" + "\\u2500"', '\\x1B[32m', '\\u2705', '>>  TNB'];
const required = [
	"TNB ACTIVE",
	'\\x1B[2m',
	'\\u258E',
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
	// box corners are pre-#45 artifacts: the banner is a single dimmed line now
	if (/\\u250[cC]/.test(text)) {
		fail(`${rel}: stale banner artifact (box corner) — run npm run build:lib`);
	}
}

// 2.5 SIGURG signal-storm guard must be compiled into BOTH bundles.
// A bundle that carries the bridge loader but not the GODEBUG guard can
// dlopen bridge.node with async preemption enabled — the 23h orphan bug.
for (const lib of [libTs, libTsc]) {
	if (!fs.existsSync(lib)) continue;
	const text = fs.readFileSync(lib, "utf8");
	if (text.includes("bridge.node") && !text.includes("asyncpreemptoff=1")) {
		fail(`${path.relative(root, lib)}: has bridge loader but no GODEBUG asyncpreemptoff guard — stale build, run npm run build:lib`);
	}
}

// 2.75 lib shims: patch-lib-shims.js must have run. bin/tsc and bin/tsserver
// require lib/tnb-godebug.js as their first line, so its absence crashes the
// CLI after a plain build:ts. build:ts carries the shim step (package.json),
// so this is a gate that the build produced shims, not a manual-copy check.
if (!fs.existsSync(path.join(root, "lib", "tnb-godebug.js"))) {
	fail("missing lib/tnb-godebug.js — run npm run build:ts (or build:lib) so the lib shims are produced");
}

// 3. both bundles carry the same dimmed one-line banner (not divergent hand patches)
if (fs.existsSync(libTs) && fs.existsSync(libTsc)) {
	const ts = fs.readFileSync(libTs, "utf8");
	const tsc = fs.readFileSync(libTsc, "utf8");
	const bannerRe = /\\x1[bB]\[2m/;
	if (bannerRe.test(ts) !== bannerRe.test(tsc)) {
		fail("lib/typescript.js and lib/_tsc.js banner code diverged — run npm run build:lib");
	}
}

// 4. bundled libs ↔ lib/*.d.ts byte sync (intersection only; asymmetry is informational)
const bundledDir = path.join(root, "typescript-go", "internal", "bundled", "libs");
const libDir = path.join(root, "lib");
if (!fs.existsSync(bundledDir)) {
	fail(`missing bundled libs: ${path.relative(root, bundledDir)}`);
} else if (!fs.existsSync(libDir)) {
	fail(`missing lib/: ${path.relative(root, libDir)} — run npm run build:lib`);
} else {
	const bundledNames = new Set(
		fs.readdirSync(bundledDir).filter((n) => n.startsWith("lib") && n.endsWith(".d.ts")),
	);
	const libNames = new Set(
		fs.readdirSync(libDir).filter((n) => n.startsWith("lib") && n.endsWith(".d.ts")),
	);
	const onlyBundled = [...bundledNames].filter((n) => !libNames.has(n)).sort();
	const onlyLib = [...libNames].filter((n) => !bundledNames.has(n)).sort();
	const intersection = [...bundledNames].filter((n) => libNames.has(n)).sort();
	const drifted = [];
	for (const name of intersection) {
		const a = fs.readFileSync(path.join(bundledDir, name));
		const b = fs.readFileSync(path.join(libDir, name));
		if (!a.equals(b)) drifted.push(name);
	}
	if (drifted.length) {
		fail(
			`lib/*.d.ts drifted from typescript-go bundled libs (${drifted.length}): ${drifted.join(", ")} — run npm run build:lib`,
		);
	} else if (onlyBundled.length || onlyLib.length) {
		console.log(
			`check:lib-sync asymmetry (ok): bundled-only=[${onlyBundled.join(", ")}] lib-only=[${onlyLib.join(", ")}]`,
		);
	} else {
		console.log(`check:lib-sync bundled libs: intersection=${intersection.length} byte-identical, asymmetry=[]`);
	}
}

if (errors.length) {
	console.error("check:lib-sync failed:\n");
	for (const e of errors) console.error(`  • ${e}`);
	process.exit(1);
}

console.log("check:lib-sync ok (overlay↔submodule both dirs, lib shims, lib/typescript.js, lib/_tsc.js, bundled libs, no staged)");
