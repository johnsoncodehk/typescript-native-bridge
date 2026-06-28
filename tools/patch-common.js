"use strict";
// Shared patch/overlay machinery for both submodules (typescript-go, typescript).
//
// Unified two-part delta convention:
//   - patches/<sub>/overlay/<path-from-submodule-root>   pure-new files (copied)
//   - patches/<sub>/*.patch                              in-place edits (git apply)
//
// "overlay" is a tree mirroring the submodule root, so a net-new file at
// <sub>/bridge/bridge.go lives at patches/<sub>/overlay/bridge/bridge.go.
// New files never conflict on upstream rebase, so they are kept as plain files
// rather than baked into the patch (smaller, reviewable patches; clean source).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const git = (subDir, args) => spawnSync("git", ["-C", subDir, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

function walkFiles(root, rel = "") {
	const out = [];
	const abs = path.join(root, rel);
	if (!fs.existsSync(abs)) return out;
	for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
		const childRel = path.posix.join(rel, e.name);
		if (e.isDirectory()) out.push(...walkFiles(root, childRel));
		else out.push(childRel);
	}
	return out;
}

// Copy overlay tree into the submodule (idempotent; content-equal = skip).
function applyOverlay(subDir, overlayDir, checkOnly) {
	if (!fs.existsSync(overlayDir)) return;
	for (const rel of walkFiles(overlayDir)) {
		const src = path.join(overlayDir, rel);
		const dest = path.join(subDir, rel);
		const want = fs.readFileSync(src);
		let have = null;
		try { have = fs.readFileSync(dest); } catch { /* missing */ }
		if (have && have.equals(want)) continue;
		if (checkOnly) {
			console.error(`overlay ${rel} differs (check failed)`);
			process.exit(1);
		}
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(src, dest);
		console.log(`overlay: ${rel}`);
	}
}

// Apply *.patch files (idempotent: already-applied = reverse-applies = skip).
function applyPatchFiles(subDir, patchDir, checkOnly) {
	const patches = fs.existsSync(patchDir)
		? fs.readdirSync(patchDir).filter((f) => f.endsWith(".patch")).sort()
		: [];
	for (const name of patches) {
		const patchPath = path.join(patchDir, name);
		if (fs.readFileSync(patchPath, "utf8").trim().length === 0) {
			console.log(`patch: ${name} empty (skip)`);
			continue;
		}
		const fwd = git(subDir, ["apply", "--whitespace=nowarn", "--check", patchPath]);
		if (fwd.status === 0) {
			if (!checkOnly) {
				const ap = git(subDir, ["apply", "--whitespace=nowarn", patchPath]);
				if (ap.status !== 0) {
					console.error(`patch: failed to apply ${name}\n${ap.stderr}`);
					process.exit(1);
				}
			}
			console.log(`patch: ${checkOnly ? "ok" : "applied"} ${name}`);
			continue;
		}
		const rev = git(subDir, ["apply", "--whitespace=nowarn", "--check", "-R", patchPath]);
		if (rev.status === 0) {
			console.log(`patch: already applied ${name} (skip)`);
			continue;
		}
		console.error(`patch: ${name} does not apply cleanly.\n-- forward --\n${fwd.stderr}\n-- reverse --\n${rev.stderr}`);
		process.exit(1);
	}
}

// Save: net-new files (git ls-files --others) -> overlay tree.
function saveOverlay(subDir, overlayDir) {
	const ls = git(subDir, ["ls-files", "--others", "--exclude-standard"]);
	if (ls.status !== 0) {
		console.error("save: git ls-files failed\n" + ls.stderr);
		process.exit(1);
	}
	const files = ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
	// Reset overlay dir to exactly the current net-new set.
	fs.rmSync(overlayDir, { recursive: true, force: true });
	for (const rel of files) {
		const src = path.join(subDir, rel);
		const dest = path.join(overlayDir, rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(src, dest);
	}
	console.log(`save: overlay <- ${files.length} new file(s)`);
}

// Save: in-place edits to tracked files (git diff) -> single patch.
function savePatch(subDir, patchPath) {
	const diff = git(subDir, ["diff"]);
	if (diff.status !== 0) {
		console.error("save: git diff failed\n" + diff.stderr);
		process.exit(1);
	}
	fs.mkdirSync(path.dirname(patchPath), { recursive: true });
	fs.writeFileSync(patchPath, diff.stdout);
	console.log(`save: patch <- ${diff.stdout.length} bytes (${path.basename(patchPath)})`);
}

module.exports = { applyOverlay, applyPatchFiles, saveOverlay, savePatch };
