"use strict";
// In-process tsgo client backed by the Go c-shared bridge (bridge.dylib) via
// koffi. Replaces tsgo's IPC `Client` with a duck-typed client routing
// `apiRequest` / `apiRequestBinary` to direct in-process function calls — no
// child process, no IPC. The real tsgo `Snapshot`/`Project`/`Program`/`Checker`
// JS classes are constructed with this client, so the whole JS API surface
// (RemoteSourceFile decoding, objectRegistry, sourceFileCache) works unchanged.

const path = require("path");
const fs = require("fs");
const koffi = require("koffi");
const { loadTsgoModules } = require("./tsgo-load.js");

function resolveBridgeLib() {
	const fromEnv = process.env.TSSLINT_TSGO_NAPI_LIB;
	if (fromEnv) return fromEnv;

	// Platform-specific shared-library extension.
	const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
	const libName = `bridge.${ext}`;

	// repoRoot = directory above src/ (the typescript-native-bridge repo root).
	const repoRoot = path.resolve(__dirname, "..");

	// 1. Dev path: the typescript-go submodule checked out at <repo>/typescript-go.
	// Build with: (cd typescript-go/poc-napi && go build -buildmode=c-shared -o bridge.<ext> bridge.go)
	const submodulePath = path.join(repoRoot, "typescript-go", "poc-napi", libName);
	if (fs.existsSync(submodulePath)) return submodulePath;

	// 2. Published path: a platform-specific optional dependency package, e.g.
	//    typescript-native-bridge-darwin-arm64 — resolved from the consumer's
	//    node_modules (walks up from this package's location).
	const platformPkg = `typescript-native-bridge-${process.platform}-${process.arch}`;
	for (let dir = repoRoot; dir !== path.dirname(dir); dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", platformPkg, libName);
		if (fs.existsSync(candidate)) return candidate;
	}

	throw new Error(
		`typescript-native-bridge: bridge shared library (${libName}) not found.\n` +
			`  Set TSSLINT_TSGO_NAPI_LIB to its path, or build it from the typescript-go submodule:\n` +
			`    (cd typescript-go/poc-napi && go build -buildmode=c-shared -o ${libName} bridge.go)\n` +
			`  Expected at: ${submodulePath}`,
	);
}

const lib = koffi.load(resolveBridgeLib());

const BridgeNewSession = lib.func("char *BridgeNewSession(char *cwd)");
const BridgeCall = lib.func("char *BridgeCall(int64_t session, char *method, char *paramsJson)");
const BridgeDisposeSession = lib.func("void BridgeDisposeSession(int64_t session)");

const BridgeBinary = koffi.struct("BridgeBinary", { data: "void *", len: "int64_t" });
const BridgeCallBinary = lib.func(
	"BridgeBinary BridgeCallBinary(int64_t session, char *method, char *paramsJson)",
);

function toCStr(s) {
	return Buffer.from(s + "\0", "utf8");
}

class BridgeError extends Error {
	constructor(message) {
		super(message);
		this.name = "BridgeError";
	}
}

function parseEnvelope(str) {
	if (str == null) throw new BridgeError("bridge returned null");
	const env = JSON.parse(str);
	if (!env.ok) throw new BridgeError(env.error || "unknown bridge error");
	return env.data ?? null;
}

class MiniSourceFileCache {
	constructor() {
		this._map = new Map();
	}
	getRetained(p, snapshotId, projectId) {
		return this._map.get(`${snapshotId}:${projectId}:${p}`);
	}
	set(p, file, _parseOptionsKey, _contentHash, snapshotId, projectId) {
		const key = `${snapshotId}:${projectId}:${p}`;
		if (!this._map.has(key)) this._map.set(key, file);
		return this._map.get(key);
	}
	retainForSnapshot() {}
	releaseSnapshot() {}
	clear() {
		this._map.clear();
	}
	has(p) {
		for (const k of this._map.keys()) if (k.endsWith(":" + p)) return true;
		return false;
	}
}

class InProcessClient {
	constructor(handle) {
		this._handle = handle;
	}
	apiRequest(method, params) {
		const paramsJson = params == null ? null : JSON.stringify(params);
		const str = BridgeCall(
			BigInt(this._handle),
			toCStr(method),
			paramsJson == null ? null : toCStr(paramsJson),
		);
		return parseEnvelope(str);
	}
	apiRequestBinary(method, params) {
		const paramsJson = params == null ? null : JSON.stringify(params);
		const res = BridgeCallBinary(
			BigInt(this._handle),
			toCStr(method),
			paramsJson == null ? null : toCStr(paramsJson),
		);
		const len = Number(res.len);
		if (len <= 0 || res.data == null) return undefined;
		const arr = koffi.decode(res.data, koffi.array("uint8_t", len));
		return Buffer.from(arr);
	}
	echo(payload) {
		return this.apiRequest("echo", payload);
	}
	close() {
		BridgeDisposeSession(BigInt(this._handle));
	}
}

/**
 * Build an API-shaped object whose `updateSnapshot` returns a real tsgo
 * `Snapshot` backed by the in-process bridge.
 */
function createInProcessAPI(cwd) {
	const { sync } = loadTsgoModules();
	const handle = Number(parseEnvelope(BridgeNewSession(toCStr(cwd))));
	const client = new InProcessClient(handle);

	const init = client.apiRequest("initialize", null) || {};
	const useCaseSensitive = !!init.useCaseSensitiveFileNames;
	const toPath = (fileName) =>
		useCaseSensitive ? fileName : fileName.toLowerCase();

	const sourceFileCache = new MiniSourceFileCache();
	const activeSnapshots = new Set();

	const api = {
		updateSnapshot(params) {
			const { openProject, openProjects, ...rest } = params || {};
			const mergedOpenProjects =
				openProject != null
					? [openProject, ...(openProjects || [])]
					: openProjects;
			const wireParams = {
				...rest,
				...(mergedOpenProjects != null ? { openProjects: mergedOpenProjects } : {}),
			};
			const data = client.apiRequest("updateSnapshot", wireParams);
			const onDispose = () => activeSnapshots.delete(snapshot);
			const snapshot = new sync.Snapshot(data, client, sourceFileCache, toPath, onDispose);
			activeSnapshots.add(snapshot);
			return snapshot;
		},
		close() {
			for (const s of Array.from(activeSnapshots)) {
				try { s.dispose(); } catch {}
			}
			activeSnapshots.clear();
			sourceFileCache.clear();
			client.close();
		},
		clearSourceFileCache() {
			sourceFileCache.clear();
		},
		__inProcess: true,
		__client: client,
	};
	return api;
}

module.exports = {
	BridgeError,
	InProcessClient,
	MiniSourceFileCache,
	createInProcessAPI,
	resolveBridgeLib,
};
