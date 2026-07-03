#!/usr/bin/env node
// Guard the compiler bundle (_tsc.js) stays flat/eager. A single
// compiler→services import edge flips esbuild to lazy __esm wrappers,
// making `sys` lazy and breaking vue-tsc (eval("sys") at module load).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libTsc = path.join(root, "lib/_tsc.js");

const errors = [];

function fail(msg) {
	errors.push(msg);
}

if (!fs.existsSync(libTsc)) {
	fail(`missing ${path.relative(root, libTsc)} — run npm run build:lib`);
} else {
	const text = fs.readFileSync(libTsc, "utf8");

	const esmCount = (text.match(/\b__esm\b/g) ?? []).length;
	if (esmCount !== 0) {
		fail(`lib/_tsc.js has ${esmCount} __esm references (expected 0) — compiler bundle is lazy; vue-tsc will crash on eval("sys")`);
	}

	if (!/var sys = \(\(\) =>/.test(text)) {
		fail("lib/_tsc.js missing eager `var sys = (() =>` — sys may be lazy-init only");
	}

	if (/\bvar init_sys = __esm/.test(text)) {
		fail("lib/_tsc.js uses lazy init_sys = __esm — sys is not top-level eager");
	}

	const servicesHits = (text.match(/\binit_services\b/g) ?? []).length;
	if (servicesHits !== 0) {
		fail(`lib/_tsc.js contains init_services (${servicesHits}) — services layer leaked into compiler bundle`);
	}

	if (text.includes("services/jsDoc")) {
		fail("lib/_tsc.js references services/jsDoc — cross-layer import cycle risk");
	}
}

if (errors.length) {
	console.error("check:bundle-shape failed:\n");
	for (const e of errors) console.error(`  • ${e}`);
	process.exit(1);
}

console.log("check:bundle-shape ok (eager sys, 0 __esm, no services in _tsc.js)");
