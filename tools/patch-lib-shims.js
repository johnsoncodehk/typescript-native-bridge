"use strict";
// Inject GODEBUG guard into lib entry shims after LKG.
// Go reads GODEBUG at dlopen; this must run before require("./_tsserver.js") etc.

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const guard = [
	"// TNB: Go runtime reads GODEBUG at dlopen — set before any bundle loads.",
	'if (process.env.TNB_SKIP_ASYNC_PREEMPT_OFF !== "1" && !/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(process.env.GODEBUG ?? "")) {',
	'  process.env.GODEBUG = process.env.GODEBUG ? `${process.env.GODEBUG},asyncpreemptoff=1` : "asyncpreemptoff=1";',
	"}",
	"",
].join("\n");

for (const [shim, target] of [["tsserver.js", "./_tsserver.js"], ["tsc.js", "./_tsc.js"]]) {
	const file = path.join(repoRoot, "lib", shim);
	if (!fs.existsSync(file)) {
		console.error(`patch-lib-shims: missing ${path.relative(repoRoot, file)}`);
		process.exit(1);
	}
	let text = fs.readFileSync(file, "utf8");
	if (text.includes("TNB: Go runtime reads GODEBUG")) {
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
