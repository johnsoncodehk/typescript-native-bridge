"use strict";
// Alias-validation for typescript-native-bridge as a `typescript` drop-in.
//
// Simulates what `npm` does for `"typescript": "npm:typescript-native-bridge"`
// at install time — namely, make a consumer's `require('typescript')` resolve
// to THIS package — by installing a module-resolution hook scoped to the
// consumer's own requires. The package's INTERNAL `require('typescript')`
// (for the real-ts base) is left alone, exactly as a real nested
// `node_modules/typescript/node_modules/typescript` dep would.
//
//   node test/alias.js
//
// Proves: a consumer doing `require('typescript')` + `ts.createProgram` +
// rule-style AST walk + checker queries runs fully in-process via the NAPI
// bridge, and produces the same structural finding as real `typescript`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const PKG_INDEX = path.resolve(__dirname, "../src/index.js");
const REAL_TS = require.resolve("typescript");

// Hook: redirect `require('typescript')` to the package, but ONLY when the
// caller is this consumer script (not the package itself, which needs real ts
// for its base/gap surface). This mirrors the alias install layout.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
	if (request === "typescript" && parent && parent.filename === __filename) {
		return PKG_INDEX;
	}
	return origResolve.call(this, request, parent, ...rest);
};

const ts = require("typescript"); // → typescript-native-bridge
const tsReal = require(REAL_TS); // real typescript, for parity comparison

function makeFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnb-alias-"));
	const file = path.join(dir, "fixture.ts");
	const tsconfig = path.join(dir, "tsconfig.json");
	fs.writeFileSync(file, "console.log('Hello, world!');\n");
	fs.writeFileSync(
		tsconfig,
		JSON.stringify(
			{
				compilerOptions: {
					target: "esnext",
					module: "esnext",
					moduleResolution: "bundler",
					noEmit: true,
					allowImportingTsExtensions: true,
					skipLibCheck: true,
				},
				include: ["fixture.ts"],
			},
			null,
			2,
		),
	);
	return { dir, file, tsconfig };
}

const { dir, file, tsconfig } = makeFixture();

const failures = [];
function check(name, cond, detail) {
	if (cond) process.stdout.write(".");
	else {
		failures.push(name + (detail ? ` — ${detail}` : ""));
		process.stdout.write("F");
	}
}

// ── consumer got the napi facade, not real ts ──
check("alias routes typescript → napi", ts.__tsNativeBridge__ === true);
check("real ts is distinct", tsReal.__tsNativeBridge__ !== true);
check("tsgo SyntaxKind differs from real", ts.SyntaxKind.Identifier !== tsReal.SyntaxKind.Identifier);

// ── run the no-console rule logic (tsslint-style) on the napi program ──
// Uses static `.text` (both tsgo and real-ts Identifier nodes carry it) and
// `pos`/`end` rather than getText()/getStart(), which need a resolved
// sourceFile and behave differently across the two backends.
function findConsoleCalls(tsMod, program) {
	const sf = program.getSourceFile(file);
	const hits = [];
	if (!sf) return hits;
	(function walk(n) {
		if (n && tsMod.isCallExpression(n)) {
			const expr = n.expression;
			if (expr && tsMod.isPropertyAccessExpression(expr)) {
				const obj = expr.expression;
				if (obj && tsMod.isIdentifier(obj) && obj.text === "console") {
					hits.push({ start: n.pos, end: n.end });
				}
			}
		}
		if (n && n.forEachChild) n.forEachChild(walk);
	})(sf);
	return hits;
}

const napiProgram = ts.createProgram([file], {
	noEmit: true,
	allowImportingTsExtensions: true,
	configFilePath: tsconfig,
});
const napiHits = findConsoleCalls(ts, napiProgram);
check("napi found the console.log call", napiHits.length === 1, JSON.stringify(napiHits));

// Type-check the `console` identifier through the aliased checker.
const checker = napiProgram.getTypeChecker();
let consoleTypeStr = null;
(function walk(n) {
	if (n && ts.isIdentifier(n) && n.text === "console") {
		const t = checker.getTypeAtLocation(n);
		consoleTypeStr = checker.typeToString(t);
	}
	if (n && n.forEachChild) n.forEachChild(walk);
})(napiProgram.getSourceFile(file));
check("napi checker resolved console type", typeof consoleTypeStr === "string" && consoleTypeStr.length > 0, consoleTypeStr);

const napiDiags = napiProgram.getSemanticDiagnostics(file);
check("napi semantic diagnostics array", Array.isArray(napiDiags));
napiProgram.__close();

// ── parity: real-ts Strada path finds the same call ──
const realProgram = tsReal.createProgram([file], {
	noEmit: true,
	allowImportingTsExtensions: true,
	configFilePath: tsconfig,
});
const realHits = findConsoleCalls(tsReal, realProgram);
check("real ts found the same call", realHits.length === 1, JSON.stringify(realHits));
if (napiHits.length && realHits.length) {
	check("hit range matches Strada", napiHits[0].start === realHits[0].start && napiHits[0].end === realHits[0].end,
		`napi=${JSON.stringify(napiHits[0])} strada=${JSON.stringify(realHits[0])}`);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log(failures.length ? `\n${failures.length} FAILED\n- ${failures.join("\n- ")}` : "\nOK");
process.exit(failures.length ? 1 : 0);
