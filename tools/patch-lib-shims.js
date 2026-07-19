"use strict";
// Inject GODEBUG guard into lib entry shims after LKG.
// Go reads GODEBUG at dlopen; this must run before require("./_tsserver.js") etc.

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const godebugHelper = path.join(repoRoot, "tools", "tnb-godebug.js");
const guard = [
	"// TNB: Go reads GODEBUG at process start — re-exec CLI entrypoints when missing.",
	"require('./tnb-godebug.js').ensureGodebugReexec();",
	"",
].join("\n");

// Copy helper next to lib shims (lib/ is build output).
const libGodebug = path.join(repoRoot, "lib", "tnb-godebug.js");
fs.mkdirSync(path.dirname(libGodebug), { recursive: true });
fs.copyFileSync(godebugHelper, libGodebug);

for (const [shim, target] of [["tsserver.js", "./_tsserver.js"], ["tsc.js", "./_tsc.js"]]) {
	const file = path.join(repoRoot, "lib", shim);
	if (!fs.existsSync(file)) {
		console.error(`patch-lib-shims: missing ${path.relative(repoRoot, file)}`);
		process.exit(1);
	}
	let text = fs.readFileSync(file, "utf8");
	if (text.includes("TNB: Go reads GODEBUG at process start")) {
		continue;
	}
	const needle = `module.exports = require("${target}");`;
	if (!text.includes(needle)) {
		console.error(`patch-lib-shims: unexpected ${shim} shape`);
		process.exit(1);
	}
	text = text.replace(needle, `${guard}module.exports = require("${target}");`);
	fs.writeFileSync(file, text);
	console.log(`patch-lib-shims: ${shim}`);
}

// lib/typescript.js is require()'d as a library — re-exec there would restart
// embedders (vitest workers). CLI entrypoints use bin/* and lib/tsc|tsserver.js.
