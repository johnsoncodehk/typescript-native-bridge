// tsgo checker adapter — backs Program.getTypeChecker() with the typescript-go
// in-process NAPI bridge, while keeping the rest of the tsserver /
// LanguageService / namespace surface intact.
//
// Heavy deps (koffi, vendored native-preview under vendor/) are require()'d on first use.
//
// The adapter builds a tsgo project from the Program's configFilePath,
// then routes checker queries by (fileName, position) — the same file
// content and offsets as the real TS Program (Phase 1: plain .ts, disk
// content === Program content). Type/Symbol objects come from tsgo and
// get prototype-patched to quack like ts.Type / ts.Symbol so rule code
// that reads .flags / .symbol / calls .getSymbol() / .isUnion() etc.
// keeps working.

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

import * as ts from "./_namespaces/ts.js";
import { bindSourceFile } from "./binder.js";
import { createSourceFile } from "./parser.js";
import { SyntaxKind, SymbolFlags, NodeFlags, JSDocParsingMode, ModuleKind, StructureIsReused, type Path, type Program, type TypeChecker } from "./types.js";
import { getBuildInfoText, getTsBuildInfoEmitOutputFilePath } from "./emitter.js";
import { getModeForResolutionAtIndex } from "./program.js";
import { installTsgoBackedSourceFileLoader, inferScriptKind, createSkeletonSourceFile, getTsgoBackedSourceFile } from "./tsgoBackedSourceFile.js";
import { getTnbPackageRoot, isBundledLibPath, isHostLibFile, resolveHostFileName, toHostFileName, toTsgoFileName } from "./tsgoLibPaths.js";

// ── JSDoc provider injection ──
// getDocumentationComment / getJsDocTags need the stock JSDoc parsers in
// services/jsDoc.ts. tsgoChecker is compiled into BOTH the compiler bundle
// (_tsc.js) and the services bundle (typescript.js). If this file imported or
// require()'d services/jsDoc, esbuild would pull the entire services layer into
// _tsc.js, forming a cross-layer import cycle that flips the bundle from a flat
// eager form to lazy __esm wrappers — which makes `sys` lazy and breaks
// consumers (e.g. vue-tsc) that read `sys` at module load. Instead, the services
// bundle injects the parsers at init via tnbSetJsDocProvider; the compiler
// bundle simply never sets one (getDocumentationComment is a Language Service
// feature and is unused on the plain `tsc` path).
//
// No `checker` is threaded into these parsers by design. In stock jsDoc the
// checker is used solely by buildLinkParts to turn a resolvable `{@link X}`
// into a *navigable* link; JSDoc *text* extraction never touches it. Feeding
// the tsgo shim checker into that path buys nothing for our consumers (they
// stringify the parts) while being the one place a partial checker could throw
// and, via a catch, blank an otherwise-valid comment. Omitting it makes
// `{@link X}` render as plain text (fully preserved) and removes the failure
// mode structurally — JSDoc text fidelity no longer depends on the checker.
interface TnbJsDocProvider {
    getComments(decls: readonly any[]): any[];
    getTags(decls: readonly any[] | undefined): any[];
}
let _jsDocProvider: TnbJsDocProvider | undefined;

/** @internal Registered from services.ts so the compiler bundle stays services-free. */
export function tnbSetJsDocProvider(provider: TnbJsDocProvider): void {
    _jsDocProvider = provider;
}

function jsDocCommentsFromDeclarations(decls: readonly any[]): any[] {
    return _jsDocProvider?.getComments(decls) ?? [];
}
function jsDocTagsFromDeclarations(decls: readonly any[] | undefined): any[] {
    return _jsDocProvider?.getTags(decls) ?? [];
}

/** Per-Program host/overlay state — avoids module-level last-writer-wins when tsserver holds multiple projects. */
interface TnbProgramContext {
    lsHost: any;
    overlayHostCtx: { host: any; options: any; configFilePath: string };
    pendingOverlays?: any[];
    pendingExtraFileExtensions?: any[];
    pendingReferencedProjects?: string[];
}
const _programContextByProgram = new WeakMap<object, TnbProgramContext>();

function registerProgramContext(program: object, ctx: TnbProgramContext): TnbProgramContext {
    _programContextByProgram.set(program, ctx);
    return ctx;
}

function getProgramContext(program: object): TnbProgramContext | undefined {
    return _programContextByProgram.get(program);
}

// ── Bridge deps (process-global — lib/typescript.js and lib/_tsc.js each bundle
// their own copy of this module, but koffi.struct() names are process-global) ──
const TNB_BRIDGE_STATE_KEY = Symbol.for("typescript-native-bridge.bridgeState");

type TnbBridgeProcessState = {
    koffi?: any;
    sync?: any;
    bridgeFns?: any;
    client?: any;
    api?: any;
    sourceFileCache?: any;
    useCaseSensitive?: boolean;
    version?: string;
    debugAnnounced?: boolean;
    /** tsgo Project per resolved tsconfig path. Projects are snapshots of the
     * process-wide bridge session, so a per-bundle cache would let the two
     * bundles hold diverging Project snapshots for the same tsconfig. */
    projectCache?: Map<string, any>;
    /** Routing target for the NodeHandle/Symbol/Signature prototype hooks.
     * The native-preview prototypes are process-global (shared require cache),
     * so the project ref those hooks consult must be process-global too. */
    currentProjectRef?: { project: any };
    /** RemoteNode prototype kind getters are wrapped exactly once per process —
     * a second wrap would remap SyntaxKind values twice. */
    kindRemapApplied?: boolean;
    /** NodeHandle.prototype hooks are installed exactly once per process —
     * the prototype is shared across lib/typescript.js and lib/_tsc.js bundles. */
    nodeHandlePatched?: boolean;
    /** RemoteNode.prototype getChildren for LS token walks (findAllReferences/rename). */
    remoteNodeTraversalPatched?: boolean;
    /** SignalExit bypass listeners installed exactly once per process. */
    signalExitBypassInstalled?: boolean;
    /** Host text last pushed to the (process-wide) tsgo session per file. */
    syncedOverlayContentByFile?: Map<string, string>;
    /** Solution-build (tsc -b / vue-tsc -b) active-project tracker. The build
     * orchestrator finishes each project completely before the next program is
     * created, so the previously opened tsgo project can be closed when the
     * next one opens — keeping the tsgo session's open project/file set O(1)
     * instead of O(#projects built so far). */
    buildModeRef?: { active?: TnbActiveBuildProject };
};

/** One solution-build project currently open in the tsgo session. */
type TnbActiveBuildProject = {
    configFilePath: string;
    /** Files opened (with or without content) in tsgo for this project. */
    openedFiles: Set<string>;
    /** Snapshots created while this project was active — released on close. */
    snapshots: any[];
};

function tnbBridgeProcessState(): TnbBridgeProcessState {
    const g = globalThis as any;
    if (!g[TNB_BRIDGE_STATE_KEY]) g[TNB_BRIDGE_STATE_KEY] = {};
    return g[TNB_BRIDGE_STATE_KEY];
}

let _koffi: any;
let _sync: any;
let _bridgeFns: any;
/** Thin program from createTsgoProgram — wired after getOrCreateSourceFile exists. */
let _hostProgramRef: { getSourceFile?: (fileName: string) => any | undefined } | undefined;

/** Vendored @typescript/native-preview at vendor/native-preview/. */
function getNativePreviewDir(): string {
    const path = require("path") as typeof import("path");
    const fs = require("fs") as typeof import("fs");
    const dir = path.join(getTnbPackageRoot(), "vendor", "native-preview");
    const syncApi = path.join(dir, "dist", "api", "sync", "api.js");
    if (!fs.existsSync(syncApi)) {
        throw new Error(
            `tsgoChecker: vendored native-preview not found at ${dir}\n` +
            `  Build it: npm run build:js`,
        );
    }
    return dir;
}

/**
 * Adopt the process-global bridge instances into this bundle's module locals.
 * lib/typescript.js and lib/_tsc.js each carry a copy of this module; whichever
 * copy initializes the bridge first owns the canonical koffi/sync/client, and
 * every other copy must adopt ALL of them — a partial copy leaves _koffi/_sync/
 * _bridgeFns undefined in the second bundle, breaking patchSymbolProto,
 * instanceof checks, and koffi.decode.
 */
function hydrateBridgeModuleLocals(proc: TnbBridgeProcessState): void {
    _koffi = proc.koffi;
    _sync = proc.sync;
    _bridgeFns = proc.bridgeFns;
    if (!proc.client) return;
    _client = proc.client;
    _api = proc.api;
    _sourceFileCache = proc.sourceFileCache;
    _tsgoUseCaseSensitive = proc.useCaseSensitive!;
    _tsgoVersion = proc.version;
    if (proc.debugAnnounced) _tnbDebugAnnounced = true;
}

// ── RPC trace (sync append before each FFI call; TNB_RPC_TRACE=1) ──
let _rpcTraceSeq = 0;
const _rpcTraceLog: string = process.env.TNB_RPC_TRACE === "1"
    ? (process.env.TNB_RPC_TRACE_FILE || "/tmp/tnb-rpc.log")
    : "";
function _rpcTraceEnter(method: string, binary: boolean, session: number): number {
    if (!_rpcTraceLog) return 0;
    const id = ++_rpcTraceSeq;
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(
        _rpcTraceLog,
        `${Date.now()} ENTER ${id} pid=${process.pid} sess=${session} ${binary ? "BIN" : "JSON"} ${method}\n`,
    );
    return id;
}
function _rpcTraceExit(id: number, method: string): void {
    if (!_rpcTraceLog || id === 0) return;
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(_rpcTraceLog, `${Date.now()} EXIT ${id} ${method}\n`);
}

function loadBridgeDeps(): void {
    const proc = tnbBridgeProcessState();
    if (proc.koffi) {
        hydrateBridgeModuleLocals(proc);
        return;
    }
    const path = require("path") as typeof import("path");
    const fs = require("fs") as typeof import("fs");
    _koffi = require("koffi");

    const nativePreviewDir = getNativePreviewDir();
    // sync API is CJS-compatible even though the package is "type": "module".
    _sync = require(path.join(nativePreviewDir, "dist", "api", "sync", "api.js"));

    // Bridge lives at <tnb>/native/bridge.<ext> next to lib/ and vendor/.
    const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
    const libName = `bridge.${ext}`;
    const packageRoot = getTnbPackageRoot();
    const libPath = path.join(packageRoot, "native", libName);
    const devBridge = path.join(packageRoot, "typescript-go", "bridge", libName);
    const resolvedBridge = fs.existsSync(libPath) ? libPath : devBridge;
    if (!fs.existsSync(resolvedBridge)) {
        throw new Error(
            `tsgoChecker: bridge shared library not found (tried ${libPath}, ${devBridge})\n` +
            `  Build it: npm run build:bridge`,
        );
    }
    // The cgo bridge embeds the Go runtime into this Node process. Go's
    // signal-based async preemption (SIGURG) collides with Node's fatal-signal
    // handler: SIGURG gets routed into node::SignalExit -> ResetStdio, which
    // storms tcsetattr/ioctl on a TTY until the CPU is pinned and the process
    // won't even die on SIGTERM. GODEBUG is read by the Go runtime at dlopen,
    // so disable async preemption before _koffi.load arms its signal handler.
    // TNB_SKIP_ASYNC_PREEMPT_OFF=1 disables this guard for hang repro only.
    if (process.env.TNB_SKIP_ASYNC_PREEMPT_OFF !== "1"
        && !/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(process.env.GODEBUG ?? "")) {
        process.env.GODEBUG = process.env.GODEBUG
            ? `${process.env.GODEBUG},asyncpreemptoff=1`
            : "asyncpreemptoff=1";
    }
    const lib = _koffi.load(resolvedBridge);
    _bridgeFns = {
        BridgeNewSession: lib.func("char *BridgeNewSession(char *cwd)"),
        BridgeCall: lib.func("char *BridgeCall(int64_t session, char *method, char *paramsJson)"),
        BridgeDisposeSession: lib.func("void BridgeDisposeSession(int64_t session)"),
        BridgeBinary: _koffi.struct("BridgeBinary", { data: "void *", len: "int64_t" }),
        BridgeCallBinary: lib.func("BridgeBinary BridgeCallBinary(int64_t session, char *method, char *paramsJson)"),
    };
    proc.koffi = _koffi;
    proc.sync = _sync;
    proc.bridgeFns = _bridgeFns;
    // ── SignalExit bypass (test runners only) ──
    // Node's C++ SIGTERM/SIGINT handler (node::SignalExit) runs ResetStdio in
    // signal context; combined with the embedded Go runtime this can spin
    // forever (fstat/fcntl/tcsetattr EINTR storm) and pin an unkillable
    // orphan. Installing a JS listener makes libuv take over the sigaction —
    // its handler only writes to a pipe, deferring all work to the event
    // loop, so ResetStdio never executes in signal context.
    // NOTE: never touch SIGURG from JS — that would replace the Go runtime's
    // own handler.
    if (!proc.signalExitBypassInstalled
        && process.env.TNB_SIGNAL_EXIT_BYPASS !== "0"
        && (process.env.TNB_SIGNAL_EXIT_BYPASS === "1"
            || process.env.VITEST
            || process.env.JEST_WORKER_ID)) {
        proc.signalExitBypassInstalled = true;
        const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
        for (const sig of signals) {
            if (process.listenerCount(sig) === 0) {
                process.on(sig, () => {
                    const n = sig === "SIGHUP" ? 1 : sig === "SIGINT" ? 2 : 15;
                    process.exit(128 + n);
                });
            }
        }
    }
    if (_rpcTraceLog) {
        const fs = require("fs") as typeof import("fs");
        fs.appendFileSync(
            _rpcTraceLog,
            `${Date.now()} BRIDGE_LOAD pid=${process.pid} GODEBUG=${process.env.GODEBUG ?? ""} lib=${resolvedBridge}\n`,
        );
    }
}

/**
 * True only for symbols materialized from tsgo RPC (native-preview Symbol).
 * Stock TS SymbolObject also receives a numeric `.id` from getSymbolId during
 * checker queries (e.g. completion symbol aggregation over globals like
 * defineProps); those ids are NOT tsgo snapshot-registry handles and must not
 * be sent over the bridge.
 */
function isTsgoBridgeSymbol(symbol: any): boolean {
    if (!symbol || typeof symbol.id !== "number" || symbol.id === 0) return false;
    const BridgeSymbol = _sync?.Symbol;
    if (BridgeSymbol && symbol instanceof BridgeSymbol) return true;
    return symbol.objectRegistry != null;
}

// Module-level session pool — one koffi BridgeClient + tsgo API per process,
// shared across all Programs. Projects are cached per tsconfig path.
let _client: any;
let _api: any;
let _sourceFileCache: any;
// Process-global (see TnbBridgeProcessState.projectCache) — both bundles must
// see the same Project snapshot per tsconfig.
const _projectCache: Map<string, any> = tnbBridgeProcessState().projectCache ??= new Map();

function toCStr(s: string): Buffer {
    return Buffer.from(s + "\0", "utf8");
}

function parseBridgeEnvelope(str: string | null): any {
    if (str == null) throw new Error("tsgoChecker: bridge returned null");
    const env = JSON.parse(str);
    if (!env.ok) throw new Error(env.error || "tsgoChecker: unknown bridge error");
    return env.data ?? null;
}

class BridgeClient {
    private handle: number;
    private handleBigInt: bigint;
    private methodCStr = new Map<string, Buffer>();
    private scratch = Buffer.alloc(256);

    constructor(cwd: string) {
        this.handle = Number(parseBridgeEnvelope(_bridgeFns.BridgeNewSession(toCStr(cwd))));
        this.handleBigInt = BigInt(this.handle);
    }

    private toCStrScratch(s: string): Buffer {
        const need = Buffer.byteLength(s, "utf8") + 1;
        if (need > this.scratch.length) {
            this.scratch = Buffer.alloc(need * 2);
        }
        const written = this.scratch.write(s, 0, "utf8");
        this.scratch[written] = 0;
        return this.scratch.subarray(0, need);
    }

    apiRequest(method: string, params: any): any {
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        const paramsJson = params == null ? null : JSON.stringify(params);
        let mc = this.methodCStr.get(method);
        if (!mc) { mc = toCStr(method); this.methodCStr.set(method, mc); }
        const traceId = _rpcTraceEnter(method, false, this.handle);
        const str = _bridgeFns.BridgeCall(
            this.handleBigInt, mc,
            paramsJson == null ? null : this.toCStrScratch(paramsJson),
        );
        _rpcTraceExit(traceId, method);
        const result = parseBridgeEnvelope(str);
        if (process.env.TSGO_PROFILE === "1") _profRpc(method, Date.now() - t0);
        return result;
    }

    apiRequestBinary(method: string, params: any): Uint8Array | undefined {
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        if (method === "getSourceFile") noteGetSourceFileRpc();
        const paramsJson = params == null ? null : JSON.stringify(params);
        let mc = this.methodCStr.get(method);
        if (!mc) { mc = toCStr(method); this.methodCStr.set(method, mc); }
        const traceId = _rpcTraceEnter(method, true, this.handle);
        const res = _bridgeFns.BridgeCallBinary(
            this.handleBigInt, mc,
            paramsJson == null ? null : this.toCStrScratch(paramsJson),
        );
        _rpcTraceExit(traceId, method);
        if (process.env.TSGO_PROFILE === "1") _profRpc(method, Date.now() - t0);
        const len = Number(res.len);
        if (len <= 0 || res.data == null) return undefined;
        return _koffi.decode(res.data, _koffi.array("uint8_t", len, "Typed")) as Uint8Array;
    }

    close(): void {
        try { _bridgeFns.BridgeDisposeSession(BigInt(this.handle)); } catch { /* best-effort */ }
    }
}

class MiniSourceFileCache {
    private bySnap = new Map<any, Map<any, Map<string, any>>>();
    private paths = new Set<string>();
    // Cross-(snapshot, project) reuse for disk-stable declaration files
    // (node_modules + bundled libs), keyed by (path, parse-options key,
    // content hash). Node ids embed only file path + node index, and identical
    // content under identical parse options produces an identical encoded
    // blob, so a decoded RemoteSourceFile is valid in any project that
    // includes the same file version. Multi-project lint/build sessions
    // otherwise re-decode (and re-walk) the same large .d.ts once per project.
    // The hash comes from the just-fetched blob, so a changed file can never
    // hit a stale entry.
    private stableByPath = new Map<string, { key: any; hash: any; file: any }>();

    private static isStableDeclarationPath(p: string): boolean {
        return p.endsWith(".d.ts") && (p.includes("/node_modules/") || p.includes("bundled://") || isBundledLibPath(p));
    }

    getRetained(p: string, snapshotId: any, projectId: any): any {
        let byProj = this.bySnap.get(snapshotId);
        let byPath = byProj?.get(projectId);
        const retained = byPath?.get(p);
        if (retained) return retained;
        // Serve stable declaration files without the getSourceFile RPC.
        // Safe because (a) stableByPath only holds .d.ts paths, whose parse
        // options key is constant — GetExternalModuleIndicatorOptions returns
        // the zero options for declaration file names, so every project
        // produces the same encoded blob for the same content; (b) content
        // changes surface as snapshot change events, which drop the entry
        // (invalidateChangedPaths). Go itself only re-reads a disk file when
        // such an event arrives, so trusting the entry matches what the RPC
        // would return byte-for-byte.
        const stable = this.stableByPath.get(p);
        if (!stable) return undefined;
        if (!byProj) { byProj = new Map(); this.bySnap.set(snapshotId, byProj); }
        if (!byPath) { byPath = new Map(); byProj.set(projectId, byPath); }
        byPath.set(p, stable.file);
        this.paths.add(p);
        return stable.file;
    }

    /** Drop stable entries for files a new snapshot reports as changed/deleted. */
    invalidateChangedPaths(changes: any): void {
        const changedProjects = changes?.changedProjects;
        if (!changedProjects) return;
        for (const projKey of Object.keys(changedProjects)) {
            const c = changedProjects[projKey];
            for (const p of c?.changedFiles ?? []) this.stableByPath.delete(p);
            for (const p of c?.deletedFiles ?? []) this.stableByPath.delete(p);
        }
    }
    set(p: string, file: any, key: any, hash: any, snapshotId: any, projectId: any): any {
        if (hash != null && MiniSourceFileCache.isStableDeclarationPath(p)) {
            const stable = this.stableByPath.get(p);
            if (stable && stable.key === key && stable.hash === hash) {
                file = stable.file;
            } else {
                this.stableByPath.set(p, { key, hash, file });
            }
        }
        let byProj = this.bySnap.get(snapshotId);
        if (!byProj) { byProj = new Map(); this.bySnap.set(snapshotId, byProj); }
        let byPath = byProj.get(projectId);
        if (!byPath) { byPath = new Map(); byProj.set(projectId, byPath); }
        if (!byPath.has(p)) { byPath.set(p, file); this.paths.add(p); }
        return byPath.get(p);
    }
    retainForSnapshot() {}
    releaseSnapshot() {}
    clear() { this.bySnap.clear(); this.paths.clear(); this.stableByPath.clear(); }
    has(p: string) { return this.paths.has(p); }
}

/**
 * Initialize the shared bridge session once per process. Sets _tsgoUseCaseSensitive
 * from bridge initialize() — the authoritative source, because tsgo keys fileInfos
 * with this rule. Must run before any SourceFile path is canonicalized.
 */
function ensureBridgeSession(): void {
    const proc = tnbBridgeProcessState();
    if (proc.client) {
        hydrateBridgeModuleLocals(proc);
        return;
    }
    loadBridgeDeps();
    const cwd = process.cwd();
    _client = new BridgeClient(cwd);
    const init = _client.apiRequest("initialize", null) || {};
    if (!_tnbDebugAnnounced) {
        _tnbDebugAnnounced = true;
        proc.debugAnnounced = true;
        const tty = !!(process.stderr as any).isTTY;
        const c = tty ? "\u001b[32m" : "";
        const off = tty ? "\u001b[0m" : "";
        const text = "\u2705  TNB ACTIVE \u2014 \`typescript\` is the tsgo-backed fork";
        const inner = 57;
        const top = "\u250c" + "\u2500".repeat(inner) + "\u2510";
        const bottom = "\u2514" + "\u2500".repeat(inner) + "\u2518";
        process.stderr.write(
            `\n${c}${top}${off}\n`
            + `${c}\u2502${off}  ${text}  ${c}\u2502${off}\n`
            + `${c}${bottom}${off}\n\n`,
        );
    }
    const useCaseSensitive = !!init.useCaseSensitiveFileNames;
    _tsgoUseCaseSensitive = useCaseSensitive;
    _tsgoVersion = typeof init.version === "string" && init.version ? init.version : undefined;
    const toPath = (f: string) => useCaseSensitive ? f : f.toLowerCase();
    _sourceFileCache = new MiniSourceFileCache();
    _api = {
        updateSnapshot(params: any) {
            const { openProject, openProjects, ...rest } = params || {};
            const merged = openProject != null ? [openProject, ...(openProjects || [])] : openProjects;
            const wireParams = { ...rest, ...(merged != null ? { openProjects: merged } : {}) };
            const data = _client.apiRequest("updateSnapshot", wireParams);
            // Changed/deleted files invalidate the cross-snapshot stable
            // declaration cache (see MiniSourceFileCache.getRetained).
            if (data?.changes) _sourceFileCache.invalidateChangedPaths(data.changes);
            const onDispose = () => {};
            return new _sync.Snapshot(data, _client, _sourceFileCache, toPath, onDispose);
        },
        close() {
            try { _client.close(); } catch {}
            _sourceFileCache.clear();
        },
    };
    proc.client = _client;
    proc.api = _api;
    proc.sourceFileCache = _sourceFileCache;
    proc.useCaseSensitive = _tsgoUseCaseSensitive;
    proc.version = _tsgoVersion;
}

// One-shot banner, printed the first time the tsgo bridge is engaged, so users
// can always tell their tooling is running on the fork. No banner means stock
// `typescript` is in use (the override didn't take effect).
let _tnbDebugAnnounced = false;
// Overlay content collected by createTsgoProgram from the host (before
// ensureProject runs). In thin-createProgram mode, program.getSourceFiles()
// is empty, so ensureProject reads from this instead.
let _pendingOverlays: any[] | undefined;
let _pendingExtraFileExtensions: any[] | undefined;
let _pendingReferencedProjects: string[] | undefined;
/** Last extraFileExtensions sent to tsgo — reused when syncing late host overlays. */
let _lastExtraFileExtensions: any[] | undefined;
/** Host context for incremental overlay sync (Volar virtual TS after createProgram). */
let _overlayHostCtx: { host: any; options: any; configFilePath: string } | undefined;
let _languageServiceHost: any | undefined;
/**
 * True once any host-bound SourceFile has been bound via ensureHostSourceFileBound.
 * Host-bound navigation refinement (resolveHostExportDefaultSymbol /
 * remapSymbolDeclarationsToHost) only changes behavior for host-bound symbols, so
 * when no host-bound file exists (e.g. pure-TS lint via tsslint CLI, where tsgo
 * RemoteSourceFiles are never host-bound) the per-call refinement can be skipped
 * entirely — it would just iterate declarations and bail at getHostSf.
 */
let _hasHostBoundFiles = false;

/** @internal */
export function tnbSetLanguageServiceHost(host: any): void {
    _languageServiceHost = host;
}

/** Host script content for tsgo overlay — LS host SSOT, compilerHost fallback at createProgram. */
function getHostScriptContentForOverlay(fileName: string, options: any, compilerHost?: any) {
    return getHostScriptContent(hostForOverlaySync() ?? compilerHost, fileName, options);
}

function hostForOverlaySync(): any {
    return _languageServiceHost ?? _overlayHostCtx?.host;
}

/** Active checker query depth — skip updateSnapshot while > 0 (avoids LS reentrancy). */
let _checkerQueryDepth = 0;
/** Host text last pushed to tsgo per file — skip redundant updateSnapshot.
 * Process-global: it mirrors the shared tsgo session's overlay state. */
const _syncedOverlayContentByFile: Map<string, string> = tnbBridgeProcessState().syncedOverlayContentByFile ??= new Map();

// Overlay-path cache: only files missing on disk are fed to tsgo as overlays
// (typically Volar virtual documents).
const _overlayDiskExistsCache = new Map<string, boolean>();
// Set once by ensureBridgeSession() from bridge initialize() — the authoritative
// source, because tsgo keys fileInfos with this rule. ensureBridgeSession() runs
// at createTsgoProgram entry, before any SourceFile path is canonicalized.
let _tsgoUseCaseSensitive = true;
// tsgo engine version from bridge initialize(). .tsbuildinfo files are emitted
// by tsgo and stamped with this version (not ts.version), so buildinfo
// currency checks must compare against it.
let _tsgoVersion: string | undefined;

/**
 * The version stamped into .tsbuildinfo files produced by the tsgo bridge.
 * Buildinfo is a tsgo artifact on this fork: tsgo serializes it, and tsgo
 * validates it on read — so the solution builder's up-to-date version check
 * must accept the engine's version, not just ts.version. Lazily boots the
 * bridge session (one-time; a build run creates it anyway).
 *
 * @internal
 */
export function tnbGetTsgoBuildInfoVersion(): string | undefined {
    try {
        ensureBridgeSession();
    } catch {
        return undefined;
    }
    return _tsgoVersion;
}
// Refs set by ensureProject so NodeHandle prototype hooks can route to the
// currently-active project (scope manager reads `declaration.getSourceFile()`
// on tsgo NodeHandles, which need the project to resolve). Process-global:
// the prototype hooks live on shared native-preview prototypes and may have
// been installed by the other bundle's copy of this module.
const _currentProjectRef: { project: any } = tnbBridgeProcessState().currentProjectRef ??= { project: undefined };

// Solution-build active-project tracker (see TnbBridgeProcessState.buildModeRef).
const _buildModeRef: { active?: TnbActiveBuildProject } = tnbBridgeProcessState().buildModeRef ??= {};

/**
 * Close the previously built project in the same updateSnapshot that opens the
 * next one (build mode only). tsc -b builds projects strictly sequentially and
 * never revisits a finished program, so its tsgo project, file refs, overlays,
 * and snapshots can be released as soon as the next project opens. Without
 * this, a 200+-project solution accumulates open projects/files in the shared
 * tsgo session and every subsequent updateSnapshot pays O(#opened so far) for
 * program re-validation, snapshot diffing, and response marshaling.
 *
 * Returns wire params ({ closeProjects, closeFiles }) to merge into the
 * opening updateSnapshot call, plus the stale snapshots to release once the
 * new snapshot has been created.
 */
function beginBuildProject(configFilePath: string): { closeParams: any; staleSnapshots: any[] | undefined } {
    const prev = _buildModeRef.active;
    if (prev && prev.configFilePath === configFilePath) {
        return { closeParams: undefined, staleSnapshots: undefined };
    }
    _buildModeRef.active = { configFilePath, openedFiles: new Set(), snapshots: [] };
    if (!prev) return { closeParams: undefined, staleSnapshots: undefined };
    _projectCache.delete(prev.configFilePath);
    // The overlays are being closed in tsgo — forget the synced-content memo
    // so a later re-push of identical content is not skipped.
    for (const f of prev.openedFiles) _syncedOverlayContentByFile.delete(f);
    return {
        closeParams: {
            closeProjects: [prev.configFilePath],
            ...(prev.openedFiles.size > 0 ? { closeFiles: [...prev.openedFiles] } : {}),
        },
        staleSnapshots: prev.snapshots,
    };
}

/** Track files/snapshots owned by the active build project (no-op outside build mode). */
function trackBuildProjectSnapshot(configFilePath: string, snapshot: any, openedFiles: Iterable<string>): void {
    const active = _buildModeRef.active;
    if (!active || active.configFilePath !== configFilePath) return;
    for (const f of openedFiles) active.openedFiles.add(f);
    active.snapshots.push(snapshot);
}

/** Release snapshots that belonged to a closed build project. */
function releaseStaleBuildSnapshots(staleSnapshots: any[] | undefined): void {
    if (!staleSnapshots) return;
    for (const s of staleSnapshots) {
        try { s.dispose(); } catch { /* already released */ }
    }
}

/** Saved _currentProjectRef.project values during nested checker calls. */
const _activeProjectStack: any[] = [];

function pushActiveProject(p: any): void {
    _activeProjectStack.push(_currentProjectRef.project);
    _currentProjectRef.project = p;
}

function popActiveProject(): void {
    _currentProjectRef.project = _activeProjectStack.pop();
}

// ── Profiling (active only when TSGO_PROFILE=1) ──
const _stats = {
    projectLoadMs: 0,
    projectsLoaded: 0,
    parentSetMs: 0,
    parentSetFiles: 0,
    queryCount: 0,
    queryMs: 0,
    getTypeCount: 0,
    getTypeMs: 0,
    getSymCount: 0,
    getSymMs: 0,
    getSymHitCount: 0,
    getSymRpcCount: 0,
    symPrefetchMs: 0,
    symPrefetchFiles: 0,
    symPrefetchRefs: 0,
    indexBuildMs: 0,
    indexBuildCount: 0,
    rpcCount: 0,
    rpcMs: 0,
    rpcByMethod: new Map<string, { count: number; ms: number }>() as Map<string, { count: number; ms: number }>,
    printed: false,
};
let _tsgoLoadStart = 0;
const _traceSymEnabled = process.env.TSGO_TRACE_SYM === "1";
const _traceSymFile = process.env.TSGO_TRACE_SYM_FILE;
function traceSym(message: string): void {
    if (!_traceSymEnabled) return;
    const line = `[TSGO_TRACE_SYM] ${message}\n`;
    try {
        if (_traceSymFile) {
            const fs = require("fs") as typeof import("fs");
            fs.appendFileSync(_traceSymFile, line, "utf8");
            return;
        }
        process.stderr.write(line);
    } catch {
        // ignore tracing IO errors
    }
}
function traceSymKind(kind: number | undefined): string {
    if (typeof kind !== "number") return "n/a";
    const kindTable = (ts as any)?.["SyntaxKind"];
    const name = kindTable?.[kind];
    return typeof name === "string" ? name : String(kind);
}
function traceSymNodeText(node: any, sf?: any): string {
    try {
        const raw = typeof node?.getText === "function"
            ? node.getText(sf)
            : node?.escapedText ?? node?.text ?? "";
        const text = String(raw).replace(/\s+/g, " ").trim();
        return text.length > 120 ? `${text.slice(0, 120)}...` : text;
    } catch {
        return "";
    }
}
function traceSymSymbol(sym: any): string {
    if (!sym) return "undefined";
    const name = symbolDisplayNameOf(sym) || String(sym?.escapedName ?? sym?.name ?? "");
    const flags = typeof sym?.flags === "number" ? String(sym.flags) : "n/a";
    const id = typeof sym?.id === "number" ? String(sym.id) : "n/a";
    return `${name || "(anonymous)"} flags=${flags} id=${id}`;
}
function ensureSymbolContextualDocCompat(sym: any): any {
    if (!sym || typeof sym !== "object") return sym;
    const hasContextualDoc = typeof sym.getContextualDocumentationComment === "function";
    const hasContextualTags = typeof sym.getContextualJsDocTags === "function";
    if (hasContextualDoc && hasContextualTags) return sym;
    try {
        if (!hasContextualDoc) {
            Object.defineProperty(sym, "getContextualDocumentationComment", {
                configurable: true,
                writable: true,
                value(this: any, context: any) {
                    try {
                        if (typeof this.getDocumentationComment === "function") {
                            const parts = this.getDocumentationComment(context);
                            if (Array.isArray(parts)) return parts;
                        }
                    } catch {
                        // fall through
                    }
                    return [];
                },
            });
        }
        if (!hasContextualTags) {
            Object.defineProperty(sym, "getContextualJsDocTags", {
                configurable: true,
                writable: true,
                value(this: any, context: any) {
                    try {
                        if (typeof this.getJsDocTags === "function") {
                            const tags = this.getJsDocTags(context);
                            if (Array.isArray(tags)) return tags;
                        }
                    } catch {
                        // fall through
                    }
                    return [];
                },
            });
        }
    } catch {
        // non-extensible symbol object; best-effort only
    }
    return sym;
}
function fileExistsOnDisk(fileName: string): boolean {
    let exists = _overlayDiskExistsCache.get(fileName);
    if (exists === undefined) {
        try {
            const fs = require("fs") as typeof import("fs");
            exists = fs.existsSync(fileName);
        } catch {
            exists = false;
        }
        _overlayDiskExistsCache.set(fileName, exists);
    }
    return exists;
}
/** Collect absolute paths for all open LS files — incl. client-only roots not in getScriptFileNames. */
function collectTsgoOpenFileNames(syncHost: any, extra?: Iterable<string>): string[] {
    const names = new Set<string>();
    const add = (fn: string) => {
        if (typeof fn === "string" && fn.length) names.add(resolveHostFileName(fn, syncHost));
    };
    if (extra) {
        for (const fn of extra) add(fn);
    }
    const scriptNames = syncHost?.getScriptFileNames?.();
    if (scriptNames) {
        for (const fn of scriptNames) add(fn);
    }
    const ps = syncHost?.projectService;
    if (ps?.openFiles?.forEach && syncHost.projectService === ps) {
        // tsserver Project — include open client tabs not listed in config roots.
        ps.openFiles.forEach((_root: string, path: string) => {
            const info = ps.getScriptInfoForPath(path);
            if (!info?.isScriptOpen()) return;
            const inProject = info.containingProjects?.includes?.(syncHost);
            const hasSnapshot = !!syncHost.getScriptSnapshot?.(info.fileName);
            if (!inProject && !hasSnapshot) return;
            add(info.fileName);
        });
    }
    return [...names];
}

/** @internal Extend createProgram rootNames with open client files (e.g. unsaved foo.ts). */
export function tnbCollectOpenRootFileNames(host: any): string[] {
    return collectTsgoOpenFileNames(host);
}
function readDiskText(fileName: string): string | undefined {
    try {
        const fs = require("fs") as typeof import("fs");
        return fs.readFileSync(fileName, "utf8");
    } catch {
        return undefined;
    }
}
function isOverlayCandidatePath(fileName: string): boolean {
    if (isBundledLibPath(fileName)) return false;
    return !fileName.includes("/lib.") && !fileName.includes("/node_modules/");
}
/** Resolve tsconfig path for tsgo — relative paths from tsserver use the host cwd. */
function resolveTsconfigPath(configFilePath: string, host?: { getCurrentDirectory?: () => string }): string {
    const path = require("path") as typeof import("path");
    const normalized = configFilePath.replace(/\\/g, "/");
    if (path.isAbsolute(normalized)) {
        return path.normalize(normalized);
    }
    const cwd = host?.getCurrentDirectory?.() ?? process.cwd();
    return path.normalize(path.resolve(cwd, normalized));
}
/** Host script text — prefers getScriptSnapshot (host SSOT) over readFile. */
function getHostScriptContent(host: any, fileName: string, options: any): { text: string; scriptKind: number; fromHost: boolean } | undefined {
    let scriptKind = inferScriptKind(fileName);
    const snap = host?.getScriptSnapshot?.(fileName);
    if (snap) {
        const text = snap.getText(0, snap.getLength());
        scriptKind = resolveLanguageServiceScriptKind(host, fileName, fileName, /*fromHostSnapshot*/ true);
        return { text, scriptKind, fromHost: true };
    }
    const sf = host?.getSourceFile?.(fileName, options.target ?? 99);
    if (sf && typeof sf.text === "string") {
        if (typeof sf.scriptKind === "number") scriptKind = sf.scriptKind;
        else scriptKind = resolveLanguageServiceScriptKind(host, fileName, fileName, /*fromHostSnapshot*/ true);
        return { text: sf.text, scriptKind, fromHost: true };
    }
    const text = host?.readFile?.(fileName);
    if (typeof text === "string") return { text, scriptKind, fromHost: false };
    return undefined;
}

function hostSourceFileOptions(languageVersion: number, _host: any) {
    // Host-parsed AST is only built for Language Service paths (Volar virtual
    // files, component-meta docs, hover/quickinfo). ParseForTypeErrors strips
    // description JSDoc from .ts files (only keeps @see/@link), which makes
    // getJSDocCommentsAndTags / getDocumentationComment return empty.
    return { languageVersion, jsDocParsingMode: JSDocParsingMode.ParseAll };
}

/** Parse host snapshot into a full TS SourceFile for Language Service (safe during LS). */
function sourceFileFromHostSnapshot(host: any, hostFileName: string, requestFileName: string, languageTarget: number): any | undefined {
    const snap = host?.getScriptSnapshot?.(requestFileName) ?? host?.getScriptSnapshot?.(hostFileName);
    if (!snap) return undefined;
    const text = snap.getText(0, snap.getLength());
    if (!text.length) return undefined;
    const scriptKind = resolveLanguageServiceScriptKind(host, requestFileName, hostFileName, /*fromHostSnapshot*/ true);
    const sf = createSourceFile(hostFileName, text, hostSourceFileOptions(languageTarget, host), /*setParentNodes*/ true, scriptKind);
    return attachHostSourceFileMetadata(sf, hostFileName);
}

/** Ensure host SourceFiles expose stable path metadata for LS + module path completion. */
function attachHostSourceFileMetadata(sf: any, hostFileName: string): any {
    const canon = canonicalSourceFilePath(hostFileName);
    sf.fileName = hostFileName;
    sf.originalFileName = hostFileName;
    sf.path = canon as Path;
    sf.resolvedPath = canon as Path;
    if (!sf.imports) sf.imports = [];
    if (!sf.moduleAugmentations) sf.moduleAugmentations = [];
    if (!("version" in sf)) {
        try { Object.defineProperty(sf, "version", { value: "1", writable: true, configurable: true, enumerable: false }); } catch {}
    }
    return sf;
}
function hostHasScriptSnapshot(host: any, requestFileName: string, hostFileName: string): boolean {
    return !!(host?.getScriptSnapshot?.(requestFileName) ?? host?.getScriptSnapshot?.(hostFileName));
}
/** Bind host-parsed SourceFiles for LS (export map, scope) — tsgo skips the TS binder. */
function ensureHostSourceFileBound(sf: any, options: any): void {
    if (!sf || sf.__tnbHostBound) return;
    if (!isOverlayCandidatePath(sf.fileName)) return;
    if (sf.symbol !== undefined) { sf.__tnbHostBound = true; return; }
    try { bindSourceFile(sf, options); } catch { /* best-effort */ }
    sf.__tnbHostBound = true;
}
// A genuine host AST node (stock-parsed + bound) vs a tsgo NodeHandle. Both
// carry a numeric `kind` and a `getSourceFile()` (installNodeHandleHooks patches
// the latter onto NodeHandle.prototype), so presence of those is NOT a reliable
// discriminator. The distinguishing fact is that only host SourceFiles carry the
// `__tnbHostBound` brand (set in ensureHostSourceFileBound); a NodeHandle's
// getSourceFile() returns the tsgo RemoteSourceFile, which is never host-bound.
function isHostSyntaxNode(node: any): boolean {
    if (!node || typeof node.kind !== "number" || typeof node.getSourceFile !== "function") return false;
    try {
        return !!node.getSourceFile()?.__tnbHostBound;
    }
    catch {
        return false;
    }
}
/** Resolve a signature/symbol declaration (host node or tsgo NodeHandle) for JSDoc reads. */
function resolveDocDeclaration(decl: any): any | undefined {
    if (!decl) return undefined;
    if (isHostSyntaxNode(decl)) return decl;
    // tsgo NodeHandle: resolve to a full RemoteNode which exposes .jsDoc/.parent/.kind.
    if (typeof decl.resolve === "function") {
        const project = _currentProjectRef.project;
        try {
            const resolved = project ? decl.resolve(project) : undefined;
            if (resolved) return resolved;
        }
        catch { /* best-effort */ }
    }
    return undefined;
}
// stock getDocumentationComment returns SymbolDisplayPart[]; component-meta only
// concatenates .text via displayPartsToString, so a single "text" part is loss-
// less there. Use the canonical "text" kind (not "") so other consumers that
// switch on part.kind still classify it correctly.
function displayPartsFromDocText(text: string): any[] {
    return text ? [{ kind: "text", text }] : [];
}
/** Map tsgo internal symbol markers to stock display names (ast.EscapeAllInternalSymbolNames). */
function unescapeTsgoSymbolName(name: string): string {
    if (name.length === 0) return name;
    const lead = name.charCodeAt(0);
    // tsgo prefixes internal symbols with lone 0xFE; bridge UTF-8 may surface it as U+FFFD.
    if (lead === 0x00FE || lead === 0xFFFD) return "__" + name.slice(1);
    return name;
}
/** Unescaped display name — uniform over host SymbolObject and bridge Symbol. */
function symbolDisplayNameOf(symbol: any): string {
    if (!symbol) return "";
    const raw = symbol.name ?? symbol.escapedName;
    if (raw == null) return "";
    const name = unescapeTsgoSymbolName(String(raw));
    return (ts as any).unescapeLeadingUnderscores?.(name) ?? name;
}
/** Parent symbol — host symbols hold the object; bridge symbols fetch by handle. */
function symbolParentOf(symbol: any): any {
    if (!symbol) return undefined;
    const parent = symbol.parent;
    if (parent && typeof parent === "object") return parent;
    if (parent != null && typeof symbol.getParent === "function") {
        try { return symbol.getParent(); } catch { return undefined; }
    }
    return undefined;
}
function isReservedExportMemberName(name: string): boolean {
    return name.length >= 2 && name.charCodeAt(0) === 95 /* _ */ && name.charCodeAt(1) === 95 && name.charCodeAt(2) !== 95;
}
function exportMemberKey(symbol: any): string | undefined {
    const key = (symbol?.escapedName ?? symbol?.name) as string | undefined;
    return key && !isReservedExportMemberName(key) ? key : undefined;
}
function collectNamedExportsFromModuleSymbol(moduleSymbol: any): any[] {
    if (!moduleSymbol?.exports) return [];
    const result: any[] = [];
    moduleSymbol.exports.forEach((exported: any, key: string) => {
        if (!key || isReservedExportMemberName(key)) return;
        result.push(exported);
    });
    return result;
}
function moduleSymbolSourceFileName(moduleSymbol: any): string | undefined {
    const decl = moduleSymbol?.declarations?.[0];
    // Only a real module symbol (SourceFile/ModuleDeclaration container) marks its
    // "default" member as the module default export. Any other parent (interface,
    // type literal, object) means the member merely happens to be named "default".
    if (decl?.kind !== SyntaxKind.SourceFile && decl?.kind !== SyntaxKind.ModuleDeclaration) return undefined;
    return decl.getSourceFile?.()?.fileName;
}
function isModuleDefaultExportMemberName(name: string | undefined): boolean {
    return name === "default" || name === "export=";
}
function moduleDefaultExportDeclarationFileName(symbol: any): string | undefined {
    // Fallback when symbol.parent is absent: only ExportAssignment/ExportSpecifier
    // declarations identify a module default export.
    for (const decl of symbol?.declarations ?? []) {
        if (decl.kind === SyntaxKind.ExportAssignment || decl.kind === SyntaxKind.ExportSpecifier) {
            return decl.getSourceFile?.()?.fileName;
        }
    }
    return undefined;
}
function hostDefaultExportSymbolForFile(fileName: string, getHostSf: (fileName: string) => any | undefined): any | undefined {
    const sf = getHostSf(fileName);
    if (!sf) return undefined;
    // Stock checker identity for a module default export is the ExportAssignment
    // symbol (escapedName "default", carries the `export` modifier for
    // getSymbolModifiers). The __VLS_export const is only a span anchor —
    // definition spans are served by hostDefaultExportDefinitionSpan, not here.
    const exp = findHostExportDefaultStatement(sf);
    if (exp?.symbol) return exp.symbol;
    const vlsDecl = findHostVlsExportDeclaration(sf);
    if (vlsDecl?.symbol) return vlsDecl.symbol;
    return undefined;
}
/** Resolve alias chain on host-bound symbols (bindSourceFile), before tsgo RPC. */
function resolveHostAliasedSymbol(symbol: any): any {
    if (!symbol) return symbol;
    if (!(symbol.flags & SymbolFlags.Alias)) return symbol;
    const seen = new Set<any>();
    let current = symbol;
    while (current && (current.flags & SymbolFlags.Alias) && !seen.has(current)) {
        seen.add(current);
        const target = current.target;
        if (!target || target === current) break;
        current = target;
    }
    return current ?? symbol;
}
function symbolDeclarationsAreFileLevelOnly(symbol: any): boolean {
    const decls = symbol?.declarations;
    if (!decls?.length) return false;
    return decls.every((d: any) => d.kind === SyntaxKind.SourceFile || d.kind === SyntaxKind.ModuleDeclaration);
}
function findHostExportDefaultStatement(sf: any): any | undefined {
    if (!sf?.__tnbHostBound) return undefined;
    for (const stmt of sf.statements ?? []) {
        if (stmt.kind === SyntaxKind.ExportAssignment && !stmt.isExportEquals) {
            return stmt;
        }
    }
    return undefined;
}
function findHostVlsExportDeclaration(sf: any): any | undefined {
    if (!sf?.__tnbHostBound) return undefined;
    for (const stmt of sf.statements ?? []) {
        if (stmt.kind !== SyntaxKind.VariableStatement) continue;
        for (const decl of stmt.declarationList?.declarations ?? []) {
            const name = decl.name?.escapedName ?? decl.name?.text;
            if (name === "__VLS_export") return decl;
        }
    }
    return undefined;
}
function isExportDefaultStubExpression(expr: any): boolean {
    return expr?.kind === SyntaxKind.AsExpression
        && expr.expression?.kind === SyntaxKind.ObjectLiteralExpression;
}
/** Anchor node for default export in host-bound virtual snapshot (codegen const or ExportAssignment). */
function findHostDefaultExportAnchor(sf: any): any | undefined {
    const vlsDecl = findHostVlsExportDeclaration(sf);
    if (vlsDecl?.initializer) return vlsDecl.initializer;
    const exp = findHostExportDefaultStatement(sf);
    if (exp) {
        const expr = exp.expression ?? exp;
        if (!isExportDefaultStubExpression(expr)) return expr;
    }
    return undefined;
}
function spanFromHostNode(sf: any, node: any): { start: number; length: number } | undefined {
    if (!node || !sf) return undefined;
    const start = node.getStart?.(sf);
    const end = node.getEnd?.(sf);
    if (typeof start === "number" && typeof end === "number" && end > start) {
        return { start, length: end - start };
    }
    return undefined;
}
function hostDefaultExportDefinitionSpan(sf: any): { start: number; length: number } | undefined {
    if (!sf?.__tnbHostBound) return undefined;
    const vlsDecl = findHostVlsExportDeclaration(sf);
    const exp = findHostExportDefaultStatement(sf);
    if (vlsDecl?.initializer && exp) {
        const start = exp.getStart?.(sf);
        let end = vlsDecl.initializer.getEnd?.(sf);
        const stmt = vlsDecl.parent?.parent;
        if (stmt?.kind === SyntaxKind.VariableStatement) {
            end = Math.max(end ?? 0, stmt.getEnd?.(sf) ?? 0);
        }
        const text = sf.text ?? "";
        while (typeof end === "number" && end < text.length && /[\t \n\r]/.test(text[end])) {
            end++;
        }
        if (typeof start === "number" && typeof end === "number" && end > start) {
            return { start, length: end - start };
        }
    }
    const anchor = findHostDefaultExportAnchor(sf);
    if (anchor) return spanFromHostNode(sf, anchor);
    if (exp) return spanFromHostNode(sf, exp);
    return undefined;
}
/** tsgo module/file symbols → host bindSourceFile default-export symbol. */
function resolveHostExportDefaultSymbol(symbol: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!symbol) return symbol;
    if (symbolDeclarationsAreFileLevelOnly(symbol)) {
        const fileName = symbol.declarations?.[0]?.getSourceFile?.()?.fileName;
        if (fileName) {
            const hostSym = hostDefaultExportSymbolForFile(fileName, getHostSf);
            if (hostSym) return hostSym;
        }
    }
    const memberName = (symbol.escapedName ?? symbol.name) as string | undefined;
    if (isModuleDefaultExportMemberName(memberName)) {
        const fileName = moduleSymbolSourceFileName(symbol.parent)
            ?? moduleDefaultExportDeclarationFileName(symbol);
        if (fileName) {
            const hostSym = hostDefaultExportSymbolForFile(fileName, getHostSf);
            if (hostSym) return hostSym;
        }
    }
    return symbol;
}
function resolveNameOnHostBoundAst(name: string, location: any): any | undefined {
    if (!location || typeof location.getStart !== "function") return undefined;
    const sf = location.getSourceFile?.();
    if (!sf?.__tnbHostBound) return undefined;
    const unescaped = typeof name === "string" && name.charCodeAt(0) === 95 /* _ */
        ? name
        : name;
    if (location.kind === SyntaxKind.Identifier && location.text === unescaped) {
        return getHostBoundSymbolAtLocation(location);
    }
    return undefined;
}
function declarationNeedsHostRemap(decl: any): boolean {
    const sf = decl?.getSourceFile?.();
    return !!(sf && !sf.__tnbHostBound);
}
/** Deepest host-bound AST node containing `pos` (Language Service snapshot coords). */
function findHostNodeAtPosition(sf: any, pos: number): any | undefined {
    if (!sf?.__tnbHostBound || typeof pos !== "number") return undefined;
    let best: any;
    function visit(node: any): void {
        if (pos < node.getStart(sf) || pos >= node.getEnd(sf)) return;
        best = node;
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return best;
}
function findHostNodeAtLineCharacter(hostSf: any, remoteSf: any, pos: number): any | undefined {
    if (!hostSf?.__tnbHostBound || !remoteSf || typeof pos !== "number") return undefined;
    try {
        const { line, character } = remoteSf.getLineAndCharacterOfPosition(pos);
        const hostPos = hostSf.getPositionOfLineAndCharacter(line, character);
        return findHostNodeAtPosition(hostSf, hostPos);
    } catch {
        return undefined;
    }
}
function findHostModuleScopedDeclaration(hostSf: any, escapedName: string): any | undefined {
    if (!hostSf?.__tnbHostBound || !escapedName) return undefined;
    for (const stmt of hostSf.statements ?? []) {
        switch (stmt.kind) {
            case SyntaxKind.VariableStatement:
                for (const decl of stmt.declarationList?.declarations ?? []) {
                    const name = decl.name?.escapedName ?? decl.name?.text;
                    if (name === escapedName) return decl;
                }
                break;
            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.InterfaceDeclaration:
            case SyntaxKind.TypeAliasDeclaration:
            case SyntaxKind.EnumDeclaration:
                if ((stmt.name?.escapedName ?? stmt.name?.text) === escapedName) return stmt;
                break;
            case SyntaxKind.ExportDeclaration:
                for (const el of stmt.exportClause?.elements ?? []) {
                    const name = el.name?.escapedName ?? el.name?.text;
                    if (name === escapedName) return el;
                }
                break;
        }
    }
    return undefined;
}
function symbolMatchesMeaning(symbol: any, meaning: number): boolean {
    if (!symbol || !meaning) return false;
    const exportFlags = symbol.exportSymbol?.flags ?? 0;
    return (((symbol.flags ?? 0) | exportFlags) & meaning) !== 0;
}
function copyScopeSymbolsFromTable(table: any, meaning: number, out: Map<string, any>): void {
    if (!table) return;
    const add = (sym: any) => {
        if (!symbolMatchesMeaning(sym, meaning)) return;
        const id = sym.escapedName ?? sym.name;
        if (id && !out.has(String(id))) out.set(String(id), sym);
    };
    if (typeof table.forEach === "function") {
        table.forEach((sym: any) => add(sym));
        return;
    }
    if (typeof table.values === "function") {
        for (const sym of table.values()) add(sym);
    }
}
/**
 * bindSourceFile locals/exports walk for Volar host-only virtual files
 * (__tnbHostBound), which tsgo has no mirror of. Real files go through the
 * getSymbolsInScope RPC instead.
 */
function getHostSymbolsInScope(location: any, meaning: number): any[] {
    if (!location?.getSourceFile?.()?.__tnbHostBound) return [];
    if (location.flags & NodeFlags.InWithStatement) return [];
    const symbols = new Map<string, any>();
    let node = location;
    while (node) {
        if (node.locals) {
            copyScopeSymbolsFromTable(node.locals, meaning, symbols);
        }
        switch (node.kind) {
            case SyntaxKind.SourceFile: {
                const sf = node;
                if (sf.externalModuleIndicator || sf.commonJsModuleIndicator) {
                    copyScopeSymbolsFromTable(sf.symbol?.exports, meaning, symbols);
                }
                break;
            }
            case SyntaxKind.ModuleDeclaration:
                copyScopeSymbolsFromTable(node.symbol?.exports, meaning, symbols);
                break;
            case SyntaxKind.EnumDeclaration:
                copyScopeSymbolsFromTable(node.symbol?.exports, meaning & SymbolFlags.EnumMember, symbols);
                break;
        }
        node = node.parent;
    }
    symbols.delete("this");
    return [...symbols.values()];
}
/** Lexical resolve on host-bound AST (mirrors checker.resolveEntityName for LS paths). */
function resolveEntityNameOnHostBoundAst(name: string, location: any, meaning: number): any | undefined {
    if (!location?.getSourceFile?.()?.__tnbHostBound || !name) return undefined;
    const escaped = String(name);
    let fallback: any;
    for (const sym of getHostSymbolsInScope(location, meaning)) {
        if (String(sym.escapedName ?? sym.name) !== escaped) continue;
        const isValueLocal = !!(sym.flags & (SymbolFlags.FunctionScopedVariable | SymbolFlags.BlockScopedVariable));
        if (isValueLocal) return sym;
        if (!fallback) fallback = sym;
    }
    return fallback;
}
function symbolFromHostDeclarationNode(decl: any): any | undefined {
    if (!decl?.getSourceFile?.()?.__tnbHostBound) return undefined;
    switch (decl.kind) {
        case SyntaxKind.VariableDeclaration:
        case SyntaxKind.FunctionDeclaration:
        case SyntaxKind.ClassDeclaration:
        case SyntaxKind.Parameter:
        case SyntaxKind.PropertyDeclaration:
        case SyntaxKind.MethodDeclaration:
        case SyntaxKind.EnumMember:
        case SyntaxKind.PropertyAssignment:
        case SyntaxKind.ShorthandPropertyAssignment:
        case SyntaxKind.BindingElement:
            return decl.symbol;
        case SyntaxKind.ImportSpecifier:
        case SyntaxKind.ExportSpecifier:
            if (decl.name) return getHostBoundSymbolAtLocation(decl.name);
            break;
    }
    if (decl.name?.kind === SyntaxKind.Identifier) {
        return getHostBoundSymbolAtLocation(decl.name);
    }
    return decl.symbol;
}
/** findAllReferences/rename compare symbols with ===; return host binder SymbolObject when possible. */
function canonicalizeSymbolToHostIdentity(symbol: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!symbol || !isTsgoBridgeSymbol(symbol)) return symbol;
    // Property/type symbols keep tsgo identity (rename displayName from checker).
    const localFlags = SymbolFlags.FunctionScopedVariable | SymbolFlags.BlockScopedVariable | SymbolFlags.Alias;
    if (!((symbol.flags ?? 0) & localFlags)) return symbol;
    let decl: any;
    try { decl = symbol.valueDeclaration ?? symbol.declarations?.[0]; } catch { return symbol; }
    if (!decl) return symbol;
    const hostDecl = remapDeclarationToHost(decl, getHostSf);
    const hostSym = symbolFromHostDeclarationNode(hostDecl);
    return hostSym ?? symbol;
}
function remapDeclarationToHost(decl: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!decl || !declarationNeedsHostRemap(decl)) return decl;
    if (decl.kind === SyntaxKind.SourceFile) {
        return getHostSf(decl.fileName) ?? decl;
    }
    const remoteSf = decl.getSourceFile?.();
    const fileName = remoteSf?.fileName;
    if (!fileName) return decl;
    const hostSf = getHostSf(fileName);
    if (!hostSf) return decl;
    const pos = decl.getStart?.(remoteSf);
    let hostNode = typeof pos === "number" ? findHostNodeAtPosition(hostSf, pos) : undefined;
    if (!hostNode && typeof pos === "number") {
        hostNode = findHostNodeAtLineCharacter(hostSf, remoteSf, pos);
    }
    if (!hostNode) {
        const name = decl.symbol?.escapedName ?? decl.symbol?.name
            ?? decl.name?.escapedName ?? decl.name?.text;
        if (name) hostNode = findHostModuleScopedDeclaration(hostSf, String(name));
    }
    if (!hostNode) return decl;
    if (hostNode.kind === SyntaxKind.Identifier && hostNode.parent?.symbol?.declarations) {
        const parent = hostNode.parent;
        if (parent.name === hostNode || parent.propertyName === hostNode) {
            return parent;
        }
    }
    return hostNode;
}
/** tsgo RemoteSourceFile declarations → host bindSourceFile nodes for LS navigation. */
function remapSymbolDeclarationsToHost(symbol: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!symbol) return symbol;
    // Hydrate bridge symbols; findAllReferences/rename read valueDeclaration on the
    // shorthand-property fallback path even when declarations[] is empty.
    let valDecl: any;
    try { valDecl = symbol.valueDeclaration; } catch { valDecl = undefined; }
    if (valDecl) {
        const mappedVal = remapDeclarationToHost(valDecl, getHostSf);
        if (mappedVal !== valDecl) {
            try { symbol.valueDeclaration = mappedVal; }
            catch {
                try {
                    Object.defineProperty(symbol, "valueDeclaration", {
                        configurable: true,
                        enumerable: true,
                        get() { return mappedVal; },
                    });
                } catch { /* read-only symbol object */ }
            }
        }
    }
    let decls: readonly any[];
    try { decls = symbol.declarations; } catch { return symbol; }
    if (!decls?.length) return symbol;
    let changed = false;
    const mapped = symbol.declarations.map((decl: any) => {
        const next = remapDeclarationToHost(decl, getHostSf);
        if (_traceSymEnabled) {
            traceSym(
                `remapSymbolDeclarationsToHost sym=${traceSymSymbol(symbol)} declKind=${traceSymKind(decl?.kind)} `
                + `declFile=${decl?.getSourceFile?.()?.fileName} mapped=${next !== decl} `
                + `nextKind=${traceSymKind(next?.kind)} nextHostBound=${!!next?.getSourceFile?.()?.__tnbHostBound}`,
            );
        }
        if (next !== decl) changed = true;
        return next;
    });
    if (!changed) return symbol;
    try {
        symbol.declarations = mapped;
    } catch {
        // tsgo symbol objects may be read-only; best-effort only.
    }
    try {
        if (symbol.declarations !== mapped) {
            Object.defineProperty(symbol, "declarations", {
                configurable: true,
                enumerable: true,
                get() { return mapped; },
            });
        }
    } catch {
        // read-only symbol object; best-effort only.
    }
    return symbol;
}
function refineHostNavigationSymbol(symbol: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!symbol) return symbol;
    let refined = resolveHostExportDefaultSymbol(symbol, getHostSf);
    refined = remapSymbolDeclarationsToHost(refined, getHostSf);
    refined = canonicalizeSymbolToHostIdentity(refined, getHostSf);
    return refined;
}
function isCrossFileImportExportName(node: any): boolean {
    const parent = node?.parent;
    if (!parent) return false;
    return (
        (parent.kind === SyntaxKind.ImportSpecifier && parent.name === node)
        || (parent.kind === SyntaxKind.ExportSpecifier && parent.name === node)
        || (parent.kind === SyntaxKind.ImportClause && parent.name === node)
    );
}
/** Host file-reference definitions: span in virtual snapshot for Volar position mappers. */
export function tnbDefinitionSpanForHostFileReference(targetFile: any): { start: number; length: number } | undefined {
    return hostDefaultExportDefinitionSpan(targetFile);
}
/** Host-bound declaration → virtual snapshot span (e.g. __VLS_export initializer). */
export function tnbHostExportDefinitionTextSpan(declaration: any): { start: number; length: number } | undefined {
    if (!declaration) return undefined;
    const sf = declaration.getSourceFile?.();
    if (!sf?.__tnbHostBound) return undefined;
    const combined = hostDefaultExportDefinitionSpan(sf);
    if (combined) return combined;
    if (declaration.kind === SyntaxKind.SourceFile) {
        return tnbDefinitionSpanForHostFileReference(sf);
    }
    if (declaration.kind === SyntaxKind.ExportAssignment && !declaration.isExportEquals) {
        return spanFromHostNode(sf, declaration);
    }
    return undefined;
}
/** Symbol from host-bound AST when tsgo position RPC misses (LS path). */
function getHostBoundSymbolAtLocation(node: any): any | undefined {
    const sf = node?.getSourceFile?.();
    if (!sf?.__tnbHostBound) return undefined;
    const parent = node.parent;
    if (parent) {
        switch (parent.kind) {
            case SyntaxKind.ImportSpecifier:
            case SyntaxKind.ExportSpecifier:
            case SyntaxKind.ImportClause:
            case SyntaxKind.BindingElement:
            case SyntaxKind.VariableDeclaration:
            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.TypeParameter:
            case SyntaxKind.Parameter:
            case SyntaxKind.PropertyDeclaration:
            case SyntaxKind.MethodDeclaration:
            case SyntaxKind.PropertyAssignment:
            case SyntaxKind.ShorthandPropertyAssignment:
                // BindingElement propertyName (`{ prop: local }`): stock
                // getSymbolAtLocation resolves the *property* symbol of the
                // destructured type, not the local binding. The host binder only
                // has the local (`parent.symbol`); defer to the tsgo RPC path.
                if (parent.kind === SyntaxKind.BindingElement && parent.propertyName === node) {
                    if (_traceSymEnabled) {
                        traceSym(
                            `getHostBoundSymbolAtLocation binding-element-propertyName defer-to-rpc `
                            + `nodeText=${JSON.stringify(traceSymNodeText(node, sf))}`,
                        );
                    }
                    return undefined;
                }
                if (parent.name === node || parent.propertyName === node) {
                    return ensureSymbolContextualDocCompat(parent.symbol ?? node.symbol);
                }
                break;
            case SyntaxKind.PropertyAccessExpression:
                if (parent.name === node) return ensureSymbolContextualDocCompat(parent.symbol);
                break;
            case SyntaxKind.ElementAccessExpression:
                if (parent.argumentExpression === node) return ensureSymbolContextualDocCompat(parent.symbol);
                break;
            case SyntaxKind.EnumMember:
                if (parent.name === node) return ensureSymbolContextualDocCompat(parent.symbol);
                break;
        }
    }
    return ensureSymbolContextualDocCompat(node.symbol);
}
/** ScriptKind for LS parse — host.getScriptKind is SSOT for snapshot overlays. */
function resolveLanguageServiceScriptKind(
    host: any,
    requestFileName: string,
    hostFileName: string,
    fromHostSnapshot = false,
): number {
    const fromHost = host?.getScriptKind?.(requestFileName) ?? host?.getScriptKind?.(hostFileName);
    if (fromHost === ts.ScriptKind.TS || fromHost === ts.ScriptKind.TSX
        || fromHost === ts.ScriptKind.JS || fromHost === ts.ScriptKind.JSX) {
        return fromHost;
    }
    if (fromHostSnapshot) {
        // Snapshot text is embedded TS; host may report Unknown/Deferred for .vue paths.
        return ts.ScriptKind.TS;
    }
    return inferScriptKind(hostFileName);
}
/** Overlay when host snapshot text differs from disk (or file is absent on disk). */
function shouldSendHostOverlay(fileName: string, hostText: string): boolean {
    if (!isOverlayCandidatePath(fileName)) return false;
    if (!fileExistsOnDisk(fileName)) return true;
    const disk = readDiskText(fileName);
    return disk !== hostText;
}
function convertTsgoDiagnostic(d: any, getSourceFile: (fileName: string) => any): any {
    return {
        file: d.fileName ? getSourceFile(toHostFileName(d.fileName)) : undefined,
        start: d.pos,
        length: (d.end ?? d.pos) - d.pos,
        messageText: d.text,
        category: d.category,
        code: d.code,
        reportsUnnecessary: d.reportsUnnecessary,
        reportsDeprecated: d.reportsDeprecated,
        relatedInformation: d.relatedInformation?.map((r: any) => convertTsgoDiagnostic(r, getSourceFile)),
    };
}
function mapTsgoDiagnostics(raw: readonly any[] | undefined, getSourceFile: (fileName: string) => any): readonly any[] {
    if (!raw?.length) return [];
    return raw.map(d => convertTsgoDiagnostic(d, getSourceFile));
}
const BUILTIN_SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
/** True for files whose extension needs host (Volar) virtual content (.vue, .mdx, …). */
function isExtraExtensionFileName(fileName: string): boolean {
    const dot = fileName.lastIndexOf(".");
    if (dot < 0) return false;
    return !BUILTIN_SCRIPT_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}
/** Extra extensions for tsgo when the project contains non-TS root files (.vue, …). */
function collectExtraFileExtensions(fileNames: Iterable<string>, options: any): any[] | undefined {
    // Explicit opt-out in tsconfig must be respected (tsgo mirrors this).
    if (options?.allowArbitraryExtensions === false) return undefined;
    const builtin = BUILTIN_SCRIPT_EXTENSIONS;
    const exts = new Set<string>();
    for (const fn of fileNames) {
        if (typeof fn !== "string") continue;
        const dot = fn.lastIndexOf(".");
        if (dot < 0) continue;
        const ext = fn.slice(dot).toLowerCase();
        if (!builtin.has(ext)) exts.add(ext);
    }
    if (!exts.size) return undefined;
    // ScriptKind.Deferred — include extension in all project contexts.
    return [...exts].map(extension => ({ extension, scriptKind: 7 }));
}
function _profRpc(method: string, ms: number): void {
    if (process.env.TSGO_PROFILE !== "1") return;
    _stats.rpcCount++;
    _stats.rpcMs += ms;
    let b = _stats.rpcByMethod.get(method);
    if (!b) { b = { count: 0, ms: 0 }; _stats.rpcByMethod.set(method, b); }
    b.count++;
    b.ms += ms;
}
function _maybePrintStats(): void {
    if (_stats.printed) return;
    _stats.printed = true;
    const topRpc = [..._stats.rpcByMethod.entries()]
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 5)
        .map(([m, v]) => `${m}=${v.count}/${v.ms.toFixed(0)}ms`)
        .join(" ");
    process.stderr.write(
        `[tsgo-profile] projectsLoaded=${_stats.projectsLoaded} projectLoadMs=${_stats.projectLoadMs}` +
        ` parentSet=${_stats.parentSetFiles}/${_stats.parentSetMs.toFixed(0)}ms` +
        ` symPrefetch=${_stats.symPrefetchFiles}/${_stats.symPrefetchRefs}refs/${_stats.symPrefetchMs.toFixed(0)}ms` +
        ` queries=${_stats.queryCount} queryMs=${_stats.queryMs.toFixed(0)}` +
        ` getType=${_stats.getTypeCount}/${_stats.getTypeMs.toFixed(0)}ms` +
        ` getSym=${_stats.getSymCount}/${_stats.getSymMs.toFixed(0)}ms` +
        ` symHit=${_stats.getSymHitCount} symRpc=${_stats.getSymRpcCount}` +
        ` indexBuild=${_stats.indexBuildCount}/${_stats.indexBuildMs.toFixed(0)}ms` +
        ` rpc=${_stats.rpcCount}/${_stats.rpcMs.toFixed(0)}ms` +
        ` getSourceFileRpc=${_guardStats.getSourceFileRpcCount}` +
        (topRpc ? ` topRpc={${topRpc}}` : "") +
        `\n`,
    );
}
if (process.env.TSGO_PROFILE === "1") {
    process.on("exit", _maybePrintStats);
}

/** @internal — read profiling counters for fork-perf-bench harness. */
export function getTsgoProfileStats(): Readonly<typeof _stats> {
    return _stats;
}

// ── getSourceFile RPC regression guard + tsgo toPath canonicalization ──
// A single logical file can be materialized several ways (host / light /
// diagnostic / full / tsgo-backed). They must agree on the canonical program
// path key, because BuilderState fileInfos is keyed by it. We guarantee that
// structurally rather than by runtime cross-checking: every materialization is
// fed the same resolveHostFileName-normalized host name, and its path is derived
// through canonicalSourceFilePath (which mirrors tsgo's toPath EXACTLY). See the
// _tsgoUseCaseSensitive comment above for why the key rule must match tsgo.
//
// The one thing worth guarding at runtime is the getSourceFile RPC count: the
// light-stub path exists to avoid eagerly materializing tsgo-backed SFs for
// every program file, so a regression there shows up as an RPC spike. CI checks
// it against a baseline (tools/check-sourcefile-guard.mjs).

const _guardStats = {
    getSourceFileRpcCount: 0,
};

/**
 * Canonical program path key — mirrors tsgo client `toPath` from initialize()
 * EXACTLY: case-fold only when the host is case-insensitive, no normalization.
 * tsgo keys MiniSourceFileCache / fileInfos with this rule; adding normalize()
 * here would diverge from tsgo. Callers MUST pass a resolveHostFileName-
 * normalized (absolute, forward-slash) host name so the key is format-stable
 * across every materialization of the same logical file.
 */
function canonicalSourceFilePath(filePath: string): string {
    return _tsgoUseCaseSensitive ? filePath : filePath.toLowerCase();
}

function noteGetSourceFileRpc(): void {
    _guardStats.getSourceFileRpcCount++;
    scheduleGuardStatsFlush();
}

function maybeWriteGuardStatsFile(): void {
    const out = process.env.TNB_GUARD_STATS_FILE;
    if (!out) return;
    try {
        const fs = require("fs") as typeof import("fs");
        fs.writeFileSync(out, JSON.stringify({
            getSourceFileRpcCount: _guardStats.getSourceFileRpcCount,
        }));
    }
    catch { /* best-effort */ }
}

let _guardStatsFlushScheduled = false;
function scheduleGuardStatsFlush(): void {
    if (!process.env.TNB_GUARD_STATS_FILE || _guardStatsFlushScheduled) return;
    _guardStatsFlushScheduled = true;
    setImmediate(() => {
        _guardStatsFlushScheduled = false;
        maybeWriteGuardStatsFile();
    });
}

if (process.env.TNB_GUARD_STATS_FILE) {
    process.on("exit", maybeWriteGuardStatsFile);
    process.on("beforeExit", maybeWriteGuardStatsFile);
}

// ── Enum remapping: tsgo enum values → fork enum values, generated BY NAME ──
// The fork and tsgo enums (SyntaxKind, NodeFlags, ObjectFlags, …) assign
// DIFFERENT numeric values to most members. Any raw tsgo value handed to JS
// consumers (typescript-estree / @typescript-eslint rules) without translation
// is silently wrong. Rather than hand-maintained numeric tables, every
// tsgo→fork map below is DERIVED AT RUNTIME from the two enum definitions,
// matched by member name. This has three properties we want:
//   • identical enums produce an identity map automatically — the no-op case
//     needs no special-casing (e.g. ModifierFlags is left untouched);
//   • a submodule bump that shifts values is absorbed with zero code edits;
//   • the tools/check-enum-remap.mjs CI guard asserts the boundary stays
//     complete (divergent + exposed enums must be remapped here or exempt).
//
// Sources at runtime:
//   • fork enums — the runtime enum objects on the `ts` namespace. The fork
//     compiles with preserveConstEnums, so SyntaxKind/NodeFlags/ObjectFlags
//     exist as name→value objects (the same objects Debug.format* reads);
//   • tsgo enums — the native-preview generated enum modules (dist/enums/*).

// Lazily-required tsgo enum objects (native-preview dist). Resolved from the
// vendored copy under vendor/native-preview/.
let _tsgoEnums: { SyntaxKind: any; NodeFlags: any; ObjectFlags: any } | undefined;
function loadTsgoEnums(): { SyntaxKind: any; NodeFlags: any; ObjectFlags: any } {
    if (_tsgoEnums) return _tsgoEnums;
    const path = require("path") as typeof import("path");
    const enumsDir = path.join(getNativePreviewDir(), "dist", "enums");
    const load = (file: string, name: string) => require(path.join(enumsDir, file))[name];
    _tsgoEnums = {
        SyntaxKind: load("syntaxKind.js", "SyntaxKind"),
        NodeFlags: load("nodeFlags.js", "NodeFlags"),
        ObjectFlags: load("objectFlags.js", "ObjectFlags"),
    };
    return _tsgoEnums;
}

// Forward (name→value) numeric entries of a runtime enum object, in declaration
// order. A transpiled numeric enum also carries reverse (value→name) entries;
// the `typeof v === "number"` filter keeps only the forward ones, and
// non-integer string keys preserve insertion (declaration) order, so the FIRST
// name seen for a value is the canonical member.
function enumForwardEntries(enumObj: any): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    if (!enumObj) return out;
    for (const name in enumObj) {
        const v = enumObj[name];
        if (typeof v === "number") out.push([name, v]);
    }
    return out;
}

const _isPow2 = (v: number): boolean => v !== 0 && (v & (v - 1)) === 0;

// Build a scalar tsgo→fork value map by member name. First name wins per tsgo
// value, so a canonical kind (declared first) beats trailing marker aliases
// (FirstX/LastX) that reuse the same value. Identity entries are omitted, so
// the map is empty for an identical enum and remapKind becomes a pass-through.
function buildScalarRemapByName(tsgoEnum: any, forkEnum: any): Map<number, number> {
    const remap = new Map<number, number>();
    const seen = new Set<number>();
    for (const [name, tsgoVal] of enumForwardEntries(tsgoEnum)) {
        if (seen.has(tsgoVal)) continue;
        seen.add(tsgoVal);
        const forkVal = forkEnum?.[name];
        if (typeof forkVal === "number" && forkVal !== tsgoVal) remap.set(tsgoVal, forkVal);
    }
    return remap;
}

// Build [tsgoBit, forkBit] pairs for single-bit flags present (by name) in BOTH
// enums. First name wins per tsgo bit, so the canonical flag beats later
// aliases that repurpose the same bit (e.g. NodeFlags.OptionalChain over the
// trailing NestedNamespace alias). tsgo-only bits (no fork member of that name)
// are dropped so they don't light up an unrelated fork bit; identical enums
// yield identity-only pairs, making remapFlagsByPairs a no-op.
function buildFlagPairsByName(tsgoEnum: any, forkEnum: any): Array<[number, number]> {
    const pairs: Array<[number, number]> = [];
    const seen = new Set<number>();
    for (const [name, tsgoVal] of enumForwardEntries(tsgoEnum)) {
        if (!_isPow2(tsgoVal) || seen.has(tsgoVal)) continue;
        seen.add(tsgoVal);
        const forkVal = forkEnum?.[name];
        if (typeof forkVal === "number" && _isPow2(forkVal)) pairs.push([tsgoVal, forkVal]);
    }
    return pairs;
}

function remapFlagsByPairs(tsgoFlags: number, pairs: ReadonlyArray<readonly [number, number]>): number {
    let out = 0;
    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        if (tsgoFlags & pair[0]) out |= pair[1];
    }
    return out;
}

// ── SyntaxKind remap (tsgo → fork), by member name ──
// `node.kind` (and the scalar SyntaxKind token getters operator/token/…) are
// read straight off the tsgo blob as RAW tsgo kinds; estree/`ts.isXxx`
// type-guards compare against fork kind values. The fork has extra kinds that
// shift later values, so the maps differ by ~200 members — all derived here.
let _kindRemap: Map<number, number> | undefined;

function buildKindRemap(): Map<number, number> {
    const tsgo = loadTsgoEnums();
    return buildScalarRemapByName(tsgo.SyntaxKind, (ts as any).SyntaxKind);
}

function remapKind(tsgoKind: number): number {
    if (!_kindRemap) return tsgoKind;
    return _kindRemap.get(tsgoKind) ?? tsgoKind;
}

// ── NodeFlags remap (tsgo bit layout → fork bit layout), by member name ──
// `node.flags` is read off the binary blob and consumed by estree
// (OptionalChain) and rules (Ambient/AwaitContext/…), compared against fork
// `ts.NodeFlags.*`. The bit layouts diverge (e.g. tsgo OptionalChain bit5 vs
// fork bit6, tsgo Ambient bit23 vs fork bit25), so the per-bit map is derived
// by name. Distinct flags values are few, so a memo keeps the per-read cost to
// one Map lookup.
let _nodeFlagsPairs: ReadonlyArray<readonly [number, number]> | undefined;
const _nodeFlagsRemapCache = new Map<number, number>();

function nodeFlagsPairs(): ReadonlyArray<readonly [number, number]> {
    if (!_nodeFlagsPairs) {
        const tsgo = loadTsgoEnums();
        _nodeFlagsPairs = buildFlagPairsByName(tsgo.NodeFlags, (ts as any).NodeFlags);
    }
    return _nodeFlagsPairs;
}

function remapNodeFlags(tsgoFlags: number): number {
    if (!tsgoFlags) return 0;
    const cached = _nodeFlagsRemapCache.get(tsgoFlags);
    if (cached !== undefined) return cached;
    const out = remapFlagsByPairs(tsgoFlags, nodeFlagsPairs());
    _nodeFlagsRemapCache.set(tsgoFlags, out);
    return out;
}

// ── ObjectFlags remap (tsgo bit layout → fork bit layout), by member name ──
// Low bits (Class…CouldContainTypeVariables) are identical and map to
// themselves; the high cache bits diverge. The one that reaches consumers is
// InstantiationExpressionType (no-misused-spread reads
// `type.objectFlags & ts.ObjectFlags.InstantiationExpressionType`) — tsgo bit24
// vs fork bit23. Derived by name, so each tsgo bit lands on its fork-named home.
let _objectFlagsPairs: ReadonlyArray<readonly [number, number]> | undefined;
const _objectFlagsRemapCache = new Map<number, number>();

function objectFlagsPairs(): ReadonlyArray<readonly [number, number]> {
    if (!_objectFlagsPairs) {
        const tsgo = loadTsgoEnums();
        _objectFlagsPairs = buildFlagPairsByName(tsgo.ObjectFlags, (ts as any).ObjectFlags);
    }
    return _objectFlagsPairs;
}

function remapObjectFlags(tsgoFlags: number): number {
    if (!tsgoFlags) return 0;
    const cached = _objectFlagsRemapCache.get(tsgoFlags);
    if (cached !== undefined) return cached;
    const out = remapFlagsByPairs(tsgoFlags, objectFlagsPairs());
    _objectFlagsRemapCache.set(tsgoFlags, out);
    return out;
}

function patchRemoteNodeKinds(sampleNode: any): void {
    // Process-global flag: the RemoteNode prototypes are shared across bundles
    // (same require cache), so a second bundle re-wrapping the kind getters
    // would remap SyntaxKind values twice.
    const proc = tnbBridgeProcessState();
    if (proc.kindRemapApplied) return;
    proc.kindRemapApplied = true;
    _kindRemap = buildKindRemap();
    if (_kindRemap.size === 0 || !sampleNode) return;

    // Patch the kind getter to remap tsgo→fork kind values for external
    // consumers (lazy-estree, ts.forEachChild, ts.isXxx). tsgo internal
    // methods use _rawKind (patched in node.generated.js) which always
    // returns the raw tsgo kind, so they are unaffected.
    //
    // `operator` (Prefix/PostfixUnaryExpression) and `keywordToken`
    // (MetaProperty) are scalar SyntaxKind token values, not child nodes, and
    // are emitted as raw tsgo kinds just like `kind`. typescript-estree reads
    // them directly (e.g. getTextForTokenKind(node.operator) when converting
    // UpdateExpression); without remapping, the off-by-one tsgo enum makes
    // `++`→`%` (mis-typed as UnaryExpression → no-unused-expressions) and
    // `--`→`++` (wrong-direction UpdateExpression → for-direction). Remap them
    // on whichever proto owns each getter (they live on different prototypes:
    // `kind` on RemoteNodeBase, `operator`/`keywordToken` on RemoteNode).
    const patchKindGetter = (name: string) => {
        let proto: any = Object.getPrototypeOf(sampleNode);
        while (proto && proto !== Object.prototype) {
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (desc?.get) {
                const origGet = desc.get;
                Object.defineProperty(proto, name, {
                    configurable: true,
                    get(this: any) {
                        const v = origGet.call(this);
                        return typeof v === "number" ? remapKind(v) : v;
                    },
                });
                return;
            }
            proto = Object.getPrototypeOf(proto);
        }
    };
    patchKindGetter("kind");
    patchKindGetter("operator");
    patchKindGetter("keywordToken");
    // `token` is a scalar SyntaxKind on HeritageClause (Extends/Implements) and
    // ImportAttributes (Assert/With), emitted as a raw tsgo kind. typescript-
    // estree reads `heritageClause.token === ts.SyntaxKind.ExtendsKeyword` /
    // `ImplementsKeyword` to split a class's superClass vs implements; with the
    // off-by-one tsgo enum the comparison never matches, so both clauses are
    // dropped from the ESTree output.
    patchKindGetter("token");
    // `keyword` (ModuleDeclaration namespace/module) and `phaseModifier`
    // (ImportClause type/defer) are the remaining scalar SyntaxKind getters in
    // the node decoder. They currently return keyword-token kinds that happen
    // to be identical across both enums (so remapKind is a no-op for them), but
    // we remap them anyway: it keeps EVERY exposed SyntaxKind-scalar field
    // boundary-translated, so a future submodule bump that shifts those values
    // can't silently regress. (The check-enum-remap.mjs guard enforces this.)
    patchKindGetter("keyword");
    patchKindGetter("phaseModifier");

    // `node.flags` is a raw tsgo NodeFlags value read off the binary blob (see
    // remapNodeFlags above). Remap it for external consumers; tsgo internal
    // dispatchers read `_rawFlags` (patched in node.generated.ts) so they keep
    // the raw value.
    const patchFlagsGetter = () => {
        let proto: any = Object.getPrototypeOf(sampleNode);
        while (proto && proto !== Object.prototype) {
            const desc = Object.getOwnPropertyDescriptor(proto, "flags");
            if (desc?.get) {
                const origGet = desc.get;
                Object.defineProperty(proto, "flags", {
                    configurable: true,
                    get(this: any) {
                        const v = origGet.call(this);
                        return typeof v === "number" ? remapNodeFlags(v) : v;
                    },
                });
                return;
            }
            proto = Object.getPrototypeOf(proto);
        }
    };
    patchFlagsGetter();
}

/** RemoteNode/RemoteSourceFile expose forEachChild but not getChildren; LS token walks need both. */
function installRemoteNodeTraversalHooks(): void {
    const proc = tnbBridgeProcessState();
    if (proc.remoteNodeTraversalPatched) return;
    try {
        const pathMod = require("path") as typeof import("path");
        const nodeModule = require(pathMod.join(getNativePreviewDir(), "dist", "api", "node", "node.js"));
        const RemoteNode = nodeModule.RemoteNode;
        if (!RemoteNode?.prototype || typeof RemoteNode.prototype.forEachChild !== "function") return;
        if (typeof RemoteNode.prototype.getChildren !== "function") {
            RemoteNode.prototype.getChildren = function (this: any, _sourceFile?: any) {
                const children: any[] = [];
                this.forEachChild((child: any) => children.push(child));
                return children;
            };
        }
        proc.remoteNodeTraversalPatched = true;
    } catch { /* native-preview not built yet */ }
}

// ── Thin tsgo-backed Program ──
// Replaces the full TS createProgram pipeline with a lightweight object that
// delegates source files + type checking to tsgo. Skips file resolution,
// module resolution, source-file creation, and path processing (~576ms on
// self-lint). tsgo resolves files from the tsconfig; host content is fed via
// overlay RPC so tsgo doesn't double-read from disk.

/** @internal */
export function createTsgoProgram(
    rootNames: readonly string[],
    options: any,
    host: any,
    projectReferences?: readonly any[],
    configFileParsingDiagnostics?: readonly any[],
): any {
    let configFilePath = options.configFilePath as string;
    if (!configFilePath) {
        throw new Error("createTsgoProgram: options.configFilePath is required");
    }
    configFilePath = resolveTsconfigPath(configFilePath, host);
    options.configFilePath = configFilePath;
    const configDiags = configFileParsingDiagnostics ?? [];

    // Bridge initialize() sets _tsgoUseCaseSensitive before any path below is canonicalized.
    ensureBridgeSession();

    // Host script text captured once at createProgram time (safe to call
    // host.getSourceFile here — program does not exist yet; Volar injects
    // virtual TS for .vue via getSourceFile). Reused by getOrCreateSourceFile
    // for skeleton text / diagnostic line maps without re-entering getSourceFile.
    const hostContentByFile = new Map<string, { text: string; scriptKind: number; fromHost?: boolean }>();
    /** Parsed host SourceFiles captured during createProgram (Volar virtual .vue TS). */
    const parsedHostSourceFiles = new Map<string, any>();

    // Collect host file content for tsgo overlays — makes the fork host the
    // single source of truth. Uses getSourceFile when present (vue-tsc / Volar
    // inject virtual TS for .vue); falls back to readFile. Only sends content
    // that differs from disk (or is missing on disk); unchanged on-disk .ts is
    // read by tsgo itself.
    const overlays: any[] = [];
    const trackedHostFiles = new Set<string>();
    const names = new Set<string>();
    const lsHost = _languageServiceHost ?? host;
    const programCtx: TnbProgramContext = {
        lsHost,
        overlayHostCtx: { host: lsHost, options, configFilePath },
    };
    {
        for (const fn of rootNames) {
            if (typeof fn === "string") names.add(fn);
        }
        for (const resolvedFn of collectTsgoOpenFileNames(lsHost)) {
            names.add(resolvedFn);
        }
        for (const fn of names) {
            trackedHostFiles.add(fn);
            const resolvedFn = resolveHostFileName(fn, host);
            if (!isOverlayCandidatePath(fn)) continue;
            const content = getHostScriptContentForOverlay(resolvedFn, options, host);
            if (!content) continue;
            hostContentByFile.set(resolvedFn, content);
            // Only parse host AST for true overlays (content differs from disk —
            // Volar virtual .vue TS, unsaved edits). Pure disk lint skips this
            // and uses tsgo-backed single-parse instead.
            if (!shouldSendHostOverlay(resolvedFn, content.text)) {
                // Host matches disk again after a prior overlay — re-push on-disk text
                // so tsgo does not keep checking stale overlay content.
                const synced = _syncedOverlayContentByFile.get(resolvedFn);
                if (synced !== undefined && synced !== content.text) {
                    _syncedOverlayContentByFile.delete(resolvedFn);
                    overlays.push({ fileName: resolvedFn, content: content.text, scriptKind: content.scriptKind });
                }
                else if (synced !== undefined) {
                    _syncedOverlayContentByFile.delete(resolvedFn);
                }
                continue;
            }
            const snapSf = sourceFileFromHostSnapshot(programCtx.lsHost, resolvedFn, fn, options.target ?? 99);
            if (snapSf?.statements?.length) {
                parsedHostSourceFiles.set(resolvedFn, snapSf);
            }
            overlays.push({ fileName: resolvedFn, content: content.text, scriptKind: content.scriptKind });
        }
    }
    const preferHostSourceFiles = overlays.length > 0
        || parsedHostSourceFiles.size > 0
        || !!(lsHost as any)?.projectService;
    programCtx.pendingOverlays = overlays.length > 0 ? overlays : undefined;
    programCtx.pendingExtraFileExtensions = collectExtraFileExtensions(names, options);
    _lastExtraFileExtensions = programCtx.pendingExtraFileExtensions;
    _hasHostBoundFiles = preferHostSourceFiles;
    // Mirror Volar proxyCreateProgram: extra extensions require allowArbitraryExtensions
    // for module resolution / auto-import in .vue virtual TS.
    if (programCtx.pendingExtraFileExtensions?.length && options.allowArbitraryExtensions !== false) {
        options.allowArbitraryExtensions = true;
    }

    // Collect referenced project paths for tsgo to open alongside the main
    // project — tsgo needs all referenced tsconfigs to resolve imports
    // across project boundaries (the full TS createProgram does this via
    // projectReferences; the thin path uses tsgo's openProjects).
    if (projectReferences && projectReferences.length > 0) {
        programCtx.pendingReferencedProjects = projectReferences
            .map((ref: any) => resolveTsconfigPath(ref.path as string, host))
            .filter((p: string) => typeof p === "string" && p.length > 0);
    } else {
        programCtx.pendingReferencedProjects = undefined;
    }

    // Eagerly create the tsgo project (shared bridge client, kind remap, etc.)
    // by calling createTsgoChecker which sets up ensureProject + overlays.
    // We pass a minimal program-like object that createTsgoChecker can use
    // to get configFilePath + getSourceFiles (for overlay content collection).
    const thinProgramForChecker = {
        getCompilerOptions: () => options,
        getSourceFiles: () => [] as any[],
    };
    registerProgramContext(thinProgramForChecker, programCtx);

    // tsserver/Volar open files incrementally (e.g. foo.vue before fixture.vue).
    // Always refresh the tsgo snapshot so overlays match the latest host content.
    _projectCache.delete(configFilePath);

    const checker = createTsgoChecker(thinProgramForChecker as any);

    // The tsgo project is now created (ensureProject ran inside createTsgoChecker).
    // Access it via the module-level cache.
    const project = _projectCache.get(configFilePath);

    // Build a thin Program object that delegates to the tsgo project.
    // File-name list is immutable per tsgo project object — cache the RPC
    // (the builder walks it several times per project).
    let tsgoSourceFileNamesCache: { proj: any; names: readonly string[] } | undefined;
    const getTsgoSourceFileNames = () => {
        const proj = project;
        if (!proj?.program) return [];
        if (!tsgoSourceFileNamesCache || tsgoSourceFileNamesCache.proj !== proj) {
            tsgoSourceFileNamesCache = { proj, names: proj.program.getSourceFileNames?.() ?? [] };
        }
        return tsgoSourceFileNamesCache.names as string[];
    };
    const getSourceFileNames = () => getTsgoSourceFileNames().map(toHostFileName);
    const tsgoGetSourceFile = (fileName: string) => project?.program?.getSourceFile?.(toTsgoFileName(fileName));

    // Helper: create a proper TS SourceFile shell (with path/resolvedPath/etc.)
    // from host content, then wrap it with the tsgo RemoteSourceFile AST via
    // getTsgoBackedSourceFile. BuilderProgram and other TS infrastructure
    // need path/resolvedPath/version on source files.
    const sfCache = new Map<string, any>();

    const hostForLs = () => programCtx.lsHost;

    const fileHasHostSourceContent = (name: string, hostFileName: string): boolean => {
        const ls = hostForLs();
        return hostHasScriptSnapshot(ls, name, hostFileName)
            || hostContentByFile.has(hostFileName)
            || parsedHostSourceFiles.has(hostFileName);
    };

    /** Host-parsed AST for Language Service — never tsgo RemoteSourceFile. */
    const getLanguageServiceSourceFile = (hostFileName: string, requestFileName: string): any | undefined => {
        const ls = hostForLs();
        const parsed = parsedHostSourceFiles.get(hostFileName);
        if (parsed?.statements?.length) {
            return parsed;
        }

        const fromSnap = sourceFileFromHostSnapshot(ls, hostFileName, requestFileName, options.target ?? 99);
        if (fromSnap) return fromSnap;

        const hasSnapshot = hostHasScriptSnapshot(ls, requestFileName, hostFileName);
        const content = hostContentByFile.get(hostFileName);
        if (content?.text && (!hasSnapshot || content.fromHost)) {
            const scriptKind = resolveLanguageServiceScriptKind(ls, requestFileName, hostFileName, hasSnapshot);
            const sf = createSourceFile(hostFileName, content.text, hostSourceFileOptions(options.target ?? 99, ls), /*setParentNodes*/ true, scriptKind);
            return attachHostSourceFileMetadata(sf, hostFileName);
        }

        if (!hasSnapshot) {
            const disk = ls?.readFile?.(hostFileName);
            if (typeof disk === "string" && disk.length) {
                const sf = createSourceFile(hostFileName, disk, hostSourceFileOptions(options.target ?? 99, ls), /*setParentNodes*/ true, inferScriptKind(hostFileName));
                return attachHostSourceFileMetadata(sf, hostFileName);
            }
        }

        return undefined;
    };

    const createBoundHostSourceFile = (hostFileName: string, requestFileName: string, text: string): any | undefined => {
        if (!text.length) return undefined;
        const ls = hostForLs();
        const scriptKind = resolveLanguageServiceScriptKind(ls, requestFileName, hostFileName, /*fromHostSnapshot*/ true);
        const sf = attachHostSourceFileMetadata(
            createSourceFile(hostFileName, text, hostSourceFileOptions(options.target ?? 99, ls), /*setParentNodes*/ true, scriptKind),
            hostFileName,
        );
        ensureHostSourceFileBound(sf, options);
        return sf;
    };

    const getOrCreateSourceFile = (fileName: string): any => {
        const hostFileName = resolveHostFileName(fileName, host);
        const scriptVersion = host?.getScriptVersion?.(fileName)
            ?? host?.getScriptVersion?.(hostFileName)
            ?? "1";
        const cacheKey = `${hostFileName}@${scriptVersion}`;
        if (sfCache.has(cacheKey)) return sfCache.get(cacheKey);

        // Language Service token walks need real TS AST (getChildren + parent).
        // tsgo RemoteSourceFile is for checker RPC only — never expose it here.
        // Pure disk lint (no overlay, no tsserver) uses tsgo-backed skeletons below.
        if (preferHostSourceFiles && !isHostLibFile(hostFileName)) {
            const ls = hostForLs();
            const hostSf = getLanguageServiceSourceFile(hostFileName, fileName);
            if (hostSf) {
                ensureHostSourceFileBound(hostSf, options);
                ensureTnbVersion(hostSf, hostFileName);
                sfCache.set(cacheKey, hostSf);
                return hostSf;
            }
            if (hostHasScriptSnapshot(ls, fileName, hostFileName)) {
                const snap = ls?.getScriptSnapshot?.(fileName) ?? ls?.getScriptSnapshot?.(hostFileName);
                const text = snap
                    ? snap.getText(0, snap.getLength())
                    : (hostContentByFile.get(hostFileName)?.text ?? "");
                const hostSf = createBoundHostSourceFile(hostFileName, fileName, text);
                if (hostSf) {
                    ensureTnbVersion(hostSf, hostFileName);
                    sfCache.set(cacheKey, hostSf);
                    return hostSf;
                }
                const scriptKind = resolveLanguageServiceScriptKind(ls, fileName, hostFileName, /*fromHostSnapshot*/ true);
                const sf = attachHostSourceFileMetadata(
                    createSkeletonSourceFile(hostFileName, text, options.target ?? 99, scriptKind),
                    hostFileName,
                );
                ensureTnbVersion(sf, hostFileName);
                sfCache.set(cacheKey, sf);
                return sf;
            }
        }

        const hostContent = hostContentByFile.get(hostFileName);
        const text = hostContent?.text ?? host?.readFile?.(hostFileName) ?? "";
        const scriptKind = hostContent?.scriptKind ?? inferScriptKind(hostFileName);
        const sf = createSkeletonSourceFile(hostFileName, text, options.target ?? 99, scriptKind);
        const canon = canonicalSourceFilePath(hostFileName);
        const anySf = sf as any;
        anySf.path = canon;
        anySf.resolvedPath = canon;
        ensureTnbVersion(anySf, hostFileName);
        const backed = getTsgoBackedSourceFile(anySf);
        const result = backed ?? anySf;
        ensureTnbVersion(result, hostFileName);
        if (result && result !== anySf) {
            try {
                // Canonical path identity: BuilderState keys fileInfos and the
                // referencedMap by resolvedPath — it must match the light-stub
                // and builder-meta canonicalization or dependency edges dangle.
                if (result.resolvedPath === undefined) {
                    Object.defineProperty(result, "resolvedPath", { value: canon, writable: true, configurable: true });
                }
                if (result.path === undefined) {
                    Object.defineProperty(result, "path", { value: canon, writable: true, configurable: true });
                }
                if (result.originalFileName === undefined) {
                    Object.defineProperty(result, "originalFileName", { value: hostFileName, writable: true, configurable: true });
                }
            } catch {}
        }
        ensureFileModuleMeta(result);
        sfCache.set(cacheKey, result);
        return result;
    };

    // Writable skeleton SourceFiles for diagnostics — Volar vue-tsc mutates
    // diagnostic.file.text during span remapping; tsgo RemoteSourceFile.text is read-only.
    const diagnosticSfCache = new Map<string, any>();
    const getDiagnosticSourceFile = (fileName: string): any => {
        // Normalize identity to the same key as host/full/light so a diagnostic
        // file matches the program SourceFile Volar remaps against, and so the
        // canonical path lines up across materializations (Axis C). Text lookup
        // stays on the raw fileName to preserve existing host-content hits.
        const hostFileName = resolveHostFileName(fileName, host);
        if (diagnosticSfCache.has(hostFileName)) return diagnosticSfCache.get(hostFileName);
        const hostContent = hostContentByFile.get(fileName) ?? hostContentByFile.get(hostFileName);
        const text = hostContent?.text ?? host?.readFile?.(fileName) ?? "";
        const scriptKind = hostContent?.scriptKind ?? inferScriptKind(hostFileName);
        const sf = createSkeletonSourceFile(hostFileName, text, options.target ?? 99, scriptKind);
        const canon = canonicalSourceFilePath(hostFileName);
        const anyDiagSf = sf as any;
        anyDiagSf.path = canon;
        anyDiagSf.resolvedPath = canon;
        diagnosticSfCache.set(hostFileName, sf);
        return sf;
    };

    // Lightweight skeleton stub (no tsgo RPC) for getSourceFiles() —
    // BuilderProgram iterates all files for state creation but only needs
    // version + referencedFiles (metadata), not the AST. Returning the
    // skeleton avoids 1693 eager getSourceFile RPCs; only the ~700 files
    // the files actually linted pay the RPC via getSourceFile(fileName).
    const lightSfCache = new Map<string, any>();
    // Pure-disk LS lint mode (tsslint CLI): LanguageServiceHost with snapshots
    // but no overlays / parsed host files / tsserver projectService. Fixed at
    // program creation — both inputs are. In this mode metadata-only consumers
    // (getSourceFiles walks, getSourceFileByPath from builder state / drain)
    // are served light stubs instead of materializing remote ASTs.
    const preferLightProgramFiles = !preferHostSourceFiles
        && typeof (programCtx.lsHost as any)?.getScriptSnapshot === "function";
    // Raw-path → light stub memo: skips repeated resolveHostFileName
    // normalization (path.normalize/resolve) on the builder's hot path.
    const lightSfByPathMemo = new Map<string, any>();
    const getOrCreateLightSourceFile = (fileName: string): any => {
        // Use the SAME host-name normalization as getOrCreateSourceFile
        // (resolveHostFileName), not the weaker toHostFileName. Otherwise a
        // relative / backslash / un-normalized input would give the light stub a
        // different fileName+path than the full/host SF for the same logical
        // file, silently drifting the BuilderState fileInfos key (Axis C).
        const hostFileName = resolveHostFileName(fileName, host);
        if (lightSfCache.has(hostFileName)) return lightSfCache.get(hostFileName);
        // Metadata-only SourceFile stub: no host.readFile, no computeLineStarts,
        // no AST. BuilderProgram state creation only needs these fields to key
        // fileInfos and to ask for referenced/imported files (empty here).
        // tsserver getScriptInfos() requires ScriptInfo for every returned file;
        // default libs are not opened as ScriptInfo — exclude them here.
        const tsgoPath = canonicalSourceFilePath(hostFileName);
        // Text and line map are lazy in pure-disk lint mode: builder-state /
        // buildinfo traffic never touches them, but a diagnostic whose `file` is
        // a light stub (buildinfo diagnostics rehydrated via getSourceFileByPath)
        // must still map offsets to real line/column. Only files actually asked
        // pay the disk read. Outside lint mode (vue-tsc / tsc -b) stubs keep the
        // previous cheap constants — those paths format diagnostics against full
        // host SourceFiles, and a lazy read per stub measurably slows the build.
        let lazyText: string | undefined;
        let lazyLineStarts: readonly number[] | undefined;
        const textOf = (): string => lazyText ??= (preferLightProgramFiles ? host?.readFile?.(hostFileName) ?? "" : "");
        const lineStartsOf = (): readonly number[] => lazyLineStarts ??= ts.computeLineStarts(textOf());
        const sf: any = {
            kind: SyntaxKind.SourceFile,
            fileName: hostFileName,
            path: tsgoPath,
            resolvedPath: tsgoPath,
            originalFileName: hostFileName,
            get text() { return textOf(); },
            // Volar's decorateProgram (vue-tsc) writes .text back onto program
            // source files (fillSourceFileText) — accept the write and drop the
            // stale lazily-computed line starts.
            set text(value: string) {
                lazyText = value;
                lazyLineStarts = undefined;
            },
            // Content-derived version (Go hash) — BuilderState serializes this
            // into buildinfo; a constant here would freeze cross-session change
            // detection (see builder-meta block above).
            get version() { return versionForFile(hostFileName); },
            languageVersion: options.target ?? 99,
            languageVariant: 0,
            scriptKind: inferScriptKind(hostFileName),
            isDeclarationFile: hostFileName.endsWith(".d.ts"),
            hasNoDefaultLib: false,
            referencedFiles: [],
            typeReferenceDirectives: [],
            libReferenceDirectives: [],
            amdDependencies: [],
            moduleAugmentations: [],
            imports: [],
            ambientModuleNames: [],
            parseDiagnostics: [],
            bindDiagnostics: [],
            commentDirectives: [],
            statements: [],
            endOfFileToken: {
                kind: SyntaxKind.EndOfFileToken,
                pos: 0,
                end: 0,
                getStart: () => 0,
                getEnd: () => 0,
                getFullStart: () => 0,
            },
            pos: 0,
            end: 0,
            get lineMap() { return lineStartsOf(); },
            getLineStarts: () => lineStartsOf(),
            getLineAndCharacterOfPosition: (position: number) => ts.computeLineAndCharacterOfPosition(lineStartsOf(), position),
            getPositionOfLineAndCharacter: (line: number, character: number) => ts.computePositionOfLineAndCharacter(lineStartsOf(), line, character, textOf()),
            forEachChild: () => undefined,
            // findAllReferences scans every program file; light stubs must not crash token walks.
            getChildren: () => [],
        };
        ensureFileModuleMeta(sf);
        lightSfCache.set(hostFileName, sf);
        return sf;
    };

    const tsgoFileArg = (fileName: string | undefined) => fileName ? toTsgoFileName(fileName) : fileName;

    // Program membership check — stock Program.getSourceFile returns undefined
    // for files outside the program, and hosts rely on that (Volar
    // component-meta probes getSourceFile and re-roots the file via
    // getScriptFileNames when it is missing, e.g. component.tsx that the
    // tsconfig's wildcard extension priority skipped in favor of component.ts).
    // Fabricating a SourceFile here would mask the miss and later checker RPCs
    // would fail with "source file not found". Names are cached per tsgo
    // project object (the project is replaced on every snapshot refresh).
    let programFileNamesCache: { proj: any; names: Set<string> } | undefined;
    const programContainsFile = (fileName: string): boolean => {
        const proj = project;
        if (!proj?.program) return true; // project not ready yet — stay permissive
        if (!programFileNamesCache || programFileNamesCache.proj !== proj) {
            const names = new Set<string>();
            for (const n of proj.program.getSourceFileNames?.() ?? []) {
                names.add(toHostFileName(n));
            }
            programFileNamesCache = { proj, names };
        }
        return programFileNamesCache.names.has(toHostFileName(fileName));
    };

    // Whole-program diagnostics memo, keyed on the tsgo project object (same
    // invalidation rule as programFileNamesCache: a snapshot refresh replaces
    // the project object). A tsgo snapshot is immutable, so these results are
    // deterministic per project object — this mirrors stock Program semantics,
    // where diagnostics are stable for the lifetime of a Program instance.
    //
    // getGlobalDiagnostics matters most: the tsgo API handler forces a full
    // semantic pass over the whole program (checker-pool parallel path) on
    // every call, and the solution builder asks twice per project
    // (emitFilesAndReportErrors + buildInfo hasSyntaxOrGlobalErrors).
    // getProgramDiagnostics is called once per source file by the builder's
    // ensureHasErrorsForState walk (the overlay intentionally surfaces the
    // whole-program result regardless of the file argument), so one RPC per
    // project replaces thousands of identical ones.
    let globalDiagnosticsCache: { proj: any; result: readonly any[] } | undefined;
    let programDiagnosticsCache: { proj: any; result: readonly any[] } | undefined;
    // Declaration diagnostics: the builder asks per file (buildinfo state) and
    // once whole-program (emitFilesAndReportErrors). One whole-program RPC —
    // which tsgo computes with per-file concurrency — is memoized and per-file
    // requests are served by filtering, replacing 2-3 sequential RPCs per
    // project. Declaration diagnostics always carry their source file, so
    // filtering by file matches stock per-file semantics.
    let declarationDiagnosticsCache: { proj: any; result: readonly any[] } | undefined;
    // Per-file syntactic/semantic diagnostics memo (same invalidation rule).
    // Stock Program caches bind-and-check diagnostics per file for its
    // lifetime; the builder re-asks several times per file (buildinfo walk +
    // emitFilesAndReportErrors), so this converts repeat RPCs into hits.
    let perFileDiagCache: { proj: any; syntactic: Map<string, readonly any[]>; semantic: Map<string, readonly any[]> } | undefined;
    const getPerFileDiagCache = (proj: any) => {
        if (!perFileDiagCache || perFileDiagCache.proj !== proj) {
            perFileDiagCache = { proj, syntactic: new Map(), semantic: new Map() };
        }
        return perFileDiagCache;
    };
    const getSyntacticDiagnosticsForFile = (proj: any, fileName: string): readonly any[] => {
        const cache = getPerFileDiagCache(proj);
        let result = cache.syntactic.get(fileName);
        if (!result) {
            result = mapTsgoDiagnostics(proj.program.getSyntacticDiagnostics?.(tsgoFileArg(fileName)), getDiagnosticSourceFile);
            cache.syntactic.set(fileName, result);
        }
        return result;
    };
    const getSemanticDiagnosticsForFile = (proj: any, fileName: string): readonly any[] => {
        const cache = getPerFileDiagCache(proj);
        let result = cache.semantic.get(fileName);
        if (!result) {
            result = mapTsgoDiagnostics(proj.program.getSemanticDiagnostics?.(tsgoFileArg(fileName)), getDiagnosticSourceFile);
            cache.semantic.set(fileName, result);
        }
        return result;
    };

    // ── Builder-state metadata (BuilderState.create / tsslint layer-2) ──
    // One batch RPC per tsgo project supplies, for every program file, the
    // content-hash version, the referenced-file edges, global-scope effect and
    // implied module format — computed in Go by the same graph walk tsgo's own
    // --incremental buildinfo uses (import symbols resolve at alias level; no
    // semantic pass). BuilderState.create consumes this via tnbBuilderFileMetas
    // instead of re-deriving the graph through per-import checker RPCs, and
    // SourceFile.version getters below read the same map so the versions the
    // builder serializes into buildinfo are content-derived and stable across
    // sessions (the old constant "1" made every file look unchanged forever —
    // stale type-aware lint results for dependents of an edited file).
    type TnbBuilderMeta = { version: string; affectsGlobalScope: true | undefined; impliedFormat: number | undefined; referencedPaths: readonly string[] | undefined };
    let builderMetaCache: { proj: any; byPath: Map<string, TnbBuilderMeta>; byHostFile: Map<string, TnbBuilderMeta> } | undefined;
    const getBuilderMetaState = () => {
        const proj = project;
        if (!proj?.program || typeof proj.program.getBuilderFileGraph !== "function") return undefined;
        // Non-incremental build-mode projects (tsc -b / vue-tsc -b over plain
        // noEmit tsconfigs, e.g. Nuxt-generated ones): the graph has no
        // consumer — Go writes the (non-incremental) buildinfo itself, and the
        // JS builder starts from a fresh state (the non-incremental buildinfo
        // restores no old program), where the fresh-state drain gate already
        // skips reference propagation. Fetching it would force a whole-program
        // hash + referenced-files walk per project (~300ms each) purely to be
        // discarded. Incremental/composite projects keep the fetch — their
        // buildinfo diff and change propagation consume it — and Go serves it
        // from the already-built incremental snapshot at no extra cost.
        if ((options as any).tscBuild && !options.incremental && !options.composite) return undefined;
        if (!builderMetaCache || builderMetaCache.proj !== proj) {
            const byPath = new Map<string, TnbBuilderMeta>();
            const byHostFile = new Map<string, TnbBuilderMeta>();
            let entries: readonly any[];
            try {
                entries = proj.program.getBuilderFileGraph() ?? [];
            } catch {
                return undefined;
            }
            for (const e of entries) {
                const hostFileName = toHostFileName(e.fileName);
                // Parity with getSourceFiles(): default libs are excluded from
                // the JS-side program view, so keep them out of fileInfos too.
                if (isHostLibFile(hostFileName)) continue;
                const meta: TnbBuilderMeta = {
                    version: e.version,
                    affectsGlobalScope: e.affectsGlobalScope ? true : undefined,
                    impliedFormat: e.impliedNodeFormat || undefined,
                    referencedPaths: e.refs?.map((r: string) => canonicalSourceFilePath(toHostFileName(r))),
                };
                byPath.set(canonicalSourceFilePath(hostFileName), meta);
                byHostFile.set(hostFileName, meta);
            }
            builderMetaCache = { proj, byPath, byHostFile };
        }
        return builderMetaCache;
    };
    /** Attach Go builder-graph implied module format for explainFiles / watch logging. */
    const ensureFileModuleMeta = (sf: any): void => {
        if (!sf || sf.impliedNodeFormat !== undefined) return;
        const rawName = sf.fileName ?? sf.originalFileName;
        if (typeof rawName !== "string" || !rawName) return;
        const hostFileName = resolveHostFileName(rawName, host);
        const implied = getBuilderMetaState()?.byHostFile.get(hostFileName)?.impliedFormat;
        if (implied !== undefined) sf.impliedNodeFormat = implied;
    };
    const goProgram = () => project?.program;
    const programFileId = (file: any) => {
        const name = file?.fileName ?? file?.originalFileName;
        return typeof name === "string" && name ? tsgoFileArg(name) : undefined;
    };
    const usagePosition = (usage: any): number | undefined => {
        if (!usage) return undefined;
        const sf = usage.getSourceFile?.();
        if (!sf || typeof usage.getStart !== "function") return undefined;
        try { return usage.getStart(sf); } catch { return undefined; }
    };
    // Project-reference-aware per-file options via tsgo program RPC.
    const optionsForFile = (file?: any) => {
        if (!file) return options;
        const id = programFileId(file);
        if (!id) return options;
        try { return goProgram()?.getCompilerOptionsForFile?.(id) ?? options; } catch { return options; }
    };
    const shouldTransformImportCallForFile = (file: any): boolean => {
        if (!file) return false;
        const id = programFileId(file);
        if (!id) return false;
        try {
            const moduleKind = ts.getEmitModuleKind(optionsForFile(file));
            if ((ModuleKind.Node16 <= moduleKind && moduleKind <= ModuleKind.NodeNext) || moduleKind === ModuleKind.Preserve) {
                return false;
            }
            const fmt = goProgram()?.getEmitModuleFormatOfFile?.(id);
            return typeof fmt === "number" && fmt < ModuleKind.ES2015;
        } catch { return false; }
    };
    /** Content-derived SourceFile version: Go hash when known, host script version otherwise. */
    const versionForFile = (hostFileName: string): string => {
        const meta = getBuilderMetaState()?.byHostFile.get(hostFileName);
        if (meta) return meta.version;
        const hv = hostForLs()?.getScriptVersion?.(hostFileName) ?? host?.getScriptVersion?.(hostFileName);
        return typeof hv === "string" && hv.length ? hv : "1";
    };
    /** Lazily bind a content-derived version getter (idempotent; skips host-supplied versions). */
    const ensureTnbVersion = (sf: any, hostFileName: string): void => {
        if (!sf) return;
        try {
            const own = Object.getOwnPropertyDescriptor(sf, "version");
            if (own && !own.configurable) return;
            if (own && own.value !== undefined && own.value !== "1") return;
            Object.defineProperty(sf, "version", {
                configurable: true,
                enumerable: false,
                get: () => versionForFile(hostFileName),
            });
        } catch { /* best-effort */ }
    };
    // Root-file membership for buildinfo serialization (builder.ts tryAddRoot
    // consults this instead of materializing each SourceFile to inspect
    // fileIncludeReasons, which the thin program does not track).
    let rootPathSetCache: Set<string> | undefined;
    const isRootFilePath = (path: any): boolean => {
        if (!rootPathSetCache) {
            rootPathSetCache = new Set();
            for (const fn of collectTsgoOpenFileNames(programCtx.lsHost, rootNames as string[])) {
                rootPathSetCache.add(canonicalSourceFilePath(fn));
            }
        }
        return rootPathSetCache.has(String(path));
    };

    const thinProgram: any = {
        // Marks this as a tsgo-backed program: its SourceFiles come straight from
        // tsgo and are never acquired via the LanguageService document registry.
        // LanguageService.cleanupSemanticCache uses this to skip the (otherwise
        // mandatory) releaseDocumentWithKey pass, which would fault on the missing
        // registry bucket and abort ConfiguredProject.close mid-teardown.
        isTsgoBackedProgram: true,
        getRootFileNames: () => collectTsgoOpenFileNames(programCtx.lsHost, rootNames as string[]),
        getCompilerOptions: () => options,
        getSourceFileNames,
        getSourceFile: (fileName: string) => {
            // Mirror stock Program.getSourceFile: undefined for non-members so
            // hosts (Volar component-meta) can detect the miss and re-root the
            // file. Lib files keep the permissive path (host lib paths differ
            // from tsgo's bundled libs).
            if (!isHostLibFile(toHostFileName(fileName)) && !programContainsFile(fileName)) {
                return undefined;
            }
            return getOrCreateSourceFile(fileName);
        },
        // BuilderProgram mostly calls getSourceFileByPath while constructing
        // fileInfos / dependency state. It only needs source-file metadata
        // there, not the AST. Returning a light stub avoids eager
        // RemoteSourceFile materialisation for every program file.
        // Host-overlay / open files must use the full SourceFile so
        // toLineColumnOffset (go-to-definition span conversion) sees real line maps.
        getSourceFileByPath: (path: any) => {
            const pathStr = String(path);
            // Pure-disk lint: the builder's affected-file drain calls this once
            // per changed file (and per graph node on incremental runs). The
            // fileHasHostSourceContent probe below would CREATE a host snapshot
            // (tsslint's getScriptSnapshot reads the file from disk and caches
            // it), turning every metadata lookup into a disk read + fs.stat +
            // remote-AST RPC via getOrCreateSourceFile. Builder machinery only
            // needs metadata here — serve the memoized light stub directly.
            if (preferLightProgramFiles) {
                const memo = lightSfByPathMemo.get(pathStr);
                if (memo) return memo;
                const sf = getOrCreateLightSourceFile(pathStr);
                lightSfByPathMemo.set(pathStr, sf);
                return sf;
            }
            const hostFileName = toHostFileName(pathStr);
            if (fileHasHostSourceContent(pathStr, hostFileName)) {
                return getOrCreateSourceFile(pathStr);
            }
            return getOrCreateLightSourceFile(pathStr);
        },
        getSourceFiles: () => {
            const names = getSourceFileNames();
            const result: any[] = [];
            // Pure-disk LS lint (tsslint CLI: LanguageServiceHost, no overlays,
            // no tsserver): whole-program consumers of getSourceFiles()
            // (BuilderState, buildinfo serialization, hasErrors scans) need only
            // metadata, so light stubs skip one remote-AST fetch per program
            // file. The host snapshots every file it reads, which would
            // otherwise force fileHasHostSourceContent → full materialization
            // for the entire program. Files actually linted still pull full
            // ASTs via getSourceFile(fileName). Volar / vue-tsc keep full SFs
            // (host overlays / parsed host files → preferHostSourceFiles), and
            // CompilerHost builds (tsc -b) keep their previous behavior.
            for (const name of names) {
                if (isHostLibFile(name)) continue;
                const hostFileName = toHostFileName(name);
                const sf = !preferLightProgramFiles && fileHasHostSourceContent(name, hostFileName)
                    ? getOrCreateSourceFile(name)
                    : getOrCreateLightSourceFile(name);
                if (sf) result.push(sf);
            }
            return result;
        },
        getTypeChecker: () => checker,
        getConfigFileParsingDiagnostics: () => configDiags,
        getOptionsDiagnostics: () => [],
        getSemanticDiagnostics: (sourceFile?: any) => {
            const proj = project;
            if (!proj?.program) return [];
            if (sourceFile?.fileName) return getSemanticDiagnosticsForFile(proj, sourceFile.fileName);
            return mapTsgoDiagnostics(proj.program.getSemanticDiagnostics?.(), getDiagnosticSourceFile);
        },
        getSyntacticDiagnostics: (sourceFile?: any) => {
            const proj = project;
            if (!proj?.program) return [];
            if (sourceFile?.fileName) return getSyntacticDiagnosticsForFile(proj, sourceFile.fileName);
            return mapTsgoDiagnostics(proj.program.getSyntacticDiagnostics?.(), getDiagnosticSourceFile);
        },
        getGlobalDiagnostics: () => {
            const proj = project;
            if (!proj?.program) return [];
            if (!globalDiagnosticsCache || globalDiagnosticsCache.proj !== proj) {
                globalDiagnosticsCache = { proj, result: mapTsgoDiagnostics(proj.program.getGlobalDiagnostics?.(), getDiagnosticSourceFile) };
            }
            return globalDiagnosticsCache.result;
        },
        getSuggestionDiagnostics: (sourceFile?: any) => {
            const raw = sourceFile?.fileName
                ? project?.program?.getSuggestionDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSuggestionDiagnostics?.();
            return mapTsgoDiagnostics(raw, getDiagnosticSourceFile);
        },
        getDeclarationDiagnostics: (sourceFile?: any) => {
            const proj = project;
            if (!proj?.program) return [];
            // Per-file requests stay per-file: a whole-program declaration pass
            // covers files (shared includes, cross-project sources) whose decl
            // check the builder never asks for, and measures slower than the
            // union of the per-file calls on many-small-project solutions.
            if (sourceFile?.fileName) {
                return mapTsgoDiagnostics(proj.program.getDeclarationDiagnostics?.(tsgoFileArg(sourceFile.fileName)), getDiagnosticSourceFile);
            }
            // Whole-program requests are memoized per tsgo project object
            // (same invalidation rule as globalDiagnosticsCache).
            if (!declarationDiagnosticsCache || declarationDiagnosticsCache.proj !== proj) {
                declarationDiagnosticsCache = { proj, result: mapTsgoDiagnostics(proj.program.getDeclarationDiagnostics?.(), getDiagnosticSourceFile) };
            }
            return declarationDiagnosticsCache.result;
        },
        getDiagnostics: () => [],
        getBindAndCheckDiagnostics: (sourceFile?: any) => {
            const proj = project;
            if (!proj?.program) return [];
            if (sourceFile?.fileName) {
                return [
                    ...getSyntacticDiagnosticsForFile(proj, sourceFile.fileName),
                    ...getSemanticDiagnosticsForFile(proj, sourceFile.fileName),
                ];
            }
            return [
                ...mapTsgoDiagnostics(proj.program.getSyntacticDiagnostics?.(), getDiagnosticSourceFile),
                ...mapTsgoDiagnostics(proj.program.getSemanticDiagnostics?.(), getDiagnosticSourceFile),
            ];
        },
        getProgramDiagnostics: () => {
            const proj = project;
            if (!proj?.program) return [];
            if (!programDiagnosticsCache || programDiagnosticsCache.proj !== proj) {
                programDiagnosticsCache = { proj, result: mapTsgoDiagnostics(proj.program.getProgramDiagnostics?.(), getDiagnosticSourceFile) };
            }
            return programDiagnosticsCache.result;
        },
        getMissingFilePaths: () => [],
        getFilesByNameMap: () => new Map(),
        getClassifiableNames: () => new Set(),
        getCommonSourceDirectory: () => "",
        getCurrentDirectory: () => host?.getCurrentDirectory?.() ?? process.cwd(),
        // Same canonicalization rule as canonicalSourceFilePath — the builder
        // uses this for toPath on root names and buildinfo-relative paths, so
        // it must agree with SourceFile.path/resolvedPath or fileInfos keys
        // and referencedMap edges drift apart.
        getCanonicalFileName: (fileName: string) => canonicalSourceFilePath(fileName),
        // BuilderState.create hook: whole-program builder metadata from Go
        // (content-hash versions + referenced-file graph). See the builder-meta
        // block above.
        tnbBuilderFileMetas: () => getBuilderMetaState()?.byPath,
        // builder.ts getBuildInfo root serialization hook (no per-file
        // SourceFile materialization / fileIncludeReasons bookkeeping needed).
        tnbIsRootFile: (path: any) => isRootFilePath(path),
        // Emit via tsgo: the Go emitter produces the output text, which we write
        // through the caller's writeFile (or the host's) so --noEmit, Volar output
        // redirection, and build-mode writeFile wrapping stay in the host's control.
        emit: (targetSourceFile?: any, writeFile?: any, _ct?: any, emitOnlyDtsFiles?: boolean, _customTransformers?: any, forceDtsEmit?: boolean) => {
            // Respect --noEmit: never produce output during a type-check-only run.
            // tsgo parses options from the tsconfig on disk and may not see the CLI
            // flag, so gate here on the JS-side compiler options.
            if (options.noEmit && !forceDtsEmit) {
                return { emitSkipped: true, diagnostics: [], emittedFiles: undefined, sourceMaps: undefined };
            }
            // DocumentIdentifier wire format is plain path string or { uri }, not { fileName }.
            const file = targetSourceFile?.fileName ? tsgoFileArg(targetSourceFile.fileName) : undefined;
            const emitOnly = forceDtsEmit ? 3 : (emitOnlyDtsFiles ? 2 : undefined);
            const res = project?.program?.emit?.({ file, emitOnly, forceDtsEmit: !!forceDtsEmit });
            const outputs = res?.outputFiles ?? [];
            const write = typeof writeFile === "function" ? writeFile : host?.writeFile?.bind(host);
            // Match stock emitter.ts — see emitBuildInfo comment above.
            const emittedFiles: string[] | undefined = options.listEmittedFiles ? [] : undefined;
            const sourceFiles = targetSourceFile ? [targetSourceFile] : undefined;
            for (const o of outputs) {
                if (write) write(o.fileName, o.text, !!o.writeByteOrderMark, undefined, sourceFiles);
                emittedFiles?.push(o.fileName);
            }
            return {
                emitSkipped: res?.emitSkipped ?? false,
                diagnostics: mapTsgoDiagnostics(res?.diagnostics, getDiagnosticSourceFile),
                emittedFiles,
                sourceMaps: [],
            };
        },
        // Buildinfo via tsgo: the Go side serializes its incremental snapshot
        // (fileInfos/signatures/diagnostics — never reimplemented in JS) and
        // returns the .tsbuildinfo text as an output file; we write it through
        // the caller's writeFile so the `tsc -b` / `vue-tsc -b` solution
        // builder's writeFile wrapping (buildInfoCache/mtime bookkeeping) sees
        // it, passing the parsed object as `data.buildInfo` like stock
        // Program.emitBuildInfo does. Like stock, the write is unconditional
        // at this layer — the JS builder gates on buildInfoEmitPending.
        emitBuildInfo: (writeFile?: any, _ct?: any) => {
            const write = typeof writeFile === "function" ? writeFile : host?.writeFile?.bind(host);
            // Match stock emitter.ts: only track emittedFiles when listEmittedFiles is set;
            // watch.ts logs TSFILE from this array, so leaving it undefined avoids spurious output.
            const emittedFiles: string[] | undefined = options.listEmittedFiles ? [] : undefined;

            // Stock parity: no buildinfo path configured → nothing to emit.
            // Checked before any RPC so misconfigured callers cost nothing.
            const buildInfoPath = getTsBuildInfoEmitOutputFilePath(options);
            if (!buildInfoPath) {
                return { emitSkipped: true, diagnostics: [], emittedFiles, sourceMaps: [] };
            }

            // JS-builder bypass — createBuilderProgram installs its state
            // serializer as getBuildInfo on the program object; serializing
            // that in-process (like stock Program.emitBuildInfo) instead of
            // routing through Go avoids handleEmitBuildInfo's whole-program
            // semantic pass (~12s on Dify's 6181-file lint, where tsslint
            // deliberately skips per-file semantic work via ignoreSourceFile).
            // Strictly gated to in-process builder consumers that intercept
            // the write with an explicit callback (tsslint layer-2 captures
            // the text and never touches disk): in build mode (`tsc -b` /
            // `vue-tsc -b`, marked via tscBuild) the .tsbuildinfo on disk is
            // a tsgo artifact — validated by Go on read, stamped with the
            // tsgo version — so a JS-serialized file would poison the Go
            // incremental state and every later build would start cold.
            if (!(options as any).tscBuild && typeof writeFile === "function" && typeof thinProgram.getBuildInfo === "function") {
                let builderBuildInfo: any;
                try {
                    builderBuildInfo = thinProgram.getBuildInfo();
                } catch { /* fall through to the Go path */ }
                if (builderBuildInfo?.version) {
                    const text = getBuildInfoText(builderBuildInfo);
                    writeFile(buildInfoPath, text, false, undefined, undefined, { buildInfo: builderBuildInfo });
                    emittedFiles?.push(buildInfoPath);
                    return { emitSkipped: false, diagnostics: [], emittedFiles, sourceMaps: [] };
                }
            }

            // Go path (build mode and non-builder callers): tsgo serializes its
            // incremental snapshot; tscBuild mirrors the `tsc -b` CLI flag for
            // build-mode buildinfo rules on non-incremental projects.
            const res = project?.program?.emitBuildInfo?.({ build: !!(options as any).tscBuild });
            const outputs = res?.outputFiles ?? [];
            for (const o of outputs) {
                let buildInfo: any;
                try { buildInfo = JSON.parse(o.text); } catch { /* write text regardless */ }
                if (write) write(o.fileName, o.text, !!o.writeByteOrderMark, undefined, undefined, buildInfo !== undefined ? { buildInfo } : undefined);
                emittedFiles?.push(o.fileName);
            }
            return {
                emitSkipped: res?.emitSkipped ?? true,
                diagnostics: mapTsgoDiagnostics(res?.diagnostics, getDiagnosticSourceFile),
                emittedFiles,
                sourceMaps: [],
            };
        },
        isSourceFileFromExternalLibrary: () => false,
        isSourceFileDefaultLibrary: (sf: any) => {
            const fn = sf?.fileName ?? "";
            return fn.includes("/lib.") || fn.includes("/node_modules/");
        },
        // getBuildInfo is stock-overridden by createBuilderProgram (the JS
        // builder installs its state-based generator on the program object);
        // the buildinfo actually written comes from emitBuildInfo above, so
        // this default is only reachable outside builder flows.
        getBuildInfo: () => undefined,
        getSourceFileFromReference: () => undefined,
        getFileIncludeReasons: () => new Map(),
        getModuleResolutionCache: () => undefined,
        redirectTargetsMap: new Map(),
        getGlobalTypingsCacheLocation: () => undefined,
        // ── Module format / resolution (delegated to tsgo program RPC) ──
        getCompilerOptionsForFile: (file: any) => optionsForFile(file),
        getImpliedNodeFormatForEmit: (file: any) => {
            const id = programFileId(file);
            if (!id) return undefined;
            try { return goProgram()?.getImpliedNodeFormatForEmit?.(id); } catch { return undefined; }
        },
        getDefaultResolutionModeForFile: (file: any) => {
            const id = programFileId(file);
            if (!id) return undefined;
            try { return goProgram()?.getDefaultResolutionModeForFile?.(id); } catch { return undefined; }
        },
        getModeForUsageLocation: (file: any, usage: any) => {
            const id = programFileId(file);
            const pos = usagePosition(usage);
            if (!id || typeof pos !== "number") return undefined;
            try { return goProgram()?.getModeForUsageLocation?.(id, pos); } catch { return undefined; }
        },
        getModeForResolutionAtIndex: (file: any, index: number) => {
            if (!file) return undefined;
            ensureFileModuleMeta(file);
            return getModeForResolutionAtIndex(file, index, optionsForFile(file));
        },
        getEmitModuleFormatOfFile: (file: any) => {
            const id = programFileId(file);
            if (!id) return ts.getEmitModuleKind(options);
            try { return goProgram()?.getEmitModuleFormatOfFile?.(id) ?? ts.getEmitModuleKind(options); } catch { return ts.getEmitModuleKind(options); }
        },
        shouldTransformImportCall: (file: any) => shouldTransformImportCallForFile(file),
        getEmitSyntaxForUsageLocation: (file: any, usage: any) => {
            const id = programFileId(file);
            const pos = usagePosition(usage);
            if (!id || typeof pos !== "number") return undefined;
            try { return goProgram()?.getEmitSyntaxForUsageLocation?.(id, pos); } catch { return undefined; }
        },
        // ── ModuleSpecifierResolutionHost / project metadata stubs ──
        useCaseSensitiveFileNames: () => host?.useCaseSensitiveFileNames?.() ?? false,
        fileExists: (fileName: string) => !!(host?.fileExists?.(fileName) ?? host?.fileExists?.(toHostFileName(fileName))),
        directoryExists: (path: string) => !!host?.directoryExists?.(path),
        readFile: (path: string) => host?.readFile?.(path),
        realpath: (path: string) => host?.realpath?.(path) ?? path,
        getSymlinkCache: () => host?.getSymlinkCache?.(),
        getModuleSpecifierCache: () => host?.getModuleSpecifierCache?.(),
        getPackageJsonInfoCache: () => host?.getPackageJsonInfoCache?.(),
        getNearestAncestorDirectoryWithPackageJson: (fileName: string, rootDir?: string) =>
            host?.getNearestAncestorDirectoryWithPackageJson?.(fileName, rootDir),
        trace: (s: string) => { host?.trace?.(s); },
        getProjectReferences: () => options.projectReferences,
        getResolvedProjectReferences: () => undefined,
        getRedirectFromSourceFile: () => undefined,
        getRedirectFromOutput: () => undefined,
        isSourceOfProjectReferenceRedirect: () => false,
        isEmittedFile: () => false,
        typesPackageExists: () => false,
        packageBundlesTypes: () => false,
        getNodeCount: () => 0,
        getIdentifierCount: () => 0,
        getSymbolCount: () => 0,
        getTypeCount: () => 0,
        getInstantiationCount: () => 0,
        getRelationCacheSizes: () => ({ assignable: 0, identity: 0, subtype: 0, strictSubtype: 0 }),
        getCachedSemanticDiagnostics: () => undefined,
        getAutomaticTypeDirectiveNames: () => [],
        getFileProcessingDiagnostics: () => undefined,
        getResolvedModule: () => undefined,
        getResolvedModuleFromModuleSpecifier: () => undefined,
        getResolvedTypeReferenceDirective: () => undefined,
        getResolvedTypeReferenceDirectiveFromTypeReferenceDirective: () => undefined,
        getLibFileFromReference: () => undefined,
        forEachResolvedProjectReference: () => undefined,
        getResolvedProjectReferenceByPath: () => undefined,
        getProgramDiagnosticsContainer: () => { throw new Error("tsgoChecker: Program.getProgramDiagnosticsContainer is not available on tsgo-backed programs"); },
        getCurrentPackagesMap: () => undefined,
        structureIsReused: StructureIsReused.Not,
        sourceFileToPackageName: new Map(),
        resolvedModules: undefined,
        resolvedTypeReferenceDirectiveNames: undefined,
        resolvedLibReferences: undefined,
        usesUriStyleNodeCoreModules: undefined,
        writeFile: host?.writeFile?.bind(host) ?? (() => {}),
        // BuilderProgram support
        structureIsChanged: () => false,
        getFilesWithInvalidatedResolutions: () => new Set(),
        forEachResolvedModule: (_callback: any) => { /* tsgo program owns module resolutions */ },
        forEachResolvedTypeReferenceDirective: (_callback: any) => {},
        getAutomaticTypeDirectiveResolutions: () => new Map(),
    };

    registerProgramContext(thinProgram, programCtx);
    _hostProgramRef = thinProgram;

    return new Proxy(thinProgram, {
        get(target: any, prop: string | symbol, receiver: any) {
            if (prop in target) return Reflect.get(target, prop, receiver);
            if (typeof prop !== "string") return undefined;
            return (..._args: any[]) => {
                throw new Error(`tsgoChecker: Program.${prop} is not implemented on the tsgo-backed program`);
            };
        },
        has: (target: any, p) => p in target,
        ownKeys: () => Object.keys(thinProgram),
        getOwnPropertyDescriptor: (target: any, p) => Object.getOwnPropertyDescriptor(target, p),
    });
}

function installNodeHandleHooks(s: any): void {
    installRemoteNodeTraversalHooks();
    const proc = tnbBridgeProcessState();
    if (proc.nodeHandlePatched) return;
    // Patch kind remapping using a sample RemoteSourceFile from the project.
    // Done here (not at module load) because we need a tsgo instance to walk
    // the prototype chain — the classes aren't exported by the sync API.
    const NodeHandle = s.NodeHandle;
    if (!NodeHandle?.prototype) return;
    const proto = NodeHandle.prototype;
    // Resolve the handle to its full tsgo RemoteNode once, caching on the
    // instance so repeat reads skip the resolve() walk.
    const resolveSelf = (self: any): any => {
        if (self._resolvedNode === undefined) {
            const project = _currentProjectRef.project;
            self._resolvedNode = project ? (self.resolve(project) ?? null) : null;
        }
        return self._resolvedNode;
    };
    // NodeHandle.getSourceFile() — scope manager calls this on declaration
    // handles to check if a symbol is from a lib file. Short-circuit to
    // project.program.getSourceFile(path) without full Node materialisation.
    if (typeof proto.getSourceFile !== "function") {
        proto.getSourceFile = function () {
            const project = _currentProjectRef.project;
            if (!project) return undefined;
            return project.program.getSourceFile(this.path);
        };
    }
    // NodeHandle.fileName — a bare handle ({index, kind, path}) has no own
    // fileName. In the TS AST only SourceFile nodes carry `fileName`, so expose
    // it for SourceFile handles (resolve the real cased name, else fall back to
    // the always-present `path`) and undefined otherwise. This restores the AST
    // contract so downstream (remapDeclarationToHost, tsgoLibPaths) always sees
    // a string for SourceFile declarations instead of undefined.
    if (!Object.getOwnPropertyDescriptor(proto, "fileName")) {
        Object.defineProperty(proto, "fileName", {
            configurable: true,
            get() {
                if (this.kind !== SyntaxKind.SourceFile) return undefined;
                return this.getSourceFile()?.fileName ?? this.path;
            },
        });
    }
    // NodeHandle.parent — rule code reads `.parent` on declarations. Resolve
    // the handle to a full tsgo Node, then read its parent.
    if (!Object.getOwnPropertyDescriptor(proto, "parent")) {
        Object.defineProperty(proto, "parent", {
            configurable: true,
            get() { return resolveSelf(this)?.parent; },
        });
    }
    // Position methods — a bare NodeHandle only carries {index, kind, path}.
    // When a full symbol's `declarations` (NodeHandles) are materialised to
    // ESTree (compat-eslint's lazy-estree `range(tn)` calls tn.getStart()/
    // getEnd()/getFullStart()), the handle would throw `getStart is not a
    // function`. The prefetch path uses light symbols (no declarations) and
    // never hits this, but the on-demand / lib-file fallback resolves full
    // symbols whose declaration handles DO get materialised. Delegate every
    // position accessor to the resolved RemoteNode so declaration → ESTree
    // conversion produces correct ranges instead of crashing.
    for (const m of ["getStart", "getEnd", "getFullStart", "getWidth", "getText", "getLeadingTriviaWidth", "getFullWidth"]) {
        if (typeof proto[m] !== "function") {
            proto[m] = function (...args: any[]) {
                const n = resolveSelf(this);
                return n && typeof n[m] === "function" ? n[m](...args) : undefined;
            };
        }
    }
    for (const p of ["pos", "end"]) {
        if (!Object.getOwnPropertyDescriptor(proto, p)) {
            Object.defineProperty(proto, p, {
                configurable: true,
                get() { return resolveSelf(this)?.[p]; },
            });
        }
    }
    // Structural-field delegation — a bare NodeHandle only carries
    // {index, kind, path}. Rules read declaration fields off symbol
    // declarations/valueDeclaration directly (e.g. no-base-to-string's
    // isSymbolToPrimitiveMethod reads `node.name`, then `.expression`,
    // `.text`; await-thenable reads `param.valueDeclaration.dotDotDotToken`).
    // Without these, the field is `undefined` and the rule crashes
    // (`Cannot read properties of undefined (reading 'kind')`). Delegate every
    // named child accessor (and a few scalar fields) to the resolved
    // RemoteNode, which exposes them with already-remapped child kinds.
    const STRUCTURAL_FIELDS = [
        "argument", "argumentExpression", "arguments", "assertsModifier", "asteriskToken",
        "attributes", "awaitModifier", "block", "body", "caseBlock", "catchClause", "checkType",
        "children", "className", "clauses", "closingElement", "closingFragment", "colonToken",
        "comment", "condition", "constraint", "declarationList", "declarations", "defaultType",
        "dotDotDotToken", "elements", "elementType", "elseStatement", "endOfFileToken",
        "equalsGreaterThanToken", "equalsToken", "exclamationToken", "exportClause", "expression",
        "exprName", "extendsType", "falseType", "finallyBlock", "head", "heritageClauses",
        "importClause", "incrementor", "indexType", "initializer", "jsdocPropertyTags", "label",
        "left", "literal", "members", "modifiers", "moduleReference", "moduleSpecifier", "name",
        "namedBindings", "nameExpression", "namespace", "nameType", "objectAssignmentInitializer",
        "objectType", "openingElement", "openingFragment", "operand", "operatorToken",
        "parameterName", "parameters", "postfixToken", "properties", "propertyName", "qualifier",
        "questionDotToken", "questionToken", "readonlyToken", "right", "statement", "statements",
        "tag", "tagName", "tags", "template", "templateSpans", "thenStatement", "thisArg",
        "trueType", "tryBlock", "tupleNameSource", "type", "typeArguments", "typeExpression",
        "typeName", "typeParameter", "typeParameters", "types", "value", "variableDeclaration",
        "whenFalse", "whenTrue",
        // JSDoc nodes attached to a declaration. Needed so stock jsDoc helpers
        // (getJSDocCommentsAndTags / hasJSDocNodes) work when callers pass a bare
        // declaration handle — e.g. vue-component-meta's getDescription reads
        // ts.getJSDocCommentsAndTags(componentNode) where componentNode is a
        // symbol.valueDeclaration handle under a tsconfig-backed project.
        "jsDoc",
        // Scalar fields rules read directly off declaration nodes.
        "text", "flags", "modifierFlags", "operator", "keywordToken", "isExportEquals",
    ];
    for (const f of STRUCTURAL_FIELDS) {
        if (!Object.getOwnPropertyDescriptor(proto, f)) {
            Object.defineProperty(proto, f, {
                configurable: true,
                get() { return resolveSelf(this)?.[f]; },
            });
        }
    }
    // getChildren / forEachChild — some rules walk declaration subtrees.
    for (const m of ["getChildren", "forEachChild", "getChildCount", "getFirstToken", "getLastToken"]) {
        if (typeof proto[m] !== "function") {
            proto[m] = function (...args: any[]) {
                const n = resolveSelf(this);
                return n && typeof n[m] === "function" ? n[m](...args) : undefined;
            };
        }
    }
    // Remap NodeHandle.kind from raw tsgo SyntaxKind to fork SyntaxKind. The
    // kind is a constructor-set own property (a prototype getter would be
    // shadowed), so the native-preview NodeHandle constructor applies a remap
    // hook we install here. RemoteNode.kind is remapped via patchRemoteNodeKinds;
    // this keeps NodeHandle.kind consistent so `ts.isXxx(handle)` type-guards
    // (which compare against fork kind values) fire correctly.
    if (!_kindRemap) _kindRemap = buildKindRemap();
    if (typeof s.setNodeHandleKindRemap === "function") {
        s.setNodeHandleKindRemap(remapKind);
    }
    proc.nodeHandlePatched = true;
}

/* @internal */
export function createTsgoChecker(program: any): any {
    const programCtx = getProgramContext(program);
    const hostForOverlaySyncLocal = (): any =>
        programCtx?.lsHost ?? programCtx?.overlayHostCtx?.host ?? hostForOverlaySync();

    const options = program.getCompilerOptions();
    let configFilePath = options.configFilePath as string | undefined;
    if (!configFilePath) {
        throw new Error("tsgoChecker: program has no configFilePath — tsgo NAPI backend requires a tsconfig path");
    }
    configFilePath = resolveTsconfigPath(configFilePath);
    options.configFilePath = configFilePath;

    let koffi = _koffi;
    let sync = _sync;
    let bridgeFns = _bridgeFns;
    let project: any;

    function ensureProject(): any {
        if (project) return project;

        // Return cached project for this tsconfig if already created. The cache
        // is process-global, so the project may have been created by the other
        // bundle's copy of this module — hydrate this bundle's locals first.
        const cached = _projectCache.get(configFilePath!);
        if (cached) {
            ensureBridgeSession();
            project = cached;
            koffi = _koffi; sync = _sync; bridgeFns = _bridgeFns;
            _currentProjectRef.project = project;
            patchSymbolProto(sync);
            patchSignatureProto(sync);
            installNodeHandleHooks(sync);
            installTsgoBackedSourceFileLoader(() => project);
            return project;
        }

        if (process.env.TSGO_PROFILE === "1") _tsgoLoadStart = Date.now();
        ensureBridgeSession();
        koffi = _koffi; sync = _sync; bridgeFns = _bridgeFns;

        // Collect host file content to feed as tsgo overlays — makes the fork
        // host the single source of truth (avoids tsgo double disk read, and
        // enables Volar virtual TS content injection for .vue/.mdx). Only user
        // files are overlaid; lib/node_modules files are read from disk by tsgo
        // (unchanged content, avoids serializing megabytes of lib.d.ts).
        // _pendingOverlays is pre-collected from the host by createTsgoProgram
        // (only files missing on disk — typically Volar virtual documents).
        const openFilesWithContent: any[] = [];
        if (programCtx?.pendingOverlays) {
            openFilesWithContent.push(...programCtx.pendingOverlays);
            programCtx.pendingOverlays = undefined;
        }

        const extraFileExtensions = programCtx?.pendingExtraFileExtensions;
        if (programCtx) programCtx.pendingExtraFileExtensions = undefined;
        if (extraFileExtensions) _lastExtraFileExtensions = extraFileExtensions;

        const syncHost = hostForOverlaySyncLocal();
        const openFiles = syncHost ? collectTsgoOpenFileNames(syncHost) : [];
        // Build mode: close the previous solution-build project in the same
        // updateSnapshot call that opens this one (see beginBuildProject).
        const buildClose = (options as any).tscBuild && process.env.TNB_BUILD_CLOSE !== "0"
            ? beginBuildProject(configFilePath!)
            : { closeParams: undefined, staleSnapshots: undefined };
        // Build mode: ask tsgo to start the whole-program semantic pass in the
        // background as soon as the project opens — it overlaps with the JS
        // builder's work between this call and getGlobalDiagnostics, which
        // then joins the in-flight pass (Go-side singleflight). Never set for
        // interactive hosts: a full check per keystroke would be pure waste.
        const prefetchDiagnostics = !!(options as any).tscBuild && process.env.TNB_PREFETCH_DIAG !== "0";
        const snapshot: any = _api.updateSnapshot({
            openProject: configFilePath!,
            ...(openFiles.length > 0 ? { openFiles } : {}),
            ...(openFilesWithContent.length > 0 ? { openFilesWithContent } : {}),
            ...(extraFileExtensions ? { extraFileExtensions } : {}),
            ...(buildClose.closeParams ?? {}),
            ...(prefetchDiagnostics ? { prefetchDiagnostics: true } : {}),
        });
        if (programCtx) programCtx.pendingReferencedProjects = undefined;
        project = snapshot.getProject(configFilePath!);
        if (!project) {
            throw new Error(`tsgoChecker: project not found for ${configFilePath}`);
        }
        trackBuildProjectSnapshot(configFilePath!, snapshot, [
            ...openFiles,
            ...openFilesWithContent.map(f => f.fileName),
        ]);
        releaseStaleBuildSnapshots(buildClose.staleSnapshots);
        for (const f of openFilesWithContent) {
            _syncedOverlayContentByFile.set(f.fileName, f.content);
        }
        // Cross-project extra-extension imports (e.g. ../other/foo.vue): the
        // program can include host-virtual files that were not in this
        // project's root set, so no overlay was pushed for them and tsgo
        // parsed their raw on-disk text. Ask the host (Volar getSourceFile
        // feeds virtual TS for any .vue path) for their content and push it
        // in a follow-up updateSnapshot — mirroring stock vue-tsc, where
        // program construction pulls every program file through
        // host.getSourceFile. Only files not already overlaid are sent.
        {
            const sentOverlayFiles = new Set(openFilesWithContent.map(f => f.fileName));
            const lateOverlays: { fileName: string; content: string; scriptKind: number }[] = [];
            for (const n of project.program.getSourceFileNames?.() ?? []) {
                const hostFileName = toHostFileName(n);
                if (!isExtraExtensionFileName(hostFileName) || !isOverlayCandidatePath(hostFileName)) continue;
                if (sentOverlayFiles.has(hostFileName) || _syncedOverlayContentByFile.has(hostFileName)) continue;
                const content = getHostScriptContent(syncHost ?? programCtx?.overlayHostCtx?.host, hostFileName, options);
                if (!content?.text || !content.fromHost) continue;
                // Same-as-disk host content adds nothing (tsgo already parsed
                // the disk text) — only genuine virtual content is pushed.
                if (!shouldSendHostOverlay(hostFileName, content.text)) continue;
                lateOverlays.push({ fileName: hostFileName, content: content.text, scriptKind: content.scriptKind });
            }
            if (lateOverlays.length > 0) {
                const lateSnapshot: any = _api.updateSnapshot({
                    openProject: configFilePath!,
                    openFilesWithContent: lateOverlays,
                    ...(extraFileExtensions ? { extraFileExtensions } : {}),
                });
                const refreshed = lateSnapshot.getProject(configFilePath!);
                if (refreshed) {
                    project = refreshed;
                    trackBuildProjectSnapshot(configFilePath!, lateSnapshot, lateOverlays.map(f => f.fileName));
                    for (const f of lateOverlays) _syncedOverlayContentByFile.set(f.fileName, f.content);
                }
            }
        }
        _projectCache.set(configFilePath!, project);
        _currentProjectRef.project = project;
        patchSymbolProto(sync);
        patchSignatureProto(sync);
        installNodeHandleHooks(sync);
        // Patch kind remapping using a sample source file from the tsgo project.
        // One-time per process (kindRemapApplied) — skip the sample-file RPC on
        // every subsequent project (a solution build creates hundreds).
        if (!tnbBridgeProcessState().kindRemapApplied) {
            const fileNames = project.program.getSourceFileNames?.() ?? [];
            if (fileNames.length > 0) {
                const sampleSf = project.program.getSourceFile(fileNames[0]);
                if (sampleSf) patchRemoteNodeKinds(sampleSf);
            }
        }
        // tsgo supplies the AST via the getSourceFile wrapper (dense nodes carry
        // parent pointers from the blob), so no real-TS parent wiring is needed.
        installTsgoBackedSourceFileLoader(() => project);
        if (process.env.TSGO_PROFILE === "1") {
            _stats.projectLoadMs += Date.now() - _tsgoLoadStart;
            _stats.projectsLoaded++;
        }
        return project;
    }

    // ── Position → tsgo Node finder (cached per file) ────────────────
    const tsgoSfCache = new Map<string, any>();
    const nodeAtPosCache = new Map<string, Map<string, any>>();
    // Symbol cache keyed by (fileName, end-offset) — the fast path for
    // getSymbolAtLocation, which resolves the vast majority of the ~30k
    // scope-manager identifier queries without touching the node index.
    const symByPos = new Map<string, Map<number, any>>();
    const symPrefetched = new Set<string>();
    /** Per-file cache misses before batch prefetch — sparse files stay on direct RPC. */
    const symMissCountByFile = new Map<string, number>();
    let symPrefetchMissThresholdCache: number | undefined;
    const symPrefetchMissThreshold = (): number => {
        if (symPrefetchMissThresholdCache !== undefined) return symPrefetchMissThresholdCache;
        const env = Number(process.env.TSGO_SYM_PREFETCH_THRESHOLD ?? "");
        if (Number.isFinite(env) && env > 0) {
            symPrefetchMissThresholdCache = Math.floor(env);
            return symPrefetchMissThresholdCache;
        }
        // Single large programs (e.g. Dify ~6k files): per-file allIdentifiers
        // prefetch at the default 32-miss bar fires hundreds of times and loses
        // to direct RPC; micro-project lint (Volar ~10–200 files) stays at 32.
        ensureProject();
        const fileCount = project?.program?.getSourceFileNames?.()?.length ?? 0;
        symPrefetchMissThresholdCache = Math.max(32, Math.min(256, Math.floor(fileCount / 40)));
        return symPrefetchMissThresholdCache;
    };
    const symCacheFileName = (fileName: string): string => {
        const h = hostForOverlaySyncLocal();
        return resolveHostFileName(fileName, h);
    };
    const getSymFileCache = (fileName: string, create = false): Map<number, any> | undefined => {
        const key = symCacheFileName(fileName);
        let fc = symByPos.get(key);
        if (!fc && create) {
            fc = new Map();
            symByPos.set(key, fc);
        }
        return fc;
    };
    const probeSymCache = (fileName: string, start: number, end: number): { found: boolean; sym: any } => {
        const fc = getSymFileCache(fileName);
        if (!fc) return { found: false, sym: undefined };
        if (fc.has(start)) return { found: true, sym: fc.get(start) };
        if (fc.has(end)) return { found: true, sym: fc.get(end) };
        if (end > start && fc.has(end - 1)) return { found: true, sym: fc.get(end - 1) };
        return { found: false, sym: undefined };
    };
    const isIdentifierLikeNode = (node: any): boolean => {
        const k = node.kind;
        return k === SyntaxKind.Identifier || k === SyntaxKind.PrivateIdentifier;
    };
    // Mirrors Go tryGetImportFromModuleSpecifier coverage (the sites the
    // allIdentifiers prefetch and SourceFile.imports both include): static
    // import/export, require()/import() calls, and import-type arguments.
    const isModuleSpecifierStringLiteral = (node: any): boolean => {
        if (node?.kind !== SyntaxKind.StringLiteral) return false;
        const p = node.parent;
        if (!p) return false;
        switch (p.kind) {
            case SyntaxKind.ImportDeclaration:
            case SyntaxKind.ExportDeclaration:
                return p.moduleSpecifier === node;
            case SyntaxKind.ExternalModuleReference:
                return p.expression === node;
            case SyntaxKind.CallExpression: {
                const callee = p.expression;
                return callee?.kind === SyntaxKind.ImportKeyword
                    || (callee?.kind === SyntaxKind.Identifier && String(callee.escapedText ?? callee.text ?? "") === "require");
            }
            case SyntaxKind.LiteralType:
                return p.parent?.kind === SyntaxKind.ImportType && p.parent.argument === p;
            default:
                return false;
        }
    };
    const isPrefetchCoveredNode = (node: any): boolean =>
        isIdentifierLikeNode(node) || isModuleSpecifierStringLiteral(node);
    const storeSymCache = (fileName: string, start: number, end: number, sym: any): void => {
        const fc = getSymFileCache(fileName, true)!;
        fc.set(start, sym);
        if (end !== start) fc.set(end, sym);
        if (end > start) fc.set(end - 1, sym);
    };
    // refineNavSymbol memo: the same symbol is refined once even when queried
    // from many reference sites (e.g. 100 refs to `foo`). Keyed by symbol
    // object identity (tsgo symbols are id-keyed singletons via objectRegistry;
    // host-bound symbols are real TS symbol objects). Cleared on snapshot
    // refresh alongside symByPos.
    const refinedSymBySym = new WeakMap<any, any>();
    // Files where prefetchResolvedReferences ran — skip expensive node-tree
    // fallback on cache miss; prefetch + getSymbolAtPosition is enough.
    const symPrefetchPopulated = new Set<string>();
    // Files whose import/export module-specifier symbols were batch-resolved
    // in one getSymbolsAtLocations RPC over the tsgo SourceFile's `imports`
    // list (see ensureModuleSpecifierSymbolsPrefetched). Multi-project lint
    // runners resolve every import literal of every program file (BuilderState
    // dependency walks, cache hashing); per-literal RPC dominates without this.
    const moduleSpecPrefetched = new Set<string>();
    /** getSymbolsInScope memo — keyed (file:start:end:meaning); see adapter. */
    const symbolsInScopeCache = new Map<string, any[]>();
    // Per-file index: start position → all tsgo nodes that start there.
    // Built once per file via a single AST walk, after which every
    // findTsgoNodeAtPosition call is an O(1) map lookup + a tiny kind/end
    // filter. This replaces the old per-query full AST walk that dominated
    // wall time (~8s → ~2s) — the hot path issues thousands of
    // getTypeAtLocation / getSymbolAtLocation queries per file.
    const nodeIndexCache = new Map<string, Map<number, any[]>>();

    function resolveTsgoModuleSymbol(moduleSymbol: any, hostFileName: string): any {
        pushHostOverlayToTsgo(hostFileName);
        const tsgoChecker = project.checker;
        const tsgoFile = toTsgoFileName(hostFileName);
        if (typeof tsgoChecker.getSymbolAtPosition === "function") {
            try {
                const sym = tsgoChecker.getSymbolAtPosition(tsgoFile, 0);
                if (sym) return sym;
            } catch { /* host-bound module */ }
        }
        const bridge = resolveRpcSymbol(moduleSymbol);
        if (bridge && typeof bridge.id === "number" && bridge.id !== 0) return bridge;
        return moduleSymbol;
    }

    function resolveHostModuleNamedExports(hostFileName: string): any[] {
        const overlayCtx = programCtx?.overlayHostCtx;
        const host = hostForOverlaySyncLocal();
        const options = overlayCtx?.options;
        if (!host || !options || !isOverlayCandidatePath(hostFileName)) return [];
        pushHostOverlayToTsgo(hostFileName);
        const snapSf = sourceFileFromHostSnapshot(host, hostFileName, hostFileName, options.target ?? 99);
        if (!snapSf) return [];
        ensureHostSourceFileBound(snapSf, options);
        return collectNamedExportsFromModuleSymbol(snapSf.symbol);
    }

    function moduleSymbolUsesHostExportTable(moduleSymbol: any): boolean {
        const hostFileName = moduleSymbolSourceFileName(moduleSymbol);
        if (!hostFileName || !isOverlayCandidatePath(hostFileName)) return false;
        for (const decl of moduleSymbol?.declarations ?? []) {
            if (decl?.getSourceFile?.()?.__tnbHostBound) return true;
        }
        const host = hostForOverlaySyncLocal();
        const overlayCtx = programCtx?.overlayHostCtx;
        if (!host || !overlayCtx?.options) return false;
        const snapSf = sourceFileFromHostSnapshot(host, hostFileName, hostFileName, overlayCtx.options.target ?? 99);
        return !!snapSf?.__tnbHostBound;
    }

    function resolveModuleSymbolForExports(moduleSymbol: any): any {
        if (moduleSymbol?.exports && moduleSymbolUsesHostExportTable(moduleSymbol)) return moduleSymbol;
        const hostFileName = moduleSymbolSourceFileName(moduleSymbol);
        return hostFileName ? resolveTsgoModuleSymbol(moduleSymbol, hostFileName) : moduleSymbol;
    }

    function resolveExportMapModuleSymbol(moduleSymbol: any, moduleFileName?: string): any {
        const fileName = moduleFileName ?? moduleSymbolSourceFileName(moduleSymbol);
        if (moduleSymbolUsesHostExportTable(moduleSymbol)) return moduleSymbol;
        if (fileName && !isOverlayCandidatePath(fileName)) {
            ensureProject();
            pushHostOverlayToTsgo(fileName);
            const tsgoFile = toTsgoFileName(fileName);
            try {
                const sym = project.checker.getSymbolAtPosition(tsgoFile, 0);
                if (sym && typeof sym.id === "number" && sym.id !== 0) return sym;
            } catch { /* fall through */ }
        }
        return resolveModuleSymbolForExports(moduleSymbol);
    }

    function getRpcExportsOfModule(moduleSymbol: any): any[] {
        if (!moduleSymbol) return [];
        ensureProject();
        const bridge = resolveRpcSymbol(moduleSymbol) ?? (isTsgoBridgeSymbol(moduleSymbol) ? moduleSymbol : undefined);
        if (!bridge || typeof bridge.id !== "number" || bridge.id === 0) return [];
        try {
            return rpc().getExportsOfModule(bridge) ?? [];
        } catch {
            return [];
        }
    }

    function forEachNamedExport(_tsgoChecker: any, moduleSymbol: any, cb: (symbol: any, key: string) => void): void {
        let fromExports: any[] = [];
        if (moduleSymbolUsesHostExportTable(moduleSymbol)) {
            fromExports = collectNamedExportsFromModuleSymbol(moduleSymbol);
            if (!fromExports.length) {
                const hostFileName = moduleSymbolSourceFileName(moduleSymbol);
                if (hostFileName) fromExports = resolveHostModuleNamedExports(hostFileName);
            }
        }
        if (!fromExports.length) {
            fromExports = getRpcExportsOfModule(moduleSymbol);
        }
        for (const exported of fromExports) {
            const key = exportMemberKey(exported);
            if (key) cb(exported, key);
        }
    }

    function resolveExternalModuleSymbolImpl(moduleSymbol: any): any {
        if (!moduleSymbol) return moduleSymbol;
        ensureProject();
        const bridge = resolveRpcSymbol(moduleSymbol) ?? (isTsgoBridgeSymbol(moduleSymbol) ? moduleSymbol : undefined);
        if (bridge) {
            const checker = rpc();
            if (typeof checker.resolveExternalModuleSymbol !== "function") {
                // Stale native-preview: bridge modules without host exports cannot expand export=.
                if (!moduleSymbol.exports) return moduleSymbol;
            } else {
                try {
                    const resolved = checker.resolveExternalModuleSymbol(bridge);
                    // Stock returns the input module symbol when there is no export=;
                    // preserve moduleSymbol identity for downstream === checks.
                    if (resolved && resolved !== bridge) return resolved;
                } catch (err) {
                    // No host fallback — surface RPC/bridge failures instead of
                    // silently skipping export= property enumeration.
                    if (!moduleSymbol.exports) throw err;
                }
            }
        }
        if (moduleSymbol.exports) {
            try {
                const exportEquals = moduleSymbol.exports.get("export=");
                if (exportEquals) return resolveHostAliasedSymbol(exportEquals);
            } catch { /* host-bound exports table */ }
        }
        return moduleSymbol;
    }

    function getTypeOfSymbolForExportEquals(exportEquals: any): any {
        if (!exportEquals) return undefined;
        ensureProject();
        const bridge = resolveRpcSymbol(exportEquals);
        if (bridge) {
            try {
                const t = rpc().getTypeOfSymbol(bridge);
                if (t) { fixupType(t); return t; }
            } catch { /* fall through to declaration anchor */ }
        }
        const decls = exportEquals.declarations?.length
            ? exportEquals.declarations
            : exportEquals.valueDeclaration ? [exportEquals.valueDeclaration] : [];
        for (const decl of decls) {
            if (decl?.kind !== SyntaxKind.ExportAssignment || !decl.expression) continue;
            const sf = decl.getSourceFile?.();
            if (!sf || sf.__tnbHostBound) continue;
            const expr = decl.expression;
            let start: number | undefined;
            try { start = expr.getStart(sf); } catch { continue; }
            if (typeof start !== "number") continue;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, expr.kind);
            if (!tsgoNode) continue;
            try {
                const t = project.checker.getTypeAtLocation(tsgoNode);
                if (t) { fixupType(t); return t; }
            } catch { /* try next declaration */ }
        }
        return undefined;
    }

    function getPropertiesOfTypeForExportEquals(type: any): readonly any[] {
        if (!type) return [];
        ensureProject();
        return memoGet(propertiesCache, type, () => project.checker.getPropertiesOfType(type) ?? []);
    }

    function forEachExportEqualsProperties(moduleSymbol: any, cb: (symbol: any, key: string) => void): void {
        const exportEquals = resolveExternalModuleSymbolImpl(moduleSymbol);
        if (exportEquals === moduleSymbol) return;
        const exportEqualsType = getTypeOfSymbolForExportEquals(exportEquals);
        if (!exportEqualsType || !shouldTreatPropertiesOfExternalModuleAsExports(exportEqualsType)) return;
        for (const sym of getPropertiesOfTypeForExportEquals(exportEqualsType)) {
            const key = exportMemberKey(sym);
            if (key) cb(sym, key);
        }
    }

    function forEachExportAndPropertyOfModuleWorker(moduleSymbol: any, cb: (symbol: any, key: string) => void, moduleFileName?: string): void {
        ensureProject();
        const mod = resolveExportMapModuleSymbol(moduleSymbol, moduleFileName);
        forEachNamedExport(undefined, mod, cb);
        forEachExportEqualsProperties(mod, cb);
    }

    /** Push all open host files that need overlay into tsgo (single updateSnapshot). */
    function pushHostOverlayToTsgo(requestedFileName?: string): void {
        if (_checkerQueryDepth > 0) return;
        ensureProject();
        const ctx = programCtx?.overlayHostCtx;
        if (!ctx || !_api) return;
        const syncHost = hostForOverlaySyncLocal();
        if (!syncHost) return;

        const openFiles = collectTsgoOpenFileNames(syncHost, requestedFileName ? [requestedFileName] : undefined);
        const openFilesWithContent: { fileName: string; content: string; scriptKind: number }[] = [];
        for (const hostFileName of openFiles) {
            if (!isOverlayCandidatePath(hostFileName)) continue;
            const content = getHostScriptContent(syncHost, hostFileName, ctx.options);
            if (!content?.text) continue;
            const hostOnly = !fileExistsOnDisk(hostFileName);
            const inTsgo = !!project?.program?.getSourceFile?.(toTsgoFileName(hostFileName));
            if (!hostOnly && inTsgo && !shouldSendHostOverlay(hostFileName, content.text)) {
                const synced = _syncedOverlayContentByFile.get(hostFileName);
                if (synced !== undefined && synced !== content.text) {
                    _syncedOverlayContentByFile.delete(hostFileName);
                    openFilesWithContent.push({ fileName: hostFileName, content: content.text, scriptKind: content.scriptKind });
                }
                else if (synced !== undefined) {
                    _syncedOverlayContentByFile.delete(hostFileName);
                }
                continue;
            }
            if (!hostOnly && _syncedOverlayContentByFile.get(hostFileName) === content.text) continue;
            openFilesWithContent.push({ fileName: hostFileName, content: content.text, scriptKind: content.scriptKind });
        }
        if (!openFiles.length && !openFilesWithContent.length) return;

        const snapshot: any = _api.updateSnapshot({
            openProject: ctx.configFilePath,
            ...(openFiles.length > 0 ? { openFiles } : {}),
            openFilesWithContent,
            ...(_lastExtraFileExtensions ? { extraFileExtensions: _lastExtraFileExtensions } : {}),
        });
        trackBuildProjectSnapshot(ctx.configFilePath, snapshot, [
            ...openFiles,
            ...openFilesWithContent.map(f => f.fileName),
        ]);
        const refreshed = snapshot.getProject(ctx.configFilePath);
        if (!refreshed) return;
        project = refreshed;
        _projectCache.set(ctx.configFilePath, refreshed);
        _currentProjectRef.project = refreshed;
        installTsgoBackedSourceFileLoader(() => project);
        for (const f of openFilesWithContent) {
            _syncedOverlayContentByFile.set(f.fileName, f.content);
            tsgoSfCache.delete(f.fileName);
            nodeIndexCache.delete(f.fileName);
            nodeAtPosCache.delete(f.fileName);
        }
        // Only invalidate symbol/type caches when host content actually changed.
        // openFiles-only snapshot bumps (disk lint prefetch) must not wipe
        // symByPos between per-file batch prefetches.
        if (openFilesWithContent.length === 0) return;
        symByPos.clear();
        symPrefetched.clear();
        symPrefetchPopulated.clear();
        moduleSpecPrefetched.clear();
        symbolsInScopeCache.clear();
        symMissCountByFile.clear();
        rpcSymbolCache.clear();
        nodeTypeCache.clear();
        typeOfSymbolCache.clear();
        propertiesCache.clear();
        propertyByNameCache.clear();
        propertyBulkLoaded.clear();
        signaturesByKindCache.clear();
        baseTypesCache.clear();
        _objCompletionPending = undefined;
        _objCompletionBatch = undefined;
    }

    function getTsgoSourceFile(fileName: string): any {
        const hostFileName = toHostFileName(fileName);
        if (tsgoSfCache.has(hostFileName)) return tsgoSfCache.get(hostFileName);
        pushHostOverlayToTsgo(hostFileName);
        const proj = _currentProjectRef.project ?? ensureProject();
        const sf = proj.program.getSourceFile(toTsgoFileName(hostFileName));
        tsgoSfCache.set(hostFileName, sf);
        return sf;
    }

    function buildNodeIndex(fileName: string, sf: any): Map<number, any[]> | undefined {
        const cached = nodeIndexCache.get(fileName);
        if (cached) return cached;
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        const idx = new Map<number, any[]>();
        nodeIndexCache.set(fileName, idx);
        const visit = (node: any) => {
            const start = typeof node.getStart === "function" ? node.getStart() : node.pos;
            if (typeof start === "number") {
                let bucket = idx.get(start);
                if (!bucket) { bucket = []; idx.set(start, bucket); }
                bucket.push(node);
            }
            if (typeof node.forEachChild === "function") {
                node.forEachChild(visit);
            }
        };
        if (sf) visit(sf);
        if (process.env.TSGO_PROFILE === "1") { _stats.indexBuildMs += Date.now() - t0; _stats.indexBuildCount++; }
        return idx;
    }

    function ensureFileSymbolsPrefetched(fileName: string): void {
        const cacheName = symCacheFileName(fileName);
        if (symPrefetched.has(cacheName)) return;
        pushHostOverlayToTsgo(fileName);
        const activeProject = _currentProjectRef.project ?? project;
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        let byPos: Map<number, any>;
        if (typeof activeProject?.checker?.prefetchResolvedReferences === "function") {
            byPos = activeProject.checker.prefetchResolvedReferences(toTsgoFileName(fileName), "allIdentifiers");
        } else {
            return;
        }
        symPrefetched.add(cacheName);
        const fileCache = getSymFileCache(cacheName, true)!;
        for (const [pos, sym] of byPos) {
            fileCache.set(pos, sym);
        }
        symPrefetchPopulated.add(cacheName);
        if (process.env.TSGO_PROFILE === "1") {
            _stats.symPrefetchFiles++;
            _stats.symPrefetchRefs += byPos.size;
            _stats.symPrefetchMs += Date.now() - t0;
        }
    }

    /**
     * Batch-resolve the module symbols of every import/export/require/import()
     * specifier in a file with ONE getSymbolsAtLocations RPC, seeded from the
     * tsgo SourceFile's `imports` node list (decoded from the binary blob — no
     * AST walk, no node-index build). Multi-project lint runners (BuilderState
     * referencedMap, dependency cache hashing) call getSymbolAtLocation on every
     * import literal of every program file; per-literal positional RPC plus the
     * node-index fallback dominated lint wall time. Results (including
     * undefined for unresolved modules) are stored positionally so subsequent
     * queries hit symByPos. Returns false when the file has no tsgo mirror.
     */
    function ensureModuleSpecifierSymbolsPrefetched(fileName: string): boolean {
        const cacheName = symCacheFileName(fileName);
        if (moduleSpecPrefetched.has(cacheName)) return true;
        const sf = getTsgoSourceFile(fileName);
        if (!sf) return false;
        moduleSpecPrefetched.add(cacheName);
        const importNodes: readonly any[] = sf.imports ?? [];
        if (!importNodes.length) return true;
        let syms: readonly any[];
        try {
            syms = project.checker.getSymbolAtLocation(importNodes as any[]) ?? [];
        } catch {
            moduleSpecPrefetched.delete(cacheName);
            return false;
        }
        for (let i = 0; i < importNodes.length; i++) {
            const n = importNodes[i];
            const pos = typeof n.pos === "number" ? n.pos : undefined;
            const end = typeof n.end === "number" ? n.end : undefined;
            if (pos === undefined || end === undefined) continue;
            storeSymCache(cacheName, pos, end, refineNavSymbol(syms[i]));
        }
        return true;
    }

    function findTsgoNodeAtPosition(fileName: string, pos: number, expectedKind?: number, expectedEnd?: number): any {
        const cacheKey = expectedKind != null
            ? `${pos}:${expectedEnd ?? -1}:${expectedKind}`
            : `${pos}`;
        let fileCache = nodeAtPosCache.get(fileName);
        if (fileCache) {
            const hit = fileCache.get(cacheKey);
            if (hit !== undefined) return hit;
        } else {
            fileCache = new Map();
            nodeAtPosCache.set(fileName, fileCache);
        }

        const sf = getTsgoSourceFile(fileName);
        let result: any = undefined;
        if (sf) {
            const idx = buildNodeIndex(fileName, sf);
            const bucket = idx?.get(pos);
            if (bucket && bucket.length) {
                let bestWithKind: any = undefined;
                let bestWithKindAndEnd: any = undefined;
                for (const node of bucket) {
                    if (expectedKind != null && node.kind === expectedKind) {
                        if (!bestWithKind) bestWithKind = node;
                        if (expectedEnd != null) {
                            const end = typeof node.getEnd === "function" ? node.getEnd() : node.end;
                            if (end === expectedEnd) {
                                bestWithKindAndEnd = node;
                                break;
                            }
                        }
                    }
                }
                // Children are pushed after their parent in pre-order
                // traversal, so the last entry sharing a start position is
                // the innermost (deepest) node — matches the old "deepest
                // containing" fallback semantics.
                result = bestWithKindAndEnd ?? bestWithKind ?? bucket[bucket.length - 1];
                // Never map a non-zero position to the file root — LS passes
                // DotToken/etc. that RemoteSourceFile's index may not contain;
                // sending SourceFile to getContextualType panics Go (nil parent).
                if (result?.kind === SyntaxKind.SourceFile && pos > 0) result = undefined;
            }
        }
        fileCache.set(cacheKey, result);
        return result;
    }

    // ── Host↔tsgo symbol RPC boundary ────────────────────────────────
    // Two kinds of symbols flow through the checker surface:
    //   1. tsgo bridge symbols (native-preview _sync.Symbol) — their .id is a
    //      snapshot-registry handle that can cross the bridge.
    //   2. stock TS SymbolObjects — produced by the JS host's binder for
    //      host-bound SourceFiles (Volar virtual files, LS navigation) and by
    //      stock services aggregating symbols during completion. Their .id
    //      (getSymbolId) is NOT a bridge handle; sending it faults server-side
    //      ("symbol handle not found in snapshot registry").
    // Every RPC that can carry a Symbol argument goes through rpc(), a facade
    // over project.checker that resolves host symbols to their tsgo
    // counterpart (declaration position → tsgo node → tsgo symbol) before
    // forwarding. This is the single INBOUND dispatch point; the OUTBOUND
    // direction (tsgo symbol → host navigation symbol) is refineNavSymbol.
    // Adapter methods therefore never branch on a symbol's origin.

    /** Host→tsgo resolution memo; cleared with symByPos on overlay refresh. */
    const rpcSymbolCache = new Map<any, any>();

    function tsgoSymbolForHostDeclaration(decl: any): any {
        const sf = decl?.getSourceFile?.();
        if (!sf?.fileName) return undefined;
        // Anchor on the declaration's name node when present — identifiers sit
        // at identical offsets in the tsgo AST (host text is the overlay
        // source of truth for tsgo).
        const node = decl.kind !== SyntaxKind.SourceFile && decl.name && typeof decl.name.getStart === "function"
            ? decl.name
            : decl;
        let start: number | undefined;
        let end: number | undefined;
        try {
            start = node.getStart(sf);
            end = node.getEnd(sf);
        } catch {
            return undefined;
        }
        if (typeof start !== "number") return undefined;
        const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
        // findTsgoNodeAtPosition falls back to the innermost node (or the
        // SourceFile) on a miss; the mapping is only valid when the tsgo node
        // is the same syntax at the same coordinates.
        if (!tsgoNode || tsgoNode.kind !== node.kind) return undefined;
        if (node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier) {
            const hostText = node.escapedText ?? node.text;
            const remoteText = tsgoNode.escapedText ?? tsgoNode.text;
            if (hostText != null && remoteText != null && String(hostText) !== String(remoteText)) return undefined;
        }
        try {
            return project.checker.getSymbolAtLocation(tsgoNode) ?? undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Resolve any checker-surface symbol to one that can cross the tsgo
     * bridge. Bridge symbols pass through unchanged; host symbols resolve via
     * their declaration positions. Returns undefined only when the symbol has
     * no tsgo counterpart (e.g. declared solely in a host-only virtual file
     * with no tsgo mirror).
     */
    function resolveRpcSymbol(symbol: any): any {
        if (!symbol) return undefined;
        if (isTsgoBridgeSymbol(symbol)) return symbol;
        if (rpcSymbolCache.has(symbol)) return rpcSymbolCache.get(symbol);
        let resolved: any;
        const decls = symbol.declarations?.length
            ? symbol.declarations
            : symbol.valueDeclaration ? [symbol.valueDeclaration] : [];
        for (const decl of decls) {
            resolved = tsgoSymbolForHostDeclaration(decl);
            if (resolved) break;
        }
        rpcSymbolCache.set(symbol, resolved);
        return resolved;
    }

    /** A checker Symbol argument (stock SymbolObject or bridge Symbol) — vs Node/Type/Signature. */
    function isSymbolArg(value: any): boolean {
        if (!value || typeof value !== "object") return false;
        if (typeof value.kind === "number") return false; // AST node
        if (typeof value.escapedName === "string") return true;
        const BridgeSymbol = _sync?.Symbol;
        return !!BridgeSymbol && value instanceof BridgeSymbol;
    }

    const rpcFacadeByChecker = new WeakMap<any, any>();
    function makeRpcFacade(rawChecker: any): any {
        const wrappedByProp = new Map<PropertyKey, any>();
        return new Proxy(rawChecker, {
            get(target: any, prop: string | symbol) {
                const cached = wrappedByProp.get(prop);
                if (cached) return cached;
                const val = target[prop];
                if (typeof val !== "function") return val;
                const fn = (...args: any[]) => {
                    // original-by-resolved: when the checker echoes a resolved
                    // symbol back (self-root, non-export= module, …), hand the
                    // caller its own object so identity comparisons at
                    // reference sites keep working.
                    let originalByResolved: Map<any, any> | undefined;
                    for (let i = 0; i < args.length; i++) {
                        if (isSymbolArg(args[i])) {
                            const resolved = resolveRpcSymbol(args[i]);
                            // A symbol with no tsgo counterpart has no answer
                            // on this checker; undefined is the RPC "no result".
                            if (resolved === undefined) return undefined;
                            if (resolved !== args[i]) {
                                (originalByResolved ??= new Map()).set(resolved, args[i]);
                                args[i] = resolved;
                            }
                        }
                    }
                    const result = val.apply(target, args);
                    if (!originalByResolved) return result;
                    if (originalByResolved.has(result)) return originalByResolved.get(result);
                    if (Array.isArray(result)) {
                        return result.map(r => originalByResolved!.get(r) ?? r);
                    }
                    return result;
                };
                wrappedByProp.set(prop, fn);
                return fn;
            },
        });
    }

    /**
     * The single RPC-forwarding boundary for symbol-carrying checker calls.
     * Every adapter call that may receive a Symbol argument MUST go through
     * this facade rather than project.checker. Symbol-free calls (node/type/
     * signature queries — the lint hot path) go to project.checker directly
     * and must not pay the facade's per-call argument scan; the checker proxy
     * therefore requires every symbol-accepting tsgo method to have an
     * explicit adapter entry, keeping its unknown-method forward symbol-free.
     */
    function rpc(): any {
        const raw = project.checker;
        let facade = rpcFacadeByChecker.get(raw);
        if (!facade) {
            facade = makeRpcFacade(raw);
            rpcFacadeByChecker.set(raw, facade);
        }
        return facade;
    }

    // ── Type / Symbol prototype patches ──────────────────────────────
    let typeProtoPatched = false;
    let symbolProtoPatched = false;

    function getTypePrototype(sample: any): any {
        let proto = Object.getPrototypeOf(sample);
        while (proto && Object.getPrototypeOf(proto) !== Object.prototype) {
            proto = Object.getPrototypeOf(proto);
        }
        return proto ?? undefined;
    }

    function installTypePredicates(target: any, s: any): void {
        if (typeof target.isUnionOrIntersection === "function") return;
        // NOTE: don't check `target.flags` here — when target is a prototype,
        // `flags` lives on instances, not the proto. The `has` closures read
        // `this.flags` at call time, so they work on instances regardless.
        const TF = s.TypeFlags;
        const has = (flag: number) => function (this: any) { return (this.flags & flag) !== 0; };
        if (!target.isStringLiteral) target.isStringLiteral = has(TF.StringLiteral);
        if (!target.isNumberLiteral) target.isNumberLiteral = has(TF.NumberLiteral);
        if (!target.isBooleanLiteral) target.isBooleanLiteral = has(TF.BooleanLiteral);
        if (!target.isBigIntLiteral) target.isBigIntLiteral = has(TF.BigIntLiteral);
        if (!target.isEnumLiteral) target.isEnumLiteral = has(TF.EnumLiteral);
        if (!target.isLiteral) target.isLiteral = has(TF.StringLiteral | TF.NumberLiteral | TF.BigIntLiteral | TF.BooleanLiteral);
        if (!target.isUnion) target.isUnion = has(TF.Union);
        if (!target.isIntersection) target.isIntersection = has(TF.Intersection);
        if (!target.isUnionOrIntersection) target.isUnionOrIntersection = has(TF.UnionOrIntersection ?? (TF.Union | TF.Intersection));
        if (!target.isTypeParameter) target.isTypeParameter = has(TF.TypeParameter);
        // Mirror stock Type.isClassOrInterface/isClass: read ObjectFlags off
        // Object-flagged types. Class/Interface live in the low bits, which are
        // identical between the tsgo and fork ObjectFlags layouts, so this is
        // safe whether or not the instance's objectFlags were remapped yet.
        const OF = (ts as any).ObjectFlags;
        const objectFlagsOf = function (t: any): number {
            return (t.flags & TF.Object) !== 0 && typeof t.objectFlags === "number" ? t.objectFlags : 0;
        };
        if (!target.isClassOrInterface) target.isClassOrInterface = function (this: any) { return (objectFlagsOf(this) & (OF.Class | OF.Interface)) !== 0; };
        if (!target.isClass) target.isClass = function (this: any) { return (objectFlagsOf(this) & OF.Class) !== 0; };
        if (!target.isIndexType) target.isIndexType = has(TF.Index);
        if (!target.getFlags) target.getFlags = function () { return this.flags; };
        if (!target.isNullableType) target.isNullableType = has((TF.Null ?? 0) | (TF.Undefined ?? 0));
    }

    function patchTypeProto(sample: any, s: any): void {
        const proto = getTypePrototype(sample);
        if (!proto || typeProtoPatched) {
            installTypePredicates(sample, s);
            return;
        }
        typeProtoPatched = true;
        installTypePredicates(proto, s);
        if (!Object.getOwnPropertyDescriptor(proto, "types")) {
            Object.defineProperty(proto, "types", {
                configurable: true,
                get() {
                    if (this.__tsgoTypesMemo !== undefined) return this.__tsgoTypesMemo;
                    const types = this.getTypes ? this.getTypes() : undefined;
                    if (types) for (const c of types) fixupType(c);
                    this.__tsgoTypesMemo = types;
                    return types;
                },
            });
        }
        // getCallSignatures / getConstructSignatures — delegate to checker's
        // getSignaturesOfType. Short-circuit for primitive/literal types.
        const TF = s.TypeFlags;
        const SK = s.SignatureKind;
        const noSigMask = (TF.Never ?? 0) | (TF.Undefined ?? 0) | (TF.Null ?? 0) | (TF.Void ?? 0) |
            (TF.StringLiteral ?? 0) | (TF.NumberLiteral ?? 0) | (TF.BooleanLiteral ?? 0) |
            (TF.BigIntLiteral ?? 0) | (TF.EnumLiteral ?? 0) | (TF.TemplateLiteral ?? 0) |
            (TF.StringMapping ?? 0) | (TF.UniqueESSymbol ?? 0) | (TF.Enum ?? 0);
        if (!proto.getCallSignatures) {
            proto.getCallSignatures = function () {
                if (typeof this.flags === "number" && (this.flags & noSigMask) !== 0) return [];
                const sigs = getSignaturesCached(this, SK.Call);
                return sigs ?? [];
            };
        }
        if (!proto.getConstructSignatures) {
            proto.getConstructSignatures = function () {
                if (typeof this.flags === "number" && (this.flags & noSigMask) !== 0) return [];
                return getSignaturesCached(this, SK.Construct);
            };
        }
        // getProperties / getProperty / getApparentProperties — delegate to
        // checker.getPropertiesOfType. Rule code reads these directly off
        // Type objects (e.g. no-unnecessary-type-assertion's hasSameProperties).
        if (!proto.getProperties) {
            proto.getProperties = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return [];
                return memoGet(propertiesCache, this, () => proj.checker.getPropertiesOfType(this) ?? []);
            };
        }
        if (!proto.getProperty) {
            proto.getProperty = function (name: string) {
                return resolvePropertyOfType(this, name);
            };
        }
        if (!proto.getApparentProperties) {
            proto.getApparentProperties = function () {
                return this.getProperties();
            };
        }
        if (!proto.getBaseTypes) {
            proto.getBaseTypes = function () {
                return getBaseTypesCached(this);
            };
        }
        if (!proto.getNonNullableType) {
            proto.getNonNullableType = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return this;
                const t = proj.checker.getNonNullableType(this);
                if (t) fixupType(t);
                return t ?? this;
            };
        }
        if (!proto.getNonOptionalType) {
            proto.getNonOptionalType = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return this;
                const t = proj.checker.getNonOptionalType(this);
                if (t) fixupType(t);
                return t ?? this;
            };
        }
        // getConstraint — delegate to checker.getConstraintOfTypeParameter for
        // type parameters; returns undefined for non-type-parameter types.
        if (!proto.getConstraint) {
            proto.getConstraint = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return undefined;
                if (typeof this.flags === "number" && (this.flags & TF.TypeParameter) !== 0) {
                    const t = proj.checker.getConstraintOfTypeParameter(this);
                    if (t) fixupType(t);
                    return t;
                }
                return undefined;
            };
        }
        // getNumberIndexType / getStringIndexType — rule code (no-for-in-array's
        // isArrayLike, ts-api-utils' rest-param handling) reads these directly
        // off Type objects. Resolve via the checker's index infos: find the
        // info whose key type matches Number/String and return its value type.
        // Falls back to the apparent type so inherited index signatures resolve.
        const indexTypeOfKind = (self: any, keyFlag: number): any => {
            const proj = _currentProjectRef.project;
            if (!proj || !self) return undefined;
            const pick = (t: any): any => {
                const infos = proj.checker.getIndexInfosOfType(t) ?? [];
                for (const info of infos) {
                    const kt = info?.keyType;
                    if (kt && typeof kt.flags === "number" && (kt.flags & keyFlag) !== 0) {
                        const vt = info.valueType;
                        if (vt) fixupType(vt);
                        return vt;
                    }
                }
                return undefined;
            };
            const direct = pick(self);
            if (direct !== undefined) return direct;
            try {
                const apparent = proj.checker.getApparentType(self);
                if (apparent && apparent !== self) {
                    if (apparent) fixupType(apparent);
                    return pick(apparent);
                }
            } catch { /* best-effort */ }
            return undefined;
        };
        if (!proto.getNumberIndexType) {
            proto.getNumberIndexType = function () { return indexTypeOfKind(this, TF.Number); };
        }
        if (!proto.getStringIndexType) {
            proto.getStringIndexType = function () { return indexTypeOfKind(this, TF.String); };
        }
    }

    // ── Signature prototype patch ────────────────────────────────────
    let signatureProtoPatched = false;
    function patchSignatureProto(s: any): void {
        if (signatureProtoPatched) return;
        const SignatureCtor = s.Signature;
        if (!SignatureCtor?.prototype) return;
        const proto = SignatureCtor.prototype;
        signatureProtoPatched = true;
        // getReturnType — delegate to checker.getReturnTypeOfSignature + fixup.
        if (!proto.getReturnType) {
            proto.getReturnType = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return undefined;
                const t = proj.checker.getReturnTypeOfSignature(this);
                if (t) fixupType(t);
                return t;
            };
        }
        // getDeclaration — tsgo stores it as `this.declaration` (a NodeHandle).
        if (!proto.getDeclaration) {
            proto.getDeclaration = function () { return this.declaration; };
        }
        // vue-component-meta reads signature docs via getDocumentationComment(checker)
        // and getJsDocTags(checker). tsgo's Signature class omits both; stock TS
        // resolves them from signature.declaration JSDoc.
        // tsgo has no signature-level doc RPC, so the only source is the JSDoc on
        // signature.declaration. Memoise only non-empty results: a transient empty
        // read (e.g. declaration not yet resolvable) must not be cached permanently.
        proto.getDocumentationComment = function (_checker: any) {
            if (this.__tnbDocComment) return this.__tnbDocComment;
            const decl = resolveDocDeclaration(this.declaration);
            if (!decl) return [];
            let parts: any[] = [];
            try {
                parts = jsDocCommentsFromDeclarations([decl]) ?? [];
            }
            catch { parts = []; }
            if (parts.length) this.__tnbDocComment = parts;
            return parts;
        };
        proto.getJsDocTags = function (_checker: any) {
            if (this.__tnbJsDocTags) return this.__tnbJsDocTags;
            const decl = resolveDocDeclaration(this.declaration);
            if (!decl) return [];
            let tags: any[] = [];
            try {
                tags = jsDocTagsFromDeclarations([decl]) ?? [];
            }
            catch { tags = []; }
            if (tags.length) this.__tnbJsDocTags = tags;
            return tags;
        };
    }

    function patchSymbolProto(s: any): void {
        if (symbolProtoPatched) return;
        const SymbolCtor = s.Symbol;
        if (!SymbolCtor?.prototype) return;
        const proto = SymbolCtor.prototype;
        symbolProtoPatched = true;
        if (!proto.getName) proto.getName = function () { return this.name; };
        if (!proto.getEscapedName) proto.getEscapedName = function () { return this.name; };
        if (!proto.getFlags) proto.getFlags = function () { return this.flags; };
        if (!proto.getDeclarations) proto.getDeclarations = function () { return this.declarations; };
        if (!Object.getOwnPropertyDescriptor(proto, "escapedName")) {
            Object.defineProperty(proto, "escapedName", { configurable: true, get() { return this.name; } });
        }
        // Stock TransientSymbol carries `links.checkFlags`; getCheckFlags reads
        // it whenever SymbolFlags.Transient is set. tsgo symbols expose raw
        // `checkFlags` (bit layout audited identical) but no `links` object, so
        // a Transient-flagged tsgo symbol flowing into stock services
        // (find-all-refs fromRoot, SymbolDisplay getSymbolKind) would crash on
        // `links.checkFlags`. Satisfy the contract at the prototype.
        if (!Object.getOwnPropertyDescriptor(proto, "links")) {
            Object.defineProperty(proto, "links", {
                configurable: true,
                get() {
                    return this.__tnbLinks ??= { checkFlags: this.checkFlags ?? 0 };
                },
            });
        }
        // tsgo Symbol.getDocumentationComment returns plain text from RPC; stock TS
        // and vue-component-meta expect SymbolDisplayPart[] via displayPartsToString.
        // Resolution order: (1) genuine host AST declarations -> stock JSDoc parser
        // (authoritative for host/.vue virtual symbols); (2) tsgo-backed symbol
        // (id>0) -> native checker RPC (authoritative for tsgo symbols); (3) last
        // resort, resolve a tsgo declaration handle and parse its JSDoc. Each step
        // only "wins" on a non-empty result so a barren host node still falls
        // through to the RPC for hybrid symbols carrying both.
        proto.getDocumentationComment = function (checker: any) {
            const decls = this.declarations ?? (this.valueDeclaration ? [this.valueDeclaration] : undefined);
            if (decls?.length && isHostSyntaxNode(decls[0])) {
                try {
                    const parts = jsDocCommentsFromDeclarations(decls) ?? [];
                    if (parts.length) return parts;
                }
                catch { /* fall through */ }
            }
            if (typeof this.id === "number" && this.id > 0 && checker?.getDocumentationCommentOfSymbol) {
                try {
                    const text = checker.getDocumentationCommentOfSymbol(this);
                    const parts = displayPartsFromDocText(typeof text === "string" ? text : "");
                    if (parts.length) return parts;
                }
                catch { /* fall through */ }
            }
            if (decls?.length) {
                const decl = resolveDocDeclaration(decls[0]);
                if (decl) {
                    try {
                        return jsDocCommentsFromDeclarations([decl]) ?? [];
                    }
                    catch { /* empty */ }
                }
            }
            return [];
        };
        if (!proto.getContextualDocumentationComment) {
            proto.getContextualDocumentationComment = function (context: any) {
                try {
                    const parts = this.getDocumentationComment?.(context?.checker ?? context);
                    if (Array.isArray(parts)) return parts;
                } catch {
                    // fall through
                }
                return [];
            };
        }
        if (!proto.getContextualJsDocTags) {
            proto.getContextualJsDocTags = function (context: any) {
                try {
                    const tags = this.getJsDocTags?.(context?.checker ?? context);
                    if (Array.isArray(tags)) return tags;
                } catch {
                    // fall through
                }
                return [];
            };
        }
        proto.getJsDocTags = function (checker: any) {
            const decls = this.declarations ?? (this.valueDeclaration ? [this.valueDeclaration] : undefined);
            if (decls?.length && isHostSyntaxNode(decls[0])) {
                try {
                    const tags = jsDocTagsFromDeclarations(decls) ?? [];
                    if (tags.length) return tags;
                }
                catch { /* fall through */ }
            }
            if (typeof this.id === "number" && this.id > 0 && checker?.getJsDocTagsOfSymbol) {
                try {
                    const tags = checker.getJsDocTagsOfSymbol(this) ?? [];
                    if (tags.length) return tags;
                }
                catch { /* fall through */ }
            }
            if (decls?.length) {
                const decl = resolveDocDeclaration(decls[0]);
                if (decl) {
                    try {
                        return jsDocTagsFromDeclarations([decl]) ?? [];
                    }
                    catch { /* empty */ }
                }
            }
            return [];
        };
    }

    // Resolve raw type-ID properties on TypeObject to full TypeObject
    // instances. tsgo stores IDs (numbers) in fields like `aliasTypeArguments`,
    // `target`, `typeParameters`, etc. Rule code reads these directly and
    // expects Type objects, so we eagerly resolve them via the corresponding
    // getter methods (which read the raw IDs before we overwrite them).
    const TYPE_ARRAY_PROPS: [string, string][] = [
        ["aliasTypeArguments", "getAliasTypeArguments"],
        ["typeParameters", "getTypeParameters"],
        ["outerTypeParameters", "getOuterTypeParameters"],
        ["localTypeParameters", "getLocalTypeParameters"],
    ];
    const TYPE_SINGLE_PROPS: [string, string][] = [
        ["target", "getTarget"],
        ["freshType", "getFreshType"],
        ["regularType", "getRegularType"],
        ["objectType", "getObjectType"],
        ["indexType", "getIndexType"],
        ["checkType", "getCheckType"],
        ["extendsType", "getExtendsType"],
        ["baseType", "getBaseType"],
    ];

    function resolveRawTypeProps(obj: any): void {
        for (const [prop, method] of TYPE_ARRAY_PROPS) {
            const raw = obj[prop];
            if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "number") {
                try {
                    const resolved = obj[method]();
                    if (resolved) { fixupType(resolved); obj[prop] = resolved; }
                } catch { /* best-effort */ }
            }
        }
        for (const [prop, method] of TYPE_SINGLE_PROPS) {
            const raw = obj[prop];
            if (typeof raw === "number") {
                try {
                    const resolved = obj[method]();
                    if (resolved) { fixupType(resolved); obj[prop] = resolved; }
                } catch { /* best-effort */ }
            }
        }
    }

    function fixupType(t: any): any {
        if (Array.isArray(t)) { for (const i of t) fixupType(i); return t; }
        if (t && typeof t === "object") {
            const obj = t;
            if (!obj.__tsgoFixupDone) {
                obj.__tsgoFixupDone = true;
                // Remap tsgo ObjectFlags bit layout → fork layout before the
                // value reaches consumers (e.g. no-misused-spread reads
                // `type.objectFlags & ts.ObjectFlags.InstantiationExpressionType`).
                if (typeof obj.objectFlags === "number") {
                    obj.objectFlags = remapObjectFlags(obj.objectFlags);
                }
                if (typeof obj.aliasSymbol === "number" && typeof obj.getAliasSymbol === "function") {
                    try { obj.aliasSymbol = obj.getAliasSymbol(); } catch { obj.aliasSymbol = undefined; }
                }
                if (typeof obj.getSymbol === "function") {
                    try { const sym = obj.getSymbol(); if (sym) obj.symbol = sym; } catch { /* best-effort */ }
                }
                resolveRawTypeProps(obj);
                // tsgo may expose `aliasTypeArguments: []` on reference/array
                // types. Rule helpers (no-unnecessary-type-assertion's
                // containsAny) use `type.aliasTypeArguments ??
                // checker.getTypeArguments(type)` — an empty array is
                // truthy for ?? so getTypeArguments is never consulted and
                // `any[]` is misclassified as not containing `any`.
                const aliasArgs = obj.aliasTypeArguments;
                if (Array.isArray(aliasArgs) && aliasArgs.length === 0) {
                    try {
                        const resolved = typeof obj.getAliasTypeArguments === "function"
                            ? obj.getAliasTypeArguments()
                            : undefined;
                        if (Array.isArray(resolved) && resolved.length > 0) {
                            fixupType(resolved);
                            obj.aliasTypeArguments = resolved;
                        }
                        else {
                            delete obj.aliasTypeArguments;
                        }
                    }
                    catch {
                        delete obj.aliasTypeArguments;
                    }
                }
            }
            patchTypeProto(obj, sync);
        }
        return t;
    }

    // ── Caches ───────────────────────────────────────────────────────
    const nodeTypeCache = new Map<any, any>();
    const typeOfSymbolCache = new Map<any, any>();
    const propertiesCache = new Map<any, any>();
    // Per-type name→property map, built lazily from the memoized
    // getPropertiesOfType result. Collapses N getPropertyOfType(name)
    // RPCs into 1 getPropertiesOfType RPC + JS lookup per type.
    const propertyByNameCache = new Map<any, Map<string, any>>();
    // Per-type signature cache keyed by SignatureKind. Unifies the proto
    // (type.getCallSignatures/getConstructSignatures) and adapter
    // (checker.getSignaturesOfType) paths onto one RPC per (type, kind).
    const signaturesByKindCache = new Map<any, Map<number, readonly any[]>>();
    // Per-type base-types cache. Unifies proto (type.getBaseTypes) and adapter
    // (checker.getBaseTypes) onto one RPC per type.
    const baseTypesCache = new Map<any, readonly any[]>();
    // Types for which getPropertiesOfType was used to bulk-fill propertyByNameCache.
    const propertyBulkLoaded = new Set<any>();

    const memoGet = <K, V>(cache: Map<K, V>, key: K, compute: () => V): V => {
        if (cache.has(key)) return cache.get(key)!;
        const v = compute();
        cache.set(key, v);
        return v;
    };

    // ── Object-literal completion batch ──────────────────────────────
    // Stock Completions.getPropertiesForObjectExpression makes O(3N) checker
    // calls for a union contextual type: getPromisedTypeOfPromise per member,
    // then isArrayLikeType / isTypeInvalidDueToUnionDiscriminant /
    // typeHasCallOrConstructSignatures per member of the filtered union — each
    // one a synchronous NAPI round trip through this adapter. getContextualType
    // records the last object-literal / JSX-attributes query; the first
    // per-member call then runs the whole pipeline server-side in ONE composite
    // RPC (getPropertiesForObjectExpression) and seeds the answers below, so
    // the remaining stock calls become cache hits. Every seeded answer is
    // exactly what the corresponding per-call RPC would have returned; any
    // cache miss falls through to the original RPC, so this is purely a
    // batching layer.
    interface ObjCompletionBatch {
        hostNode: any;
        completionsType: any;
        promised: Map<any, any>; // contextual member → promised type | null
        pfMembers: any[]; // members surviving the promise filter, in order
        pf: any; // union of pfMembers
        merged: any; // pf ∪ completionsType, when applicable
        isFinalUnion: boolean;
        verdicts: Map<any, { isArrayLike: boolean; invalidDueToUnionDiscriminant: boolean; hasCallOrConstructSignatures: boolean }>;
        filteredMembers: any[]; // final members surviving the stock filter
        properties: any[];
    }
    let _objCompletionPending: { hostNode: any; tsgoNode: any; results: any[] } | undefined;
    let _objCompletionBatch: ObjCompletionBatch | undefined;

    const sameTypeList = (a: readonly any[], b: readonly any[]): boolean =>
        a.length === b.length && a.every((t, i) => t === b[i]);

    // A batch only answers queries while the stock pipeline is still working on
    // the same object literal; when a new object-literal contextual query
    // arrives, the next per-member call recomputes for the new node (the
    // discriminant verdicts are node-dependent).
    const activeObjCompletionBatch = (): ObjCompletionBatch | undefined => {
        const b = _objCompletionBatch;
        if (!b) return undefined;
        if (_objCompletionPending && _objCompletionPending.hostNode !== b.hostNode) return undefined;
        return b;
    };

    // Fires the composite RPC when `memberType` is the contextual type (or one
    // of its already-materialized union members) recorded for the pending
    // object-literal completion. Union members are matched via __tsgoTypesMemo
    // only: completions.ts reads `.types` before filtering, so the memo is
    // already populated and this check never issues an RPC of its own.
    const tryStartObjCompletionBatch = (memberType: any): ObjCompletionBatch | undefined => {
        const pending = _objCompletionPending;
        const proj = _currentProjectRef.project;
        if (!pending || !proj || typeof proj.checker.getPropertiesForObjectExpression !== "function") return undefined;
        let contextualType: any;
        for (const t of pending.results) {
            if (!t) continue;
            if (t === memberType || (Array.isArray(t.__tsgoTypesMemo) && t.__tsgoTypesMemo.includes(memberType))) {
                contextualType = t;
                break;
            }
        }
        if (!contextualType) return undefined;
        // Stock's completionsType is the result of the LAST getContextualType
        // call on the node (ContextFlags.IgnoreNodeInferences). The adapter
        // drops context flags, so this is normally === contextualType and the
        // merged-union branch stays dead, matching the stock comparison.
        const last = pending.results[pending.results.length - 1];
        const completionsType = last && last !== contextualType ? last : undefined;
        let info: any;
        try {
            info = proj.checker.getPropertiesForObjectExpression(contextualType, completionsType, pending.tsgoNode);
        }
        catch {
            return undefined;
        }
        if (!info) return undefined;
        const TF = sync.TypeFlags;
        const promised = new Map<any, any>();
        const pfMembers: any[] = [];
        for (const m of info.members) {
            fixupType(m.type);
            if (m.promisedType) fixupType(m.promisedType);
            promised.set(m.type, m.promisedType ?? null);
            if (!m.promisedType) pfMembers.push(m.type);
        }
        fixupType(info.promiseFilteredType);
        if (info.mergedType) fixupType(info.mergedType);
        const verdicts = new Map<any, any>();
        for (const fm of info.finalMembers) {
            fixupType(fm.type);
            // Primitive members were skipped server-side (stock short-circuits
            // before any checker call); leave them out so an unexpected query
            // falls through to the real RPC instead of a fabricated verdict.
            if ((fm.type.flags & TF.Primitive) === 0) verdicts.set(fm.type, fm);
            if (fm.apparentProperties && !propertiesCache.has(fm.type)) {
                propertiesCache.set(fm.type, fm.apparentProperties);
            }
        }
        for (const t of info.filteredTypes) fixupType(t);
        const finalType = info.mergedType ?? info.promiseFilteredType;
        const isFinalUnion = info.finalMembers.length > 0;
        // Non-union final type: stock calls type.getApparentProperties() on it,
        // which routes through propertiesCache — seed it.
        if (!isFinalUnion && finalType && !propertiesCache.has(finalType)) {
            propertiesCache.set(finalType, info.properties);
        }
        _objCompletionBatch = {
            hostNode: pending.hostNode,
            completionsType,
            promised,
            pfMembers,
            pf: info.promiseFilteredType,
            merged: info.mergedType,
            isFinalUnion,
            verdicts,
            filteredMembers: info.filteredTypes,
            properties: info.properties as any[],
        };
        return _objCompletionBatch;
    };

    const resolvePropertyOfType = (type: any, name: string): any => {
        const proj = _currentProjectRef.project;
        if (!proj || !type) return undefined;
        let byName = propertyByNameCache.get(type);
        if (!byName) {
            byName = new Map<string, any>();
            propertyByNameCache.set(type, byName);
        }
        if (byName.has(name)) return byName.get(name);
        // One getPropertiesOfType RPC per type replaces many getPropertyOfType RPCs.
        if (!propertyBulkLoaded.has(type)) {
            propertyBulkLoaded.add(type);
            const props = memoGet(propertiesCache, type, () => proj.checker.getPropertiesOfType(type) ?? []);
            for (const p of props) {
                if (p?.name) byName.set(p.name, p);
            }
            if (byName.has(name)) return byName.get(name);
        }
        const direct = proj.checker.getPropertyOfType(type, name);
        byName.set(name, direct);
        return direct;
    };

    const getSignaturesCached = (type: any, kind: number): readonly any[] => {
        const proj = _currentProjectRef.project;
        if (!proj) return [];
        let byKind = signaturesByKindCache.get(type);
        if (!byKind) { byKind = new Map(); signaturesByKindCache.set(type, byKind); }
        const hit = byKind.get(kind);
        if (hit !== undefined) return hit;
        const r = proj.checker.getSignaturesOfType(type, kind) ?? [];
        byKind.set(kind, r);
        return r;
    };

    const getBaseTypesCached = (type: any): readonly any[] => {
        const proj = _currentProjectRef.project;
        if (!proj) return [];
        return memoGet(baseTypesCache, type, () => proj.checker.getBaseTypes(type) ?? []);
    };

    // Faithful forward: tsgo GetTypeAtLocation (checker getTypeOfNode) handles
    // assertion, call, property/element access, and non-null expressions the
    // same way stock does. The former per-kind dispatch here compensated for
    // the position-based getTypeAtPosition era of the bridge and is obsolete
    // now that the node-based RPC exists.
    function computeGetTypeAtLocation(tsgoNode: any): any {
        const t = project.checker.getTypeAtLocation(tsgoNode);
        if (t) fixupType(t);
        return t;
    }

    // ── Build adapter object ─────────────────────────────────────────
    const getHostBoundSf = (fileName: string): any | undefined => {
        const getSourceFile = _hostProgramRef?.getSourceFile ?? program.getSourceFile;
        const sf = getSourceFile?.(fileName);
        if (!sf?.__tnbHostBound) return undefined;
        return sf;
    };
    const refineNavSymbol = (sym: any) => {
        if (!sym) return sym;
        if (!_hasHostBoundFiles) return ensureSymbolContextualDocCompat(sym);
        const cached = refinedSymBySym.get(sym);
        if (cached !== undefined) return cached;
        const refined = ensureSymbolContextualDocCompat(refineHostNavigationSymbol(sym, getHostBoundSf));
        if (_traceSymEnabled) traceSym(`refineNavSymbol in=${traceSymSymbol(sym)} out=${traceSymSymbol(refined)}`);
        refinedSymBySym.set(sym, refined);
        return refined;
    };

    let checkerProxyRef: any;

    function shouldTreatPropertiesOfExternalModuleAsExports(type: any): boolean {
        if (!type) return false;
        const TF = sync.TypeFlags;
        const OF = sync.ObjectFlags;
        if (type.flags & TF.Primitive) return false;
        if (type.objectFlags & OF.Class) return false;
        ensureProject();
        try {
            if (project.checker.isArrayType?.(type)) return false;
            if (project.checker.isTupleType?.(type)) return false;
        } catch { /* conservative */ }
        return true;
    }

    function tryGetMemberInModuleExportsImpl(memberName: any, moduleSymbol: any): any {
        if (moduleSymbol?.exports) {
            const sym = moduleSymbol.exports.get(memberName);
            return sym ? refineNavSymbol(sym) : undefined;
        }
        ensureProject();
        try {
            return refineNavSymbol(rpc().getMemberInModuleExports(moduleSymbol, memberName));
        } catch { return undefined; }
    }

    function tryGetMemberInModuleExportsAndPropertiesImpl(memberName: any, moduleSymbol: any): any {
        const symbol = tryGetMemberInModuleExportsImpl(memberName, moduleSymbol);
        if (symbol) return symbol;

        ensureProject();
        const mod = resolveModuleSymbolForExports(moduleSymbol);
        const exportEquals = resolveExternalModuleSymbolImpl(mod);
        if (exportEquals === mod) return undefined;

        const exportEqualsType = getTypeOfSymbolForExportEquals(exportEquals);
        if (!exportEqualsType || !shouldTreatPropertiesOfExternalModuleAsExports(exportEqualsType)) return undefined;

        return refineNavSymbol(resolvePropertyOfType(exportEqualsType, memberName));
    }

    function getSymbolFlagsImpl(symbol: any, excludeTypeOnlyMeanings?: boolean, excludeLocalMeanings?: boolean): number {
        if (!symbol) return 0;
        let flags = excludeLocalMeanings ? 0 : (typeof symbol.flags === "number" ? symbol.flags : 0);
        let current = symbol;
        const seen = new Set<any>();
        const isAliasSymbol = (s: any) => !!s && (((s.flags ?? 0) & SymbolFlags.Alias) || !!s.target);

        if (isAliasSymbol(current)) {
            const hostResolved = resolveHostAliasedSymbol(current);
            if (hostResolved && hostResolved !== current) {
                if (typeof hostResolved.flags === "number") flags |= hostResolved.flags;
                current = hostResolved;
            }
        }

        ensureProject();
        while (isAliasSymbol(current) && !seen.has(current)) {
            seen.add(current);
            let target: any;
            try {
                target = rpc().getImmediateAliasedSymbol(current);
            } catch {
                target = undefined;
            }
            if (!target || target === current) {
                target = current.target;
            }
            if (!target || target === current) break;
            if (typeof target.flags === "number") flags |= target.flags;
            current = target;
        }

        return flags;
    }

    const adapter: any = {
        // ── Node-based hot queries (find tsgo node → use tsgo's own API) ──
        getTypeAtLocation(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            return memoGet(nodeTypeCache, node, () => {
                const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
                const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
                if (!tsgoNode) { if (process.env.TSGO_PROFILE === "1") { const d = Date.now() - t0; _stats.queryCount++; _stats.queryMs += d; _stats.getTypeCount++; _stats.getTypeMs += d; } return undefined; }
                const r = computeGetTypeAtLocation(tsgoNode);
                if (process.env.TSGO_PROFILE === "1") { const d = Date.now() - t0; _stats.queryCount++; _stats.queryMs += d; _stats.getTypeCount++; _stats.getTypeMs += d; }
                return r;
            });
        },
        getSymbolAtLocation(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const start = typeof node.pos === "number" ? node.pos : node.getStart(sf);
            const end = typeof node.end === "number" ? node.end : node.getEnd(sf);
            // traceSym arguments are built eagerly — every call site on this
            // hot path (50k+ calls per lint run) must be gated so the string
            // work (getText / JSON.stringify) only happens when tracing.
            if (_traceSymEnabled) {
                traceSym(
                    `getSymbolAtLocation enter file=${sf.fileName} start=${start} end=${end} `
                    + `kind=${traceSymKind(node.kind)} parentKind=${traceSymKind(node.parent?.kind)} `
                    + `text=${JSON.stringify(traceSymNodeText(node, sf))}`,
                );
            }
            // component-meta: getSymbolAtLocation(sourceFile) must return the
            // file's module symbol (sf.symbol), not a tsgo position hit on the
            // first statement (e.g. __VLS_export) which lacks the default export.
            if (node.kind === SyntaxKind.SourceFile && sf.symbol) {
                // Return the module symbol directly. Do NOT write symByPos here:
                // this whole-file symbol has no single span, and caching it under
                // position 0 would poison lookups for any real node at pos 0.
                // This branch already short-circuits every SourceFile query, so a
                // cache is unnecessary anyway.
                // Do not refineNavSymbol here — resolveHostExportDefaultSymbol would
                // replace the module symbol with the __VLS_export const, breaking
                // getExportsOfModule (component-meta needs the module + default export).
                if (_traceSymEnabled) traceSym(`getSymbolAtLocation return path=sourcefile sym=${traceSymSymbol(sf.symbol)}`);
                return sf.symbol;
            }
            const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
            const cacheName = symCacheFileName(sf.fileName);
            const recordHit = () => {
                if (process.env.TSGO_PROFILE === "1") {
                    const d = Date.now() - t0;
                    _stats.getSymCount++;
                    _stats.getSymMs += d;
                    _stats.getSymHitCount++;
                }
            };
            const recordRpc = () => {
                if (process.env.TSGO_PROFILE === "1") {
                    const d = Date.now() - t0;
                    _stats.getSymCount++;
                    _stats.getSymMs += d;
                    _stats.getSymRpcCount++;
                }
            };
            // findAllReferences/rename match symbols by object identity
            // (search.includes → contains). On Volar host-bound virtual files the
            // binder SymbolObject is the canonical identity; tsgo bridge Symbol
            // instances for the same site break getRelatedSymbol.
            if (_hasHostBoundFiles && sf.__tnbHostBound && !isCrossFileImportExportName(node)) {
                const hostSym = getHostBoundSymbolAtLocation(node);
                if (hostSym) {
                    const rpcSym = resolveRpcSymbol(hostSym);
                    const refined = rpcSym
                        ? ensureSymbolContextualDocCompat(remapSymbolDeclarationsToHost(rpcSym, getHostBoundSf))
                        : refineNavSymbol(hostSym);
                    storeSymCache(cacheName, start, end, refined);
                    recordHit();
                    if (_traceSymEnabled) {
                        traceSym(
                            `getSymbolAtLocation return path=host-first source=${rpcSym ? "rpc-canonical" : "host-only"} `
                            + `sym=${traceSymSymbol(refined)}`,
                        );
                    }
                    return refined;
                }
            }
            const resolveSymbolRpc = (): any => {
                const tsgoFile = toTsgoFileName(sf.fileName);
                const isHostBound = !!sf.__tnbHostBound;
                const idText = node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier
                    ? String(node.escapedText ?? node.text ?? "")
                    : "";
                // Host-bound files need the node mapping up front (virtual-doc
                // position remapping below). Plain disk files resolve
                // positionally; the node-index walk is deferred until the
                // positional RPC comes back empty — building the whole-file
                // index eagerly dominated lint on large .d.ts files.
                let tsgoNode = isHostBound
                    ? findTsgoNodeAtPosition(sf.fileName, start, node.kind, end)
                    : undefined;
                if (isHostBound && (!tsgoNode || tsgoNode.kind !== node.kind)) {
                    const tokenStart = typeof node.getStart === "function" ? node.getStart(sf) : undefined;
                    if (typeof tokenStart === "number" && tokenStart !== start) {
                        const retryNode = findTsgoNodeAtPosition(sf.fileName, tokenStart, node.kind, end);
                        if (retryNode?.kind === node.kind) tsgoNode = retryNode;
                    }
                    if ((!tsgoNode || tsgoNode.kind !== node.kind) && end > start) {
                        const tailNode = findTsgoNodeAtPosition(sf.fileName, end - 1, node.kind, end);
                        if (tailNode?.kind === node.kind) tsgoNode = tailNode;
                    }
                }
                // Query the token interior first: `start` is the node's full
                // start, which can sit in leading trivia and miss the token —
                // end-1 is always inside a width>0 token, so the common case
                // resolves in one RPC. `start` stays as the fallback for
                // zero-width nodes and position-shifted host docs.
                let posSym: any = end > start
                    ? project.checker.getSymbolAtPosition(tsgoFile, end - 1)
                    : undefined;
                if (!posSym) {
                    const startSym = project.checker.getSymbolAtPosition(tsgoFile, start);
                    if (startSym) posSym = startSym;
                }
                let sym: any = posSym;
                if (_traceSymEnabled && tsgoNode && isHostBound) {
                    traceSym(
                        `getSymbolAtLocation rpc-map file=${sf.fileName} virtualPos=${start} `
                        + `expectedKind=${traceSymKind(node.kind)} expectedEnd=${end} `
                        + `tsgoKind=${traceSymKind(tsgoNode?.kind)} tsgoParentKind=${traceSymKind(tsgoNode?.parent?.kind)} `
                        + `tsgoStart=${typeof tsgoNode?.getStart === "function" ? tsgoNode.getStart() : tsgoNode?.pos} `
                        + `tsgoEnd=${typeof tsgoNode?.getEnd === "function" ? tsgoNode.getEnd() : tsgoNode?.end} `
                        + `tsgoText=${JSON.stringify(traceSymNodeText(tsgoNode))}`,
                    );
                }
                if (isHostBound && tsgoNode && tsgoNode.kind === node.kind) {
                    const nodeSym = project.checker.getSymbolAtLocation(tsgoNode);
                    if (nodeSym) {
                        sym = nodeSym;
                        if (_traceSymEnabled) {
                            traceSym(
                                `getSymbolAtLocation rpc-prefer-node file=${sf.fileName} `
                                + `text=${JSON.stringify(traceSymNodeText(node, sf))} sym=${traceSymSymbol(sym)}`,
                            );
                        }
                    }
                }
                if (isHostBound && posSym && idText) {
                    const posName = symbolDisplayNameOf(posSym);
                    if (posName && posName !== idText) {
                        if (_traceSymEnabled) {
                            traceSym(
                                `getSymbolAtLocation rpc-pos-mismatch-retry file=${sf.fileName} `
                                + `idText=${JSON.stringify(idText)} posName=${JSON.stringify(posName)} `
                                + `posSym=${traceSymSymbol(posSym)}`,
                            );
                        }
                        if (tsgoNode && tsgoNode.kind === node.kind) {
                            const retrySym = project.checker.getSymbolAtLocation(tsgoNode);
                            sym = retrySym ?? undefined;
                        } else if (sym === posSym) {
                            sym = undefined;
                        }
                    }
                }
                if (!sym && !symPrefetchPopulated.has(cacheName)) {
                    // Deferred node-index fallback for plain disk files —
                    // reached only when the positional query resolved nothing
                    // (e.g. non-token nodes whose interior token has no symbol).
                    tsgoNode ??= findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
                    if (tsgoNode) {
                        sym = project.checker.getSymbolAtLocation(tsgoNode);
                    }
                }
                if (!sym && _hasHostBoundFiles) {
                    sym = getHostBoundSymbolAtLocation(node);
                }
                sym = refineNavSymbol(sym);
                storeSymCache(cacheName, start, end, sym);
                recordRpc();
                if (_traceSymEnabled) traceSym(`getSymbolAtLocation return path=rpc sym=${traceSymSymbol(sym)}`);
                return sym;
            };
            let cached = probeSymCache(cacheName, start, end);
            if (cached.found) {
                recordHit();
                if (_traceSymEnabled) traceSym(`getSymbolAtLocation return path=cache sym=${traceSymSymbol(cached.sym)}`);
                return cached.sym;
            }
            // Module-specifier literals: batch-resolve every module reference
            // of the file in one RPC on first miss (import literals are the
            // dominant cross-file query in multi-project lint). If the literal
            // wasn't in the file's imports list (rare — e.g. require() text in
            // a non-module position), fall through to the per-node path.
            if (!sf.__tnbHostBound && !moduleSpecPrefetched.has(cacheName) && isModuleSpecifierStringLiteral(node)) {
                if (ensureModuleSpecifierSymbolsPrefetched(sf.fileName)) {
                    cached = probeSymCache(cacheName, start, end);
                    if (cached.found) {
                        recordHit();
                        if (_traceSymEnabled) traceSym(`getSymbolAtLocation return path=import-prefetch sym=${traceSymSymbol(cached.sym)}`);
                        return cached.sym;
                    }
                }
            }
            const missCount = (symMissCountByFile.get(cacheName) ?? 0) + 1;
            symMissCountByFile.set(cacheName, missCount);
            // Sparse files: direct per-position RPC until miss density justifies
            // one whole-file prefetch (break-even ~32 × 12µs vs one batch walk).
            if (!symPrefetched.has(cacheName) && missCount < symPrefetchMissThreshold()) {
                return resolveSymbolRpc();
            }
            if (!symPrefetched.has(cacheName)) {
                ensureFileSymbolsPrefetched(sf.fileName);
            }
            cached = probeSymCache(cacheName, start, end);
            if (cached.found) {
                recordHit();
                if (_traceSymEnabled) traceSym(`getSymbolAtLocation return path=cache sym=${traceSymSymbol(cached.sym)}`);
                return cached.sym;
            }
            // allIdentifiers prefetch is exhaustive on plain disk files; host-bound
            // virtual TS (Volar) has binder sites prefetch misses (e.g. PropertyAccess
            // names on __VLS_intrinsics.*) — keep per-position resolution alive.
            if (symPrefetchPopulated.has(cacheName) && isPrefetchCoveredNode(node) && !sf.__tnbHostBound) {
                storeSymCache(cacheName, start, end, undefined);
                recordHit();
                traceSym("getSymbolAtLocation return path=prefetch-neg sym=undefined");
                return undefined;
            }
            return resolveSymbolRpc();
        },
        getTypeOfSymbolAtLocation(symbol: any, location: any): any {
            ensureProject();
            const sf = location.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, location.getStart(sf), location.kind, location.getEnd(sf));
            if (tsgoNode) {
                const t = rpc().getTypeOfSymbolAtLocation(symbol, tsgoNode);
                if (t) { fixupType(t); return t; }
            }
            // Auto-import completion entries may query export symbols at virtual-doc
            // locations where the host AST node has no tsgo mirror yet — fall back
            // to the location-independent type.
            if (typeof project.checker.getTypeOfSymbol === "function") {
                const t = rpc().getTypeOfSymbol(symbol);
                if (t) fixupType(t);
                return t;
            }
            return undefined;
        },
        getContextualType(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            // Punctuation / file roots are not expressions and have no contextual
            // type — stock returns undefined without querying the checker.
            if (node.kind === SyntaxKind.SourceFile
                || node.kind === SyntaxKind.DotToken
                || node.kind === SyntaxKind.QuestionDotToken
                || node.kind === SyntaxKind.EndOfFileToken) {
                return undefined;
            }
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (_traceSymEnabled) traceSym(`getContextualType file=${sf.fileName} kind=${node.kind} hit=${!!tsgoNode}`);
            if (!tsgoNode || tsgoNode.kind === SyntaxKind.SourceFile) return undefined;
            const t = project.checker.getContextualType(tsgoNode);
            if (t) fixupType(t);
            // Record object-literal / JSX-attributes contextual queries: stock
            // completions asks these right before getPropertiesForObjectExpression,
            // which lets the per-member calls below collapse into one batch RPC.
            if ((node.kind === SyntaxKind.ObjectLiteralExpression || node.kind === SyntaxKind.JsxAttributes) && tsgoNode.kind === node.kind) {
                const pending = _objCompletionPending;
                if (pending && pending.hostNode === node) {
                    pending.results.push(t);
                }
                else {
                    _objCompletionPending = { hostNode: node, tsgoNode, results: [t] };
                }
            }
            return t;
        },
        getResolvedSignature(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            return project.checker.getResolvedSignature(tsgoNode);
        },
        getTypeFromTypeNode(typeNode: any): any {
            ensureProject();
            const t = project.checker.getTypeFromTypeNode(typeNode);
            if (t) fixupType(t);
            return t;
        },

        // ── Type/Symbol-object queries ──
        getTypeOfSymbol(symbol: any): any {
            if (!symbol) return undefined;
            ensureProject();
            return memoGet(typeOfSymbolCache, symbol, () => {
                const t = rpc().getTypeOfSymbol(symbol);
                if (t) fixupType(t);
                return t;
            });
        },
        getDeclaredTypeOfSymbol(symbol: any): any {
            if (!symbol) return undefined;
            ensureProject();
            const t = rpc().getDeclaredTypeOfSymbol(symbol);
            if (t) fixupType(t);
            return t;
        },
        // Symbol-only queries the scope manager uses — see delegation in the
        // stubs section below (getShorthandAssignmentValueSymbol etc.).

        typeToString(type: any, _enclosing?: any, flags?: number): string {
            ensureProject();
            return project.checker.typeToString(type, undefined, flags);
        },
        // Stock checker exposes writer-based emitters consumed by the services
        // displayParts builders (typeToDisplayParts/symbolToDisplayParts/
        // signatureToDisplayParts → quickInfo, references symbolDisplayString).
        // tsgo has no writer RPC; serialize via the string RPCs and emit a
        // single text part (flattened by displayPartsToString anyway).
        writeType(type: any, _enclosing?: any, flags?: number, writer?: any): void {
            if (!type || !writer) return;
            ensureProject();
            const text = project.checker.typeToString(type, undefined, flags) ?? "";
            if (text) writer.write?.(text);
        },
        writeSymbol(symbol: any, _enclosing?: any, _meaning?: number, _flags?: number, writer?: any): void {
            if (!symbol || !writer) return;
            const text = symbolDisplayNameOf(symbol);
            if (text) writer.writeSymbol?.(text, symbol);
        },
        writeSignature(signature: any, _enclosing?: any, flags?: number, _kind?: any, writer?: any): void {
            if (!signature || !writer) return;
            ensureProject();
            const text = checkerProxyRef.signatureToString(signature, undefined, flags) ?? "";
            if (text) writer.write?.(text);
        },
        // tsgo has no symbolToString/getFullyQualifiedName RPC. Stock semantics
        // for the common LS consumers (renameInfo displayName/fullDisplayName,
        // definition names) reduce to the unescaped symbol name qualified by
        // the parent chain — both symbol kinds (host SymbolObject and bridge
        // Symbol) carry name/parent, so this is served uniformly in JS.
        symbolToString(symbol: any): string {
            return symbolDisplayNameOf(symbol);
        },
        getFullyQualifiedName(symbol: any): string {
            let name = symbolDisplayNameOf(symbol);
            const seen = new Set<any>();
            let parent = symbolParentOf(symbol);
            while (parent && !seen.has(parent)) {
                seen.add(parent);
                const parentName = symbolDisplayNameOf(parent);
                if (!parentName) break;
                name = `${parentName}.${name}`;
                parent = symbolParentOf(parent);
            }
            return name;
        },
        getDocumentationCommentOfSymbol(symbol: any): string {
            if (!symbol) return "";
            ensureProject();
            try {
                return rpc().getDocumentationCommentOfSymbol(symbol) ?? "";
            }
            catch {
                return "";
            }
        },
        getJsDocTagsOfSymbol(symbol: any): readonly any[] {
            if (!symbol) return [];
            ensureProject();
            try {
                const tags = rpc().getJsDocTagsOfSymbol(symbol) ?? [];
                // tsgo's JSDocTagInfo renders `text` as a plain string; stock TS uses
                // SymbolDisplayPart[]. Consumers (displayPartsToString, tsserver
                // protocol mapping) iterate the parts, so a raw string silently
                // flattens to "". Convert at the RPC boundary.
                return tags.map((t: any) =>
                    typeof t?.text === "string"
                        ? { name: t.name, text: t.text.length ? displayPartsFromDocText(t.text) : undefined }
                        : t
                );
            }
            catch {
                return [];
            }
        },
        signatureToString(signature: any, _enclosingDeclaration?: any, flags?: number): string {
            ensureProject();
            if (!signature || typeof signature.id !== "number") return "";
            // The enclosing declaration is a host node with no tsgo handle; tsgo's
            // printer resolves scope from the signature declaration itself.
            return project.checker.signatureToString(signature, undefined, flags) ?? "";
        },
        getPropertiesOfType(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            return memoGet(propertiesCache, type, () => project.checker.getPropertiesOfType(type) ?? []);
        },
        getPropertyOfType(type: any, name: string): any {
            ensureProject();
            return resolvePropertyOfType(type, name);
        },
        getSignaturesOfType(type: any, kind: number): readonly any[] {
            ensureProject();
            if (!type) return [];
            return getSignaturesCached(type, kind);
        },
        getNonNullableType(type: any): any {
            ensureProject();
            const t = project.checker.getNonNullableType(type);
            if (t) fixupType(t);
            return t;
        },
        getNonOptionalType(type: any): any {
            ensureProject();
            if (!type) return type;
            const t = project.checker.getNonOptionalType(type);
            if (t) fixupType(t);
            return t ?? type;
        },
        // Stock Completions.getPropertiesForObjectExpression calls these; route
        // through tsgo RPC so union reduction and property merging match stock.
        // The activeObjCompletionBatch() lookups serve the whole sequence from
        // the composite RPC fired in getPromisedTypeOfPromise (see the
        // object-literal completion batch section above).
        getUnionType(types: readonly any[], unionReduction?: number, ..._rest: any[]): any {
            ensureProject();
            const list = types ? Array.from(types).filter(Boolean) : [];
            const batch = activeObjCompletionBatch();
            if (batch && (unionReduction ?? 1) === 1) {
                if (sameTypeList(list, batch.pfMembers)) return batch.pf;
                if (batch.merged && list.length === 2 && list[0] === batch.pf && list[1] === batch.completionsType) return batch.merged;
            }
            if (list.length === 0) {
                const never = project.checker.getNeverType();
                if (never) fixupType(never);
                return never;
            }
            if (list.length === 1) {
                const t = list[0];
                if (t) fixupType(t);
                return t;
            }
            const t = project.checker.getUnionType(list, unionReduction ?? 1);
            if (t) fixupType(t);
            return t;
        },
        getPromisedTypeOfPromise(type: any): any {
            ensureProject();
            if (!type) return undefined;
            const batch = activeObjCompletionBatch() ?? tryStartObjCompletionBatch(type);
            if (batch?.promised.has(type)) return batch.promised.get(type) ?? undefined;
            const t = project.checker.getPromisedTypeOfPromise(type);
            if (t) fixupType(t);
            return t;
        },
        getAllPossiblePropertiesOfTypes(types: readonly any[]): any[] {
            ensureProject();
            if (!types?.length) return [];
            const batch = activeObjCompletionBatch();
            if (batch?.isFinalUnion && sameTypeList(types, batch.filteredMembers)) return batch.properties;
            return project.checker.getAllPossiblePropertiesOfTypes([...types]) ?? [];
        },
        isArrayLikeType(type: any): boolean {
            ensureProject();
            if (!type) return false;
            const verdict = activeObjCompletionBatch()?.verdicts.get(type);
            if (verdict) return verdict.isArrayLike;
            return !!project.checker.isArrayLikeType(type);
        },
        isTypeInvalidDueToUnionDiscriminant(type: any, node: any): boolean {
            ensureProject();
            if (!type || !node) return false;
            const batch = activeObjCompletionBatch();
            if (batch && batch.hostNode === node) {
                const verdict = batch.verdicts.get(type);
                if (verdict) return verdict.invalidDueToUnionDiscriminant;
            }
            const sf = node.getSourceFile?.();
            if (!sf) return false;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode || tsgoNode.kind !== node.kind) return false;
            return !!project.checker.isTypeInvalidDueToUnionDiscriminant(type, tsgoNode);
        },
        typeHasCallOrConstructSignatures(type: any): boolean {
            ensureProject();
            if (!type) return false;
            const verdict = activeObjCompletionBatch()?.verdicts.get(type);
            if (verdict) return verdict.hasCallOrConstructSignatures;
            return !!project.checker.typeHasCallOrConstructSignatures(type);
        },
        getBaseTypes(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            return getBaseTypesCached(type);
        },
        isTypeAssignableTo(source: any, target: any): boolean {
            ensureProject();
            if (!source || !target) return false;
            return project.checker.isTypeAssignableTo(source, target);
        },
        getReturnTypeOfSignature(signature: any): any {
            ensureProject();
            const t = project.checker.getReturnTypeOfSignature(signature);
            if (t) fixupType(t);
            return t;
        },
        getBaseConstraintOfType(type: any): any {
            ensureProject();
            const TF = sync.TypeFlags;
            if (type && (type.flags & TF.TypeParameter) !== 0) {
                const t = project.checker.getConstraintOfTypeParameter(type);
                if (t) fixupType(t);
                return t;
            }
            return undefined;
        },
        getIndexInfosOfType(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            return project.checker.getIndexInfosOfType(type) ?? [];
        },
        getTypeArguments(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            const args = project.checker.getTypeArguments(type);
            if (args) fixupType(args);
            return args ?? [];
        },
        getWidenedType(type: any): any {
            ensureProject();
            if (!type) return type;
            const t = project.checker.getWidenedType(type);
            if (t) fixupType(t);
            return t;
        },
        getModuleSymbolForSourceFile(sourceFile: any): any {
            if (!sourceFile) return undefined;
            if (sourceFile.symbol) return sourceFile.symbol;
            ensureProject();
            const host = hostForOverlaySyncLocal();
            const hostFile = resolveHostFileName(sourceFile.fileName, host);
            const candidates = [hostFile, toTsgoFileName(hostFile), sourceFile.fileName];
            for (const file of candidates) {
                if (!file) continue;
                try {
                    const sym = rpc().getModuleSymbolForSourceFile?.(file);
                    if (sym && typeof sym.id === "number" && sym.id !== 0) return sym;
                } catch { /* try next path shape */ }
            }
            return resolveExportMapModuleSymbol(undefined, hostFile);
        },
        forEachExportAndPropertyOfModule(moduleSymbol: any, cb: (symbol: any, key: string) => void): void {
            const fileName = moduleSymbolSourceFileName(moduleSymbol);
            forEachExportAndPropertyOfModuleWorker(moduleSymbol, cb, fileName);
        },
        getExportsOfModule(moduleSymbol: any): readonly any[] {
            if (!moduleSymbol) return [];
            if (moduleSymbolUsesHostExportTable(moduleSymbol)) {
                let hostExports = collectNamedExportsFromModuleSymbol(moduleSymbol);
                if (!hostExports.length) {
                    const hostFileName = moduleSymbolSourceFileName(moduleSymbol);
                    if (hostFileName) hostExports = resolveHostModuleNamedExports(hostFileName);
                }
                if (hostExports.length) return hostExports;
            }
            const mod = resolveExportMapModuleSymbol(moduleSymbol);
            return getRpcExportsOfModule(mod);
        },

        // ── Diagnostics — empty for PoC ──
        getSuggestionDiagnostics(): readonly any[] { return []; },
        getGlobalDiagnostics(): readonly any[] { return []; },
        getDiagnostics(): readonly any[] { return []; },
        getAmbientModules(): readonly any[] { return []; },

        // ── Stubs ──
        getSymbolsInScope(location: any, meaning: number): any[] {
            if (!location) return [];
            const sf = location.getSourceFile?.();
            // Volar host-only virtual files have no tsgo mirror; the binder scope
            // walk over host locals/exports is genuine host-only bridging.
            if (sf?.__tnbHostBound) {
                return getHostSymbolsInScope(location, meaning).map(refineNavSymbol);
            }
            if (!sf) return [];
            ensureProject();
            // Memoized per (location, meaning): the response marshals every
            // visible symbol (globals included — hundreds), and scope-manager
            // callers re-ask at the same location (e.g. once per constructor
            // parameter property). Snapshot-stable; cleared on overlay refresh.
            const start = location.getStart(sf);
            const end = location.getEnd(sf);
            const scopeKey = `${symCacheFileName(sf.fileName)}:${start}:${end}:${meaning}`;
            const memo = symbolsInScopeCache.get(scopeKey);
            if (memo) return memo;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, location.kind, end);
            if (!tsgoNode) return [];
            const result = (project.checker.getSymbolsInScope(tsgoNode, meaning) ?? []).map(refineNavSymbol);
            symbolsInScopeCache.set(scopeKey, result);
            return result;
        },
        getExportSpecifierLocalTargetSymbol(node: any): any {
            if (!node) return undefined;
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            try {
                return refineNavSymbol(project.checker.getExportSpecifierLocalTargetSymbol(tsgoNode));
            } catch { return undefined; }
        },
        getShorthandAssignmentValueSymbol(node: any): any {
            if (!node) return undefined;
            if (node.kind === SyntaxKind.ShorthandPropertyAssignment) {
                const sf = node.getSourceFile?.();
                const nameNode = node.name;
                if (sf?.__tnbHostBound && nameNode) {
                    const name = String(nameNode.text ?? nameNode.escapedName);
                    let sym = resolveEntityNameOnHostBoundAst(
                        name,
                        node,
                        SymbolFlags.Value | SymbolFlags.Alias,
                    );
                    if (!sym || ((sym.flags & SymbolFlags.Property)
                        && !(sym.flags & (SymbolFlags.FunctionScopedVariable | SymbolFlags.BlockScopedVariable)))) {
                        const decl = findHostModuleScopedDeclaration(sf, name);
                        if (decl?.symbol) sym = decl.symbol;
                    }
                    if (sym) {
                        const rpcSym = resolveRpcSymbol(sym);
                        const refined = rpcSym
                            ? ensureSymbolContextualDocCompat(remapSymbolDeclarationsToHost(rpcSym, getHostBoundSf))
                            : refineNavSymbol(sym);
                        if (_traceSymEnabled) {
                            traceSym(
                                `getShorthandAssignmentValueSymbol path=host-fast source=${rpcSym ? "rpc-canonical" : "host-only"} `
                                + `sym=${traceSymSymbol(refined)}`,
                            );
                        }
                        return refined;
                    }
                    traceSym("getShorthandAssignmentValueSymbol path=host-fast sym=undefined");
                }
            }
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            try {
                const rpcSym = refineNavSymbol(project.checker.getShorthandAssignmentValueSymbol(tsgoNode));
                if (_traceSymEnabled) traceSym(`getShorthandAssignmentValueSymbol path=rpc sym=${traceSymSymbol(rpcSym)}`);
                return rpcSym;
            } catch { return undefined; }
        },
        getAliasedSymbol(symbol: any): any {
            ensureProject();
            if (!symbol) return symbol;
            const SF = sync.SymbolFlags;
            if (!(symbol.flags & SF.Alias)) {
                return refineNavSymbol(symbol);
            }
            try {
                return refineNavSymbol(
                    resolveHostAliasedSymbol(rpc().getAliasedSymbol(symbol) ?? resolveHostAliasedSymbol(symbol)),
                );
            } catch {
                return refineNavSymbol(resolveHostAliasedSymbol(symbol));
            }
        },
        getImmediateAliasedSymbol(symbol: any): any {
            ensureProject();
            if (!symbol) return symbol;
            const SF = sync.SymbolFlags;
            if (!(symbol.flags & SF.Alias)) return refineNavSymbol(symbol);
            try {
                const target = rpc().getImmediateAliasedSymbol(symbol);
                if (target) return refineNavSymbol(target);
            } catch { /* fall through to host binder target */ }
            const target = symbol.target;
            return refineNavSymbol(target && target !== symbol ? target : symbol);
        },
        tryGetMemberInModuleExports(memberName: any, moduleSymbol: any): any {
            return tryGetMemberInModuleExportsImpl(memberName, moduleSymbol);
        },
        tryGetMemberInModuleExportsAndProperties(memberName: any, moduleSymbol: any): any {
            return tryGetMemberInModuleExportsAndPropertiesImpl(memberName, moduleSymbol);
        },
        resolveExternalModuleSymbol(moduleSymbol: any): any {
            return refineNavSymbol(resolveExternalModuleSymbolImpl(moduleSymbol));
        },
        // Merging is a TS-specific concern; tsgo symbols are already merged.
        getMergedSymbol: (s: any) => s,
        getSymbolFlags(symbol: any, excludeTypeOnlyMeanings?: boolean, excludeLocalMeanings?: boolean): number {
            return getSymbolFlagsImpl(symbol, excludeTypeOnlyMeanings, excludeLocalMeanings);
        },
        // ── Intrinsic-symbol predicates ──
        // Rename (getSymbolKind), symbolDisplay, exportInfoMap and
        // suggestionDiagnostics probe these. The sync client answers them as
        // local id compares against the checker's cached intrinsic symbols;
        // rpc() resolves host symbols first, and a symbol with no tsgo
        // counterpart can never be a checker intrinsic (facade → undefined).
        isUndefinedSymbol(symbol: any): boolean {
            if (!symbol) return false;
            ensureProject();
            try { return !!rpc().isUndefinedSymbol(symbol); } catch { return false; }
        },
        isArgumentsSymbol(symbol: any): boolean {
            if (!symbol) return false;
            ensureProject();
            try { return !!rpc().isArgumentsSymbol(symbol); } catch { return false; }
        },
        isUnknownSymbol(symbol: any): boolean {
            if (!symbol) return false;
            ensureProject();
            try { return !!rpc().isUnknownSymbol(symbol); } catch { return false; }
        },
        // goToDefinition → isDefinitionVisible → DefinitionInfo.isLocal.
        // Kind-mismatched fallback hits from findTsgoNodeAtPosition would
        // yield a wrong verdict, so require an exact node mapping; unmapped
        // (host-only) declarations report not-visible, matching the stock
        // default for unknown declarations.
        isDeclarationVisible(declaration: any): boolean {
            if (!declaration) return false;
            const sf = declaration.getSourceFile?.();
            if (!sf?.fileName) return false;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = declaration.getStart(sf);
                end = declaration.getEnd(sf);
            } catch { return false; }
            if (typeof start !== "number") return false;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, declaration.kind, end);
            if (!tsgoNode || tsgoNode.kind !== declaration.kind) return false;
            try { return !!project.checker.isDeclarationVisible(tsgoNode); } catch { return false; }
        },
        // Completions property filtering (addTypeProperties). Fallbacks keep
        // the property: dropping it empties the completion list, while the
        // predicate only exists to hide inaccessible (private/protected)
        // members — a rare miss is cosmetic, an empty list is broken.
        isValidPropertyAccessForCompletions(node: any, type: any, property: any): boolean {
            if (!node || !type || !property) return false;
            const sf = node.getSourceFile?.();
            if (!sf?.fileName) return true;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = node.getStart(sf);
                end = node.getEnd(sf);
            } catch { return true; }
            if (typeof start !== "number") return true;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
            if (!tsgoNode || tsgoNode.kind !== node.kind) return true;
            const rpcSym = resolveRpcSymbol(property);
            if (!rpcSym) return true; // host-only symbol — no tsgo verdict possible
            try {
                return !!project.checker.isValidPropertyAccessForCompletions(tsgoNode, type, rpcSym);
            } catch { return true; }
        },
        // Completions (`this.` member lists, #8811): type of `this` at a node.
        tryGetThisTypeAt(node: any, includeGlobalThis: boolean = true, container?: any): any {
            if (!node) return undefined;
            const sf = node.getSourceFile?.();
            if (!sf?.fileName) return undefined;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = node.getStart(sf);
                end = node.getEnd(sf);
            } catch { return undefined; }
            if (typeof start !== "number") return undefined;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
            if (!tsgoNode) return undefined;
            let tsgoContainer: any;
            if (container) {
                const csf = container.getSourceFile?.();
                if (csf?.fileName) {
                    try {
                        const mapped = findTsgoNodeAtPosition(csf.fileName, container.getStart(csf), container.kind, container.getEnd(csf));
                        if (mapped && mapped.kind === container.kind) tsgoContainer = mapped;
                    } catch { /* container is advisory; fall back to tsgo's own container walk */ }
                }
            }
            try {
                const t = project.checker.tryGetThisTypeAt(tsgoNode, includeGlobalThis, tsgoContainer);
                if (t) fixupType(t);
                return t ?? undefined;
            } catch { return undefined; }
        },
        getRootSymbols(symbol: any): any[] {
            if (!symbol) return [];
            ensureProject();
            // rpc() maps a resolved echo back to the caller's own symbol, so an
            // ordinary symbol (host or tsgo) stays its own root by identity.
            let roots: readonly any[] | undefined;
            try {
                roots = rpc().getRootSymbols(symbol);
            } catch { /* unresolvable → own root */ }
            return (roots?.length ? [...roots] : [symbol]).map(refineNavSymbol);
        },
        // tsgo bridge-specific symbol RPCs (no stock TS counterpart, no host
        // callers today). Covered explicitly so the unknown-method forward
        // below stays symbol-free by construction.
        getReferencesToSymbolInFile(file: any, symbol: any): any[] {
            ensureProject();
            try { return rpc().getReferencesToSymbolInFile(file, symbol) ?? []; } catch { return []; }
        },
        getMemberInModuleExports(symbol: any, name: string): any {
            ensureProject();
            try { return refineNavSymbol(rpc().getMemberInModuleExports(symbol, name)); } catch { return undefined; }
        },
        getDefinitionSpanForDeclaration(declaration: any): { start: number; length: number } | undefined {
            return tnbHostExportDefinitionTextSpan(declaration);
        },
        // Emit resolver — the lint path doesn't emit; return a minimal
        // stub if code reads properties off it.
        getEmitResolver: () => ({ getExternalModuleIndicator: () => false }),
        resolveName(name: string, location: any, meaning: number, excludeGlobals?: boolean): any {
            ensureProject();
            let tsgoLocation: any = location;
            if (location && typeof location.getStart === "function") {
                const sf = location.getSourceFile?.();
                if (sf?.fileName) {
                    const tsgoNode = findTsgoNodeAtPosition(
                        sf.fileName,
                        location.getStart(sf),
                        location.kind,
                        location.getEnd(sf),
                    );
                    if (tsgoNode) tsgoLocation = tsgoNode;
                }
            }
            try {
                const sym = project.checker.resolveName(name, meaning, tsgoLocation, excludeGlobals);
                if (sym) return refineNavSymbol(sym);
            } catch {
                // fall through to host-bound AST
            }
            return refineNavSymbol(resolveNameOnHostBoundAst(name, location) ?? undefined);
        },

        // ── Counts (for getProgramDiagnostics etc.) ──
        getNodeCount: () => 0,
        getIdentifierCount: () => 0,
        getSymbolCount: () => 0,
        getTypeCount: () => 0,
        getInstantiationCount: () => 0,
        getRelationCacheSizes: () => ({ assignable: 0, identity: 0, subtype: 0, strictSubtype: 0 }),

        // Stock TypeChecker: callback receives the checker proxy (see checker.ts).
        // Vue references → getQuickInfoAtPosition → SymbolDisplay uses this API.
        runWithCancellationToken(_token: any, callback: (checker: any) => any): any {
            return callback(checkerProxyRef);
        },
    };

    // Proxy: unknown methods → forward to native checker when present, else throw
    // so missing adapter coverage fails loudly instead of returning undefined.
    ensureProject();

    const wrapCheckerCall = <T extends (...args: any[]) => any>(fn: T): T => {
        return ((...args: any[]) => {
            _checkerQueryDepth++;
            pushActiveProject(project);
            try {
                return fn(...args);
            } finally {
                popActiveProject();
                _checkerQueryDepth--;
            }
        }) as T;
    };

    checkerProxyRef = new Proxy(adapter, {
        get(target: any, prop: string | symbol, receiver: any) {
            if (prop in target) {
                const val = Reflect.get(target, prop, receiver);
                if (typeof val === "function") return wrapCheckerCall(val.bind(target));
                return val;
            }
            if (typeof prop !== "string") return undefined;
            ensureProject();
            if (typeof project.checker[prop] === "function") {
                // Direct forward — symbol-free by construction. Every tsgo
                // checker method that accepts a Symbol argument is covered by
                // an explicit adapter method above that routes through rpc();
                // what reaches here are node/type/signature queries, which
                // must not pay the facade's per-call argument scan (the
                // checker hot path during whole-program lint).
                return wrapCheckerCall(project.checker[prop].bind(project.checker));
            }
            // Missing on both adapter and native checker — throw instead of
            // silently returning undefined (which hid quick-fix gaps like
            // getSymbolFlags / tryGetMemberInModuleExportsAndProperties).
            return (..._args: any[]) => {
                throw new Error(`tsgoChecker: TypeChecker.${prop} is not implemented in the tsgo adapter`);
            };
        },
        has(target: any, p) { return p in target; },
    });
    return checkerProxyRef;
}

// ── TypeChecker coverage table (compile-time structural guard) ────────────
// Exhaustive classification of every `keyof TypeChecker` against the tsgo
// adapter, kept honest by the compiler: adding a method to the TypeChecker
// interface without classifying it here fails the build, and classifying a
// key that no longer exists fails via `satisfies` excess-property checking.
//
//   "adapter" — explicit adapter-object method (symbol-bearing calls route
//               through the rpc() facade; node-based calls map positions).
//   "tsgo"    — no adapter entry; the checker proxy forwards the call to the
//               native tsgo checker client (symbol-free by construction).
//   "throw"   — implemented by neither; the proxy throws
//               "not implemented in the tsgo adapter" at the call site.
//               Never downgrade a "throw" to a silent no-op — implement it
//               (adapter and/or Go RPC) and reclassify.
//
// This table is documentation plus a compile aid; the runtime source of truth
// remains the adapter object and the proxy in createTsgoCheckerAdapter.
type TnbCheckerCoverage = "adapter" | "tsgo" | "throw";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _tnbCheckerCoverage = {
    getTypeOfSymbolAtLocation: "adapter",
    getTypeOfSymbol: "adapter",
    getDeclaredTypeOfSymbol: "adapter",
    getPropertiesOfType: "adapter",
    getPropertyOfType: "adapter",
    getPrivateIdentifierPropertyOfType: "throw",
    getTypeOfPropertyOfType: "throw",
    getIndexInfoOfType: "throw",
    getIndexInfosOfType: "adapter",
    getIndexInfosOfIndexSymbol: "throw",
    getSignaturesOfType: "adapter",
    getIndexTypeOfType: "throw",
    getIndexType: "tsgo",
    getBaseTypes: "adapter",
    getBaseTypeOfLiteralType: "tsgo",
    getWidenedType: "adapter",
    getWidenedLiteralType: "throw",
    getPromisedTypeOfPromise: "adapter",
    getAwaitedType: "throw",
    isEmptyAnonymousObjectType: "throw",
    getReturnTypeOfSignature: "adapter",
    getParameterType: "tsgo",
    getParameterIdentifierInfoAtPosition: "throw",
    getNullableType: "throw",
    getNonNullableType: "adapter",
    getNonOptionalType: "adapter",
    isNullableType: "throw",
    getTypeArguments: "adapter",
    typeToTypeNode: "tsgo",
    typePredicateToTypePredicateNode: "throw",
    signatureToSignatureDeclaration: "tsgo",
    indexInfoToIndexSignatureDeclaration: "throw",
    symbolToEntityName: "throw",
    symbolToExpression: "throw",
    symbolToNode: "throw",
    symbolToTypeParameterDeclarations: "throw",
    symbolToParameterDeclaration: "throw",
    typeParameterToDeclaration: "throw",
    getSymbolsInScope: "adapter",
    getSymbolAtLocation: "adapter",
    getIndexInfosAtLocation: "throw",
    getSymbolsOfParameterPropertyDeclaration: "throw",
    getShorthandAssignmentValueSymbol: "adapter",
    getExportSpecifierLocalTargetSymbol: "adapter",
    getExportSymbolOfSymbol: "throw",
    getPropertySymbolOfDestructuringAssignment: "throw",
    getTypeOfAssignmentPattern: "throw",
    getTypeAtLocation: "adapter",
    getTypeFromTypeNode: "adapter",
    signatureToString: "adapter",
    typeToString: "adapter",
    symbolToString: "adapter",
    typePredicateToString: "throw",
    writeSignature: "adapter",
    writeType: "adapter",
    writeSymbol: "adapter",
    writeTypePredicate: "throw",
    getFullyQualifiedName: "adapter",
    getAugmentedPropertiesOfType: "throw",
    getRootSymbols: "adapter",
    getSymbolOfExpando: "throw",
    getContextualType: "adapter",
    getContextualTypeForObjectLiteralElement: "throw",
    getContextualTypeForArgumentAtIndex: "throw",
    getContextualTypeForJsxAttribute: "throw",
    isContextSensitive: "tsgo",
    getTypeOfPropertyOfContextualType: "throw",
    getResolvedSignature: "adapter",
    getResolvedSignatureForSignatureHelp: "throw",
    getCandidateSignaturesForStringLiteralCompletions: "throw",
    getExpandedParameters: "throw",
    hasEffectiveRestParameter: "throw",
    containsArgumentsReference: "throw",
    getSignatureFromDeclaration: "tsgo",
    isImplementationOfOverload: "throw",
    isUndefinedSymbol: "adapter",
    isArgumentsSymbol: "adapter",
    isUnknownSymbol: "adapter",
    getMergedSymbol: "adapter",
    symbolIsValue: "throw",
    getConstantValue: "tsgo",
    isValidPropertyAccess: "throw",
    isValidPropertyAccessForCompletions: "adapter",
    getAliasedSymbol: "adapter",
    getImmediateAliasedSymbol: "adapter",
    getExportsOfModule: "adapter",
    getExportsAndPropertiesOfModule: "throw",
    forEachExportAndPropertyOfModule: "adapter",
    getJsxIntrinsicTagNamesAt: "throw",
    isOptionalParameter: "throw",
    getAmbientModules: "adapter",
    tryGetMemberInModuleExports: "adapter",
    tryGetMemberInModuleExportsAndProperties: "adapter",
    getApparentType: "tsgo",
    getSuggestedSymbolForNonexistentProperty: "throw",
    getSuggestedSymbolForNonexistentJSXAttribute: "throw",
    getSuggestedSymbolForNonexistentSymbol: "throw",
    getSuggestedSymbolForNonexistentModule: "throw",
    getSuggestedSymbolForNonexistentClassMember: "throw",
    getBaseConstraintOfType: "adapter",
    getDefaultFromTypeParameter: "throw",
    getAnyType: "tsgo",
    getStringType: "tsgo",
    getStringLiteralType: "throw",
    getNumberType: "tsgo",
    getNumberLiteralType: "throw",
    getBigIntType: "tsgo",
    getBigIntLiteralType: "throw",
    getBooleanType: "tsgo",
    getUnknownType: "tsgo",
    getFalseType: "tsgo",
    getTrueType: "tsgo",
    getVoidType: "tsgo",
    getUndefinedType: "tsgo",
    getNullType: "tsgo",
    getESSymbolType: "tsgo",
    getNeverType: "tsgo",
    getNonPrimitiveType: "throw",
    getOptionalType: "throw",
    getUnionType: "adapter",
    createArrayType: "throw",
    getElementTypeOfArrayType: "throw",
    createPromiseType: "throw",
    getPromiseType: "throw",
    getPromiseLikeType: "throw",
    getAnyAsyncIterableType: "throw",
    isTypeAssignableTo: "adapter",
    createAnonymousType: "throw",
    createSignature: "throw",
    createSymbol: "throw",
    createIndexInfo: "throw",
    isSymbolAccessible: "throw",
    tryFindAmbientModule: "throw",
    getSymbolWalker: "throw",
    getDiagnostics: "adapter",
    getGlobalDiagnostics: "adapter",
    getEmitResolver: "adapter",
    requiresAddingImplicitUndefined: "throw",
    getNodeCount: "adapter",
    getIdentifierCount: "adapter",
    getSymbolCount: "adapter",
    getTypeCount: "adapter",
    getInstantiationCount: "adapter",
    getRelationCacheSizes: "adapter",
    getRecursionIdentity: "throw",
    getUnmatchedProperties: "throw",
    isArrayType: "tsgo",
    isTupleType: "tsgo",
    isArrayLikeType: "adapter",
    isTypeInvalidDueToUnionDiscriminant: "adapter",
    getExactOptionalProperties: "throw",
    getAllPossiblePropertiesOfTypes: "adapter",
    resolveName: "adapter",
    getJsxNamespace: "throw",
    getJsxFragmentFactory: "throw",
    getAccessibleSymbolChain: "throw",
    getTypePredicateOfSignature: "tsgo",
    resolveExternalModuleName: "throw",
    resolveExternalModuleSymbol: "adapter",
    tryGetThisTypeAt: "adapter",
    getTypeArgumentConstraint: "throw",
    getSuggestionDiagnostics: "adapter",
    runWithCancellationToken: "adapter",
    getLocalTypeParametersOfClassOrInterfaceOrTypeAlias: "throw",
    isDeclarationVisible: "adapter",
    isPropertyAccessible: "throw",
    getTypeOnlyAliasDeclaration: "throw",
    getMemberOverrideModifierStatus: "throw",
    isTypeParameterPossiblyReferenced: "throw",
    typeHasCallOrConstructSignatures: "adapter",
    getSymbolFlags: "adapter",
    fillMissingTypeArguments: "throw",
    getTypeArgumentsForResolvedSignature: "throw",
    isLibType: "throw",
} as const satisfies Record<keyof TypeChecker, TnbCheckerCoverage>;

// ── Program adapter coverage (compile-time guard) ──
//   "adapter" — explicit thinProgram implementation with real/stock-parity behavior.
//   "stub"    — intentional safe default (empty counters, undefined resolvers).
//   "throw"   — must not be called on supported paths; proxy throws if missing.
type TnbProgramCoverage = "adapter" | "stub" | "throw";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _tnbProgramCoverage = {
    getCompilerOptions: "adapter",
    getSourceFile: "adapter",
    getSourceFileByPath: "adapter",
    getCurrentDirectory: "adapter",
    getRootFileNames: "adapter",
    getSourceFiles: "adapter",
    getMissingFilePaths: "stub",
    getModuleResolutionCache: "stub",
    getFilesByNameMap: "stub",
    resolvedModules: "stub",
    resolvedTypeReferenceDirectiveNames: "stub",
    getResolvedModule: "stub",
    getResolvedModuleFromModuleSpecifier: "stub",
    getResolvedTypeReferenceDirective: "stub",
    getResolvedTypeReferenceDirectiveFromTypeReferenceDirective: "stub",
    forEachResolvedModule: "stub",
    forEachResolvedTypeReferenceDirective: "stub",
    emit: "adapter",
    getOptionsDiagnostics: "adapter",
    getGlobalDiagnostics: "adapter",
    getSyntacticDiagnostics: "adapter",
    getSemanticDiagnostics: "adapter",
    getDeclarationDiagnostics: "adapter",
    getConfigFileParsingDiagnostics: "adapter",
    getSuggestionDiagnostics: "adapter",
    getBindAndCheckDiagnostics: "adapter",
    getProgramDiagnostics: "adapter",
    getTypeChecker: "adapter",
    getCommonSourceDirectory: "adapter",
    getCachedSemanticDiagnostics: "stub",
    getClassifiableNames: "stub",
    getNodeCount: "stub",
    getIdentifierCount: "stub",
    getSymbolCount: "stub",
    getTypeCount: "stub",
    getInstantiationCount: "stub",
    getRelationCacheSizes: "stub",
    getFileProcessingDiagnostics: "stub",
    getAutomaticTypeDirectiveNames: "stub",
    getAutomaticTypeDirectiveResolutions: "stub",
    isSourceFileFromExternalLibrary: "adapter",
    isSourceFileDefaultLibrary: "adapter",
    getModeForUsageLocation: "adapter",
    getModeForResolutionAtIndex: "adapter",
    getDefaultResolutionModeForFile: "adapter",
    getImpliedNodeFormatForEmit: "adapter",
    getEmitModuleFormatOfFile: "adapter",
    shouldTransformImportCall: "adapter",
    structureIsReused: "stub",
    getSourceFileFromReference: "stub",
    getLibFileFromReference: "stub",
    sourceFileToPackageName: "stub",
    redirectTargetsMap: "stub",
    usesUriStyleNodeCoreModules: "stub",
    resolvedLibReferences: "stub",
    getProgramDiagnosticsContainer: "throw",
    getCurrentPackagesMap: "stub",
    isEmittedFile: "stub",
    getFileIncludeReasons: "stub",
    useCaseSensitiveFileNames: "adapter",
    getCanonicalFileName: "adapter",
    getProjectReferences: "adapter",
    getResolvedProjectReferences: "stub",
    getRedirectFromSourceFile: "stub",
    forEachResolvedProjectReference: "stub",
    getResolvedProjectReferenceByPath: "stub",
    getRedirectFromOutput: "stub",
    isSourceOfProjectReferenceRedirect: "stub",
    getCompilerOptionsForFile: "adapter",
    getBuildInfo: "stub",
    emitBuildInfo: "adapter",
    fileExists: "adapter",
    directoryExists: "stub",
    readFile: "stub",
    realpath: "stub",
    getSymlinkCache: "stub",
    getModuleSpecifierCache: "stub",
    getPackageJsonInfoCache: "stub",
    getGlobalTypingsCacheLocation: "stub",
    getNearestAncestorDirectoryWithPackageJson: "stub",
    trace: "stub",
    writeFile: "stub",
    getEmitSyntaxForUsageLocation: "adapter",
    typesPackageExists: "stub",
    packageBundlesTypes: "stub",
} as const satisfies Record<keyof Program, TnbProgramCoverage>;
