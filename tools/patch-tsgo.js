"use strict";
// Apply the patch set under patches/typescript-go/ to the typescript-go submodule
// (checked out at the pinned upstream commit). Mirrors golar's patch-tsgo.ts.
//
// Run after `git submodule update --init` to materialize the poc-napi/ cgo bridge
// on top of a clean upstream tree. Idempotent: if a patch is already applied
// (reverse-applies cleanly), it is skipped.
//
//   node tools/patch-tsgo.js          # apply
//   node tools/patch-tsgo.js --check  # verify only, no writes

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const subDir = path.join(repoRoot, "typescript-go");
const patchDir = path.join(repoRoot, "patches", "typescript-go");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(path.join(subDir, ".git"))) {
	console.error("patch-tsgo: typescript-go submodule not present. Run `git submodule update --init` first.");
	process.exit(1);
}

const patches = fs
	.readdirSync(patchDir)
	.filter((f) => f.endsWith(".patch"))
	.sort();
if (patches.length === 0) {
	console.error("patch-tsgo: no patches found in", patchDir);
	process.exit(1);
}

const run = (args) => spawnSync("git", args, { encoding: "utf8" });

for (const name of patches) {
	const patchPath = path.join(patchDir, name);

	// 1. Forward check: would the patch apply on the current tree?
	const fwdCheck = run(["-C", subDir, "apply", "--whitespace=nowarn", "--check", patchPath]);
	if (fwdCheck.status === 0) {
		if (!checkOnly) {
			const apply = run(["-C", subDir, "apply", "--whitespace=nowarn", patchPath]);
			if (apply.status !== 0) {
				console.error(`patch-tsgo: failed to apply ${name}\n${apply.stderr}`);
				process.exit(1);
			}
		}
		console.log(`patch-tsgo: ${checkOnly ? "ok" : "applied"} ${name}`);
		continue;
	}

	// 2. Forward check failed — is it already applied (reverse check passes)?
	const revCheck = run(["-C", subDir, "apply", "--whitespace=nowarn", "--check", "-R", patchPath]);
	if (revCheck.status === 0) {
		console.log(`patch-tsgo: already applied ${name} (skip)`);
		continue;
	}

	console.error(`patch-tsgo: ${name} does not apply cleanly.\n-- forward --\n${fwdCheck.stderr}\n-- reverse --\n${revCheck.stderr}`);
	process.exit(1);
}
