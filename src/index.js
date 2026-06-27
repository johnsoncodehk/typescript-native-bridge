"use strict";
// typescript-native-bridge — a `typescript`-shaped drop-in backed by the
// typescript-go in-process NAPI bridge.
//
// Consumer usage:
//   // package.json
//   "devDependencies": { "typescript": "npm:typescript-native-bridge" }
//
// Then `require('typescript')` / `import * as ts from 'typescript'` returns
// this module: real `typescript` as the base (the package keeps a private
// `typescript` dep for the gap surface — skipTrivia, sys, parseJsonConfigFileContent,
// createSemanticDiagnosticsBuilderProgram, …) with tsgo's enums / type guards /
// walkers overlaid, PLUS a NAPI-backed `createProgram` that returns a tsgo
// program wrapped in the `ts.Program` shape. No module-hijacking: the npm
// alias makes resolution land here naturally.
//
// The transport is the Go c-shared bridge (bridge.dylib) loaded via koffi —
// same in-process path proven in the poc-tsgo harness. Set
// TSSLINT_TSGO_NAPI_LIB to the dylib path (defaults to
// <tsslint>/../typescript-go/poc-napi/bridge.dylib).

const path = require("path");
const { loadTsgoModules } = require("./tsgo-load.js");
const { createInProcessAPI, resolveBridgeLib } = require("./napi-client.js");

// Real `typescript` — the package's own dep. Under the consumer's
// `typescript` alias this still resolves to real ts HERE (the alias only
// affects the consumer's resolution, not this package's internal require).
const ts = require("typescript");

// ── facade ────────────────────────────────────────────────────────────
// Copy every own property of real ts up front (so `__importStar`-style
// consumers that snapshot own-property names see the full surface), then
// overlay tsgo's `/ast` (SyntaxKind, NodeFlags, is* guards, visitor, scanner,
// factory) and `/api/sync` enums (SymbolFlags, TypeFlags, …).

function buildFacade() {
	const { ast, astFactory: factory, sync } = loadTsgoModules();

	const facade = {};
	for (const k of Object.getOwnPropertyNames(ts)) {
		try {
			facade[k] = ts[k];
		} catch {
			// some ts internals throw on access (rare)
		}
	}

	const forEachChild = function (node, cbNode, cbNodes) {
		if (node && typeof node.forEachChild === "function") {
			return node.forEachChild(cbNode, cbNodes);
		}
		return ts.forEachChild(node, cbNode, cbNodes);
	};

	// /ast: enums + is* guards + visitor + scanner + utils. Wrap is* predicates
	// to tolerate falsy input (tsgo's versions crash on undefined; rule code
	// walks node.parent chains that hit undefined).
	for (const k of Object.keys(ast)) {
		const v = ast[k];
		if (typeof v === "function" && /^is[A-Z]/.test(k)) {
			facade[k] = (n, ...rest) => (n ? v(n, ...rest) : false);
		} else {
			facade[k] = v;
		}
	}

	// /api/sync enums not already in /ast.
	for (const k of Object.keys(sync)) {
		const v = sync[k];
		if (typeof v !== "object" || v === null) continue;
		const hasNumeric = Object.values(v).some((x) => typeof x === "number");
		if (!hasNumeric) continue;
		if (k in facade) continue;
		facade[k] = v;
	}

	// /ast/factory: `factory` namespace + createX/updateX helpers.
	if (factory.factory) facade.factory = factory.factory;
	for (const k of Object.keys(factory)) {
		if (k === "factory" || k === "NodeObject") continue;
		if (typeof factory[k] !== "function") continue;
		if (k in facade && !k.startsWith("create")) continue;
		facade[k] = factory[k];
	}

	facade.forEachChild = forEachChild;

	// Scanner: tsgo renamed setTextPos → resetTokenState. Wrap so both names work.
	if (typeof ast.createScanner === "function") {
		const origCreateScanner = ast.createScanner;
		facade.createScanner = function (...args) {
			const scanner = origCreateScanner.apply(null, args);
			if (scanner && typeof scanner.setTextPos !== "function" && typeof scanner.resetTokenState === "function") {
				scanner.setTextPos = scanner.resetTokenState.bind(scanner);
			}
			return scanner;
		};
	}

	facade.__tsNativeBridge__ = true;
	return facade;
}

// ── TypeChecker wrapper ───────────────────────────────────────────────
// tsgo's `Checker` already exposes most of `ts.TypeChecker` (getTypeAtLocation,
// getSymbolAtLocation, getTypeOfSymbol, typeToString, …). Delegate explicitly
// for the common ones and Proxy the rest through, so any method tsgo supports
// just works and any it lacks throws a clear error.

function wrapChecker(tsgoChecker, program) {
	const target = {
		getTypeAtLocation: (node) => tsgoChecker.getTypeAtLocation(node),
		getSymbolAtLocation: (node) => tsgoChecker.getSymbolAtLocation(node),
		getTypeOfSymbol: (sym) => tsgoChecker.getTypeOfSymbol(sym),
		getDeclaredTypeOfSymbol: (sym) => tsgoChecker.getDeclaredTypeOfSymbol(sym),
		getSignaturesOfType: (t, kind) => tsgoChecker.getSignaturesOfType(t, kind),
		typeToString: (t, ...rest) => tsgoChecker.typeToString(t, ...rest),
		getContextualType: (node, ...rest) => tsgoChecker.getContextualType(node, ...rest),
		getResolvedSymbol: (node) => tsgoChecker.getResolvedSymbol(node),
		getNonNullableType: (t) => tsgoChecker.getNonNullableType(t),
		isTypeAssignableTo: (a, b) => tsgoChecker.isTypeAssignableTo(a, b),
		isArrayLikeType: (t) => tsgoChecker.isArrayLikeType(t),
		getAnyType: () => tsgoChecker.getAnyType(),
		getStringType: () => tsgoChecker.getStringType(),
		getNumberType: () => tsgoChecker.getNumberType(),
		getBooleanType: () => tsgoChecker.getBooleanType(),
		getVoidType: () => tsgoChecker.getVoidType(),
		getUndefinedType: () => tsgoChecker.getUndefinedType(),
		getNullType: () => tsgoChecker.getNullType(),
		getNeverType: () => tsgoChecker.getNeverType(),
		getUnknownType: () => tsgoChecker.getUnknownType(),
		getBigIntType: () => tsgoChecker.getBigIntType(),
		getESSymbolType: () => tsgoChecker.getESSymbolType(),
		getIntrinsicType: (kind) => tsgoChecker.getIntrinsicType(kind),
		// ts.TypeChecker uses symbolToString / getFullyQualifiedName; tsgo's
		// Symbol object carries its own `name` — provide string helpers that
		// fall back to the symbol's name field.
		symbolToString: (sym) => (sym && sym.name) ?? "",
		getFullyQualifiedName: (sym) => (sym && sym.name) ?? "",
		// Keep a back-reference for consumers that reach the program via the checker.
		__program: program,
		__tsgoChecker: tsgoChecker,
	};
	return new Proxy(target, {
		get(t, prop) {
			if (prop in t) return t[prop];
			if (typeof prop === "string" && typeof tsgoChecker[prop] === "function") {
				return (...args) => tsgoChecker[prop](...args);
			}
			if (typeof prop === "string" && prop in tsgoChecker) return tsgoChecker[prop];
			return undefined;
		},
		has: (t, p) => p in t || p in tsgoChecker,
	});
}

// ── Program wrapper ────────────────────────────────────────────────────
// tsgo's `project.program` exposes getSourceFile + the diagnostic methods.
// We add the ts.Program shape (getSourceFiles, getRootFileNames,
// getCompilerOptions, getTypeChecker) and Proxy the rest through.

function wrapProgram(tsgoProgram, tsgoProject, api, client, snapshot, rootNames, options) {
	const snapshotId = snapshot && snapshot.id;
	const projectId = tsgoProject && tsgoProject.id;

	let cachedSourceFileNames = null;
	function getSourceFileNames() {
		if (cachedSourceFileNames) return cachedSourceFileNames;
		const names = client.apiRequest("getSourceFileNames", {
			snapshot: snapshotId,
			project: projectId,
		});
		cachedSourceFileNames = names || [];
		return cachedSourceFileNames;
	}

	let cachedCompilerOptions = null;
	function getCompilerOptions() {
		if (cachedCompilerOptions) return cachedCompilerOptions;
		// Prefer the project's parsed options; fall back to the options passed
		// to createProgram. tsgo's Project exposes compilerOptions via the
		// bridge's project response — fetch lazily.
		try {
			const projData = client.apiRequest("getProject", {
				snapshot: snapshotId,
				project: projectId,
			});
			if (projData && projData.options) cachedCompilerOptions = projData.options;
		} catch {
			// ignore
		}
		return cachedCompilerOptions || options || {};
	}

	let checker = null;
	const target = {
		getSourceFile: (fileName) => tsgoProgram.getSourceFile(fileName),
		getSourceFiles: () => getSourceFileNames().map((f) => tsgoProgram.getSourceFile(f)).filter(Boolean),
		getRootFileNames: () => rootNames.slice(),
		getCompilerOptions,
		getTypeChecker: () => (checker || (checker = wrapChecker(tsgoProject.checker, target))),
		getSyntacticDiagnostics: (fileName) => tsgoProgram.getSyntacticDiagnostics(fileName),
		getSemanticDiagnostics: (fileName) => tsgoProgram.getSemanticDiagnostics(fileName),
		getSuggestionDiagnostics: (fileName) => tsgoProgram.getSuggestionDiagnostics(fileName),
		getGlobalDiagnostics: () => tsgoProgram.getGlobalDiagnostics(),
		getProgramDiagnostics: () => tsgoProgram.getProgramDiagnostics(),
		getConfigFileParsingDiagnostics: () => tsgoProgram.getConfigFileParsingDiagnostics(),
		getCurrentDirectory: () => process.cwd(),
		getCommonSourceDirectory: () => "",
		emit: () => ({ diagnostics: [], emitSkipped: true }),
		// Back-references for advanced consumers.
		__tsgoProject: tsgoProject,
		__tsgoProgram: tsgoProgram,
		__api: api,
		__close: () => api.close(),
	};

	return new Proxy(target, {
		get(t, prop) {
			if (prop in t) return t[prop];
			if (typeof prop === "string" && typeof tsgoProgram[prop] === "function") {
				return (...args) => tsgoProgram[prop](...args);
			}
			if (typeof prop === "string" && prop in tsgoProgram) return tsgoProgram[prop];
			return undefined;
		},
		has: (t, p) => p in t || p in tsgoProgram,
	});
}

// ── createProgram ──────────────────────────────────────────────────────
// ts.createProgram(rootNames, options[, host]). Maps to tsgo's tsconfig-driven
// model:
//   - options.configFilePath (a tsconfig) → openProject: <tsconfig>
//   - else → openFiles: rootNames (inferred project)
// The returned Program wraps tsgo's program in the ts.Program shape. The
// bridge session is owned by the program; call program.__close() (or let the
// process exit) to release it.

function createProgram(rootNames, options, _host, _oldProgram) {
	options = options || {};
	rootNames = (rootNames || []).slice();
	const cwd = options.cwd || process.cwd();

	const api = createInProcessAPI(cwd);
	let snapshot, project;

	const configFilePath = options.configFilePath;
	if (configFilePath) {
		snapshot = api.updateSnapshot({ openProject: configFilePath, openFiles: rootNames });
		project = snapshot.getProject(configFilePath);
		if (!project) {
			// Fall back to whichever project loaded.
			const projs = snapshot.getProjects();
			project = projs.find((p) => p.configFileName === configFilePath) || projs[0];
		}
	} else {
		// No tsconfig — drive via openFiles; pick the resulting project.
		snapshot = api.updateSnapshot({ openFiles: rootNames });
		const projs = snapshot.getProjects();
		project = projs[0];
	}

	if (!project) {
		api.close();
		throw new Error("typescript-native-bridge createProgram: no project loaded for the given inputs");
	}

	return wrapProgram(project.program, project, api, api.__client, snapshot, rootNames, options);
}

// ── exports ─────────────────────────────────────────────────────────────
// Build the facade once and overlay the program-creation entry points.

const facade = buildFacade();
facade.createProgram = createProgram;
facade.createGetProgram = undefined; // not supported
facade.resolveBridgeLib = resolveBridgeLib;
// createSemanticDiagnosticsBuilderProgram: tsslint's worker wraps the tsgo
// program in a builder for incremental state. Delegate to real ts's builder —
// it only needs the program's getSourceFile + getSemanticDiagnostics, which
// our wrapper provides.
facade.createSemanticDiagnosticsBuilderProgram = function (program, ...rest) {
	return ts.createSemanticDiagnosticsBuilderProgram(program, ...rest);
};

module.exports = facade;
module.exports.__esModule = true;
module.exports.default = facade;
