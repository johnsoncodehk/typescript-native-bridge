"use strict";
// Smoke test for typescript-native-bridge as a `typescript` drop-in.
//
//   node test/smoke.js
//
// Writes a self-contained temp fixture, loads it via `ts.createProgram` (the
// real `typescript`-shaped entry point), runs a type query + semantic
// diagnostics in-process through the NAPI bridge, and confirms the package
// works as a standalone drop-in.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ts = require("../src/index.js");

function makeFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnb-smoke-"));
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

const failures = [];
function check(name, cond, detail) {
	if (cond) process.stdout.write(".");
	else {
		failures.push(name + (detail ? ` — ${detail}` : ""));
		process.stdout.write("F");
	}
}

try {
	check("facade marker", ts.__tsNativeBridge__ === true);
	check("SyntaxKind.Identifier is number", typeof ts.SyntaxKind.Identifier === "number");
	check("isIdentifier is function", typeof ts.isIdentifier === "function");
	check("forEachChild is function", typeof ts.forEachChild === "function");
	check("factory object present", !!ts.factory);
	check("createProgram is function", typeof ts.createProgram === "function");

	const { dir, file, tsconfig } = makeFixture();

	const program = ts.createProgram([file], {
		noEmit: true,
		allowImportingTsExtensions: true,
		configFilePath: tsconfig,
	});

	check("program created", !!program);
	const sf = program.getSourceFile(file);
	check("getSourceFile", !!sf);
	check("sourceFile has kind", typeof sf.kind === "number");
	check("sourceFile has forEachChild", typeof sf.forEachChild === "function");

	const checker = program.getTypeChecker();
	check("getTypeChecker", !!checker);

	let consoleNode = null;
	(function walk(n) {
		if (n && ts.isIdentifier(n) && n.getText && n.getText() === "console") {
			consoleNode = n;
		}
		if (n && n.forEachChild) n.forEachChild(walk);
	})(sf);
	check("found console identifier", !!consoleNode);

	if (consoleNode) {
		const type = checker.getTypeAtLocation(consoleNode);
		check("getTypeAtLocation(console) returns type", !!type);
		const sym = checker.getSymbolAtLocation(consoleNode);
		check("getSymbolAtLocation(console) returns symbol", !!sym);
		if (sym) check("symbol.name === 'console'", sym.name === "console", sym && sym.name);
		const typeStr = checker.typeToString(type);
		check("typeToString returns string", typeof typeStr === "string", typeof typeStr);
	}

	const diags = program.getSemanticDiagnostics(file);
	check("getSemanticDiagnostics returns array", Array.isArray(diags), typeof diags);

	const rootNames = program.getRootFileNames();
	check("getRootFileNames", Array.isArray(rootNames) && rootNames.length >= 1);

	const opts = program.getCompilerOptions();
	check("getCompilerOptions", !!opts);

	const sourceFiles = program.getSourceFiles();
	check("getSourceFiles", Array.isArray(sourceFiles) && sourceFiles.length >= 1);

	program.__close();
	fs.rmSync(dir, { recursive: true, force: true });
} catch (err) {
	check("smoke threw", false, err && err.stack ? err.stack : String(err));
}

console.log(failures.length ? `\n${failures.length} FAILED\n- ${failures.join("\n- ")}` : "\nOK");
process.exit(failures.length ? 1 : 0);
