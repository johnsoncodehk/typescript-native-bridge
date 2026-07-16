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
import { SyntaxKind, SymbolFlags, SymbolFormatFlags, NodeFlags, ModifierFlags, JSDocParsingMode, ModuleKind, StructureIsReused, EmitHint, EmitFlags, type Path, type Program, type TypeChecker } from "./types.js";
import { getBuildInfoText, getTsBuildInfoEmitOutputFilePath, createPrinterWithRemoveComments } from "./emitter.js";
import { usingSingleLineStringWriter } from "./utilities.js";
import { getParseTreeNode, isFunctionLike } from "./utilitiesPublic.js";
import { setEmitFlags, addEmitFlags } from "./factory/emitNode.js";
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
    /** This project's thin program — checker-side host-SF lookups must use it
     * (not the global _hostProgramRef, which tracks the LAST created project). */
    thinProgram?: any;
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
    /** ProjectObjectRegistry.getOrCreateSignature is wrapped exactly once per
     * process — a second wrap would remap SignatureFlags values twice. */
    sigFlagsRemapApplied?: boolean;
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

/** Structure fingerprint of a thin program (for structureIsReused). */
type TnbProgramShape = {
    /** Sorted tsgo program file names. */
    fileNames: readonly string[];
    /** Compiler options the program was created with. */
    options: any;
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

// ── RPC / invalidation trace (default OFF; TNB_RPC_TRACE=1 or TNB_TRACE_RPC=1) ──
// Writes ENTER/EXIT + EVENT lines to TNB_RPC_TRACE_FILE (default /tmp/tnb-rpc.log).
// Zero overhead when unset: the flag is snapshotted once at module load.
let _rpcTraceSeq = 0;
const _rpcTraceEnabled = process.env.TNB_RPC_TRACE === "1" || process.env.TNB_TRACE_RPC === "1";
const _rpcTraceLog: string = _rpcTraceEnabled
    ? (process.env.TNB_RPC_TRACE_FILE || process.env.TNB_TRACE_RPC_FILE || "/tmp/tnb-rpc.log")
    : "";
const _rpcTraceEnterTs = new Map<number, number>();
function _rpcTraceEnter(method: string, binary: boolean, session: number): number {
    if (!_rpcTraceLog) return 0;
    const id = ++_rpcTraceSeq;
    const now = Date.now();
    _rpcTraceEnterTs.set(id, now);
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(
        _rpcTraceLog,
        `${now} ENTER ${id} pid=${process.pid} sess=${session} ${binary ? "BIN" : "JSON"} ${method}\n`,
    );
    return id;
}
function _rpcTraceExit(id: number, method: string): void {
    if (!_rpcTraceLog || id === 0) return;
    const now = Date.now();
    const t0 = _rpcTraceEnterTs.get(id);
    _rpcTraceEnterTs.delete(id);
    const ms = t0 != null ? now - t0 : -1;
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(_rpcTraceLog, `${now} EXIT ${id} ${method} ms=${ms}\n`);
}
/** Event channel for cache invalidation / structure reuse (same env gate). */
function _rpcTraceEvent(kind: string, detail: string): void {
    if (!_rpcTraceLog) return;
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(_rpcTraceLog, `${Date.now()} EVENT ${kind} ${detail}\n`);
}

/** True when this process is a tsserver entry (IDE / harness), not tsc/vue-tsc. */
function isTsserverProcess(): boolean {
    const script = process.argv[1] ?? "";
    if (/(?:^|[/\\])_?tsserver\.(?:js|cjs|mjs)$/.test(script)) return true;
    // VS Code / Volar fork with --useNodeIpc even if the script path is wrapped.
    if (process.argv.includes("--useNodeIpc")) return true;
    return false;
}

/**
 * Install JS SIGTERM/SIGINT/SIGHUP handlers so Node's C++ SignalExit/ResetStdio
 * never runs in signal context alongside the embedded Go runtime (see loadBridgeDeps).
 * Idempotent via proc.signalExitBypassInstalled.
 */
function installSignalExitBypass(proc: TnbBridgeProcessState): void {
    if (proc.signalExitBypassInstalled) return;
    if (process.env.TNB_SIGNAL_EXIT_BYPASS === "0") return;
    if (!(process.env.TNB_SIGNAL_EXIT_BYPASS === "1"
        || process.env.VITEST
        || process.env.JEST_WORKER_ID
        || isTsserverProcess())) {
        return;
    }
    proc.signalExitBypassInstalled = true;
    const disposeBridgeBestEffort = () => {
        // Dispose the koffi BridgeClient session. SyncRpcChannel (if used)
        // kills its children via the process `exit` hook fired by process.exit.
        try {
            tnbBridgeProcessState().api?.close?.();
        }
        catch { /* best-effort */ }
        try {
            _api?.close?.();
        }
        catch { /* best-effort */ }
    };
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    for (const sig of signals) {
        if (process.listenerCount(sig) === 0) {
            process.on(sig, () => {
                disposeBridgeBestEffort();
                // tsserver: exit 0 (handout). test runners: keep 128+n
                // so harnesses that inspect signal exit codes still work.
                if (process.env.VITEST || process.env.JEST_WORKER_ID) {
                    const n = sig === "SIGHUP" ? 1 : sig === "SIGINT" ? 2 : 15;
                    process.exit(128 + n);
                }
                process.exit(0);
            });
        }
    }
}

function loadBridgeDeps(): void {
    const proc = tnbBridgeProcessState();
    if (proc.koffi) {
        hydrateBridgeModuleLocals(proc);
        installSignalExitBypass(proc);
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
    // noembed: point tsgo at TNB lib/ before dlopen. Go may snapshot environ at
    // runtime init, so noembed.go reads TNB_LIB_PATH via libc getenv (live), which
    // sees this setenv as long as it happens before koffi.load below.
    // External non-empty override wins — do not clobber a pre-set path.
    if (!process.env.TNB_LIB_PATH) {
        process.env.TNB_LIB_PATH = path.join(packageRoot, "lib");
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
    // ── SignalExit bypass (tsserver + test runners) ──
    // See installSignalExitBypass. Stock tsserver has no SIGTERM/SIGHUP
    // listeners (nodeServer listen uses disconnect/stdin-close → process.exit);
    // we only install when none exist so we never override foreign handlers.
    // NOTE: never touch SIGURG from JS — that would replace the Go runtime's
    // own handler. Harness parent-watch (TNB_PARENT_PID) is independent.
    installSignalExitBypass(proc);
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
// Shape of the last thin program per (LanguageServiceHost, tsconfig) — the next
// createTsgoProgram for the same host+config compares against it to report
// structureIsReused. Keyed per host, not just per tsconfig: tsserver runs
// several Projects over one tsconfig (the configured project and its
// AutoImportProviderProject inherit the same options.configFilePath), and their
// program rebuilds interleave. WeakMap so closed projects drop their shapes.
const _programShapeByHost = new WeakMap<object, Map<string, TnbProgramShape>>();
// Hosts that are not stable objects (plain CompilerHost per createProgram call)
// fall back to a config-keyed memo. Module-level (not cross-bundle): shape
// tracking sequences JS-side program rebuilds, which stay within one bundle.
const _programShapeNoHost = new Map<string, TnbProgramShape>();

// Cross-generation host SourceFile reuse for disk-stable declaration files
// (node_modules .d.ts). Every keystroke rebuilds the thin program with a fresh
// per-program sfCache, so services loops that walk program.getSourceFiles()
// (auto-import codefix forEachExternalModuleToImportFrom) re-parsed + re-bound
// every library .d.ts each edit (~750ms of the getCodeFixes wall). Content
// stability is keyed by host getScriptVersion; a changed file gets a new
// version and misses. Same reuse rule stock applies via oldProgram
// (structureIsReused) — bound host ASTs are content-addressed and safe to
// share across generations. Keyed per LS host so closed projects drop entries.
const _hostSfStableByHost = new WeakMap<object, Map<string, { version: string; sf: any }>>();
const _hostSfStableNoHost = new Map<string, { version: string; sf: any }>();
function isStableHostSfPath(p: string): boolean {
    if (process.env.TNB_DISABLE_STABLE_HOST_SF === "1") return false;
    return p.endsWith(".d.ts") && (p.includes("/node_modules/") || isHostLibFile(p));
}
function getHostSfStableCache(lsHost: any): Map<string, { version: string; sf: any }> {
    if (typeof lsHost === "object" && lsHost !== null) {
        let m = _hostSfStableByHost.get(lsHost);
        if (!m) { m = new Map(); _hostSfStableByHost.set(lsHost, m); }
        return m;
    }
    return _hostSfStableNoHost;
}

// Cross-generation node index reuse, keyed by the tsgo RemoteSourceFile
// object. The checker adapter (and its per-generation nodeIndexCache) is
// recreated per program, but MiniSourceFileCache hands back the same decoded
// RemoteSourceFile object for disk-stable declaration files across snapshots,
// so a full-file position index keyed by that object stays valid until the
// file's content changes (which yields a new object). Auto-import codefix
// resolves module symbols through findTsgoNodeAtPosition on dozens of
// node_modules .d.ts per keystroke; rebuilding those indexes per generation
// dominated the getCodeFixes wall.
const _nodeIndexBySf = new WeakMap<object, Map<number, any[]>>();

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

    // v7.0.2+ Client surface: the API layer probes the timing collector on
    // every RemoteSourceFile decode. TNB never enables timing collection, so
    // report it as disabled.
    getTimingCollector(): undefined {
        return undefined;
    }

    getTimingInfo(): any {
        return { enabled: false };
    }

    resetTimingInfo(): void { /* timing collection disabled */ }

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
        // noembed: lib paths are real packageRoot/lib/*.d.ts (no bundled://).
        return p.endsWith(".d.ts") && (p.includes("/node_modules/") || p.includes("bundled://") || isBundledLibPath(p) || isHostLibFile(p));
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
        let changedN = 0;
        let deletedN = 0;
        const sample: string[] = [];
        for (const projKey of Object.keys(changedProjects)) {
            const c = changedProjects[projKey];
            for (const p of c?.changedFiles ?? []) {
                this.stableByPath.delete(p);
                changedN++;
                if (sample.length < 6) sample.push(`C:${p}`);
            }
            for (const p of c?.deletedFiles ?? []) {
                this.stableByPath.delete(p);
                deletedN++;
                if (sample.length < 6) sample.push(`D:${p}`);
            }
        }
        if (changedN || deletedN) {
            _rpcTraceEvent("MiniSourceFileCache.invalidate", `changed=${changedN} deleted=${deletedN} sample=${sample.join(",")}`);
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
/** Light-stub vs full SourceFile materialization counters (Soft-P′ proof). */
let _tnbLightStubCreations = 0;
let _tnbFullSfMaterializations = 0;

/** @internal Dump / reset Soft-P′ materialization counters (env-gated readers). */
export function tnbGetSourceFileMaterializeStats(reset = false): { lightStub: number; full: number } {
    const out = { lightStub: _tnbLightStubCreations, full: _tnbFullSfMaterializations };
    if (reset) {
        _tnbLightStubCreations = 0;
        _tnbFullSfMaterializations = 0;
    }
    return out;
}

/** tsserver fork pipes stderr — mirror Soft-P′ stats to a file the parent can read. */
function tnbLogSfMaterialize(line: string): void {
    if (process.env.TNB_SF_MATERIALIZE_STATS !== "1") return;
    // eslint-disable-next-line no-console
    console.error(line);
    try {
        const file = process.env.TNB_SF_MATERIALIZE_FILE || "/tmp/tnb-sf-materialize.jsonl";
        const fs = require("fs") as typeof import("fs");
        fs.appendFileSync(file, line + "\n");
    }
    catch { /* best-effort */ }
}

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
/**
 * Bumped when overlay content refresh clears symbol caches. Parent memo on
 * Symbol.prototype must not survive a new snapshot generation (direction E).
 */
let _tnbParentMemoEpoch = 0;
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
const _traceThrowEnabled = process.env.TNB_TRACE_THROW === "1";
const _traceThrowFile = process.env.TNB_TRACE_THROW_FILE;
function traceThrow(kind: "TypeChecker" | "Program", method: string): void {
    if (!_traceThrowEnabled) return;
    try {
        const raw = new Error().stack ?? "";
        const frames = raw.split("\n").slice(2, 7).map(s => s.trim()).filter(Boolean);
        const line = JSON.stringify({ kind, method, stack: frames }) + "\n";
        if (_traceThrowFile) {
            const fs = require("fs") as typeof import("fs");
            fs.appendFileSync(_traceThrowFile, line, "utf8");
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
            const containing = info.containingProjects;
            const inProject = containing?.includes?.(syncHost);
            if (!inProject) {
                // Foreign tabs must not be adopted into this project's tsgo
                // roots. Never probe via project.getScriptSnapshot here — on a
                // tsserver Project it ATTACHES the info to the project
                // (getOrCreateScriptInfoAndAttachToProject), so multi-project
                // reference search then routes the file into sibling projects
                // whose program lacks it ("Could not find source file" throws).
                if (containing && containing.length > 0) return;
                // Unassigned tab (assignment may still be in flight during
                // first project load). A configured project only adopts tabs
                // living under its own config directory — a tab outside it
                // belongs to a sibling config that hasn't loaded yet, and
                // adopting it would route multi-project reference search into
                // a program that lacks the file ("Could not find source
                // file"). In-memory-only tabs (no disk file) under the config
                // dir are legitimate members (include:**/* would match them).
                if (syncHost.projectKind === 1 /* ProjectKind.Configured */) {
                    const cfg: string | undefined = syncHost.canonicalConfigFilePath
                        ?? syncHost.getProjectName?.();
                    const cfgDir = typeof cfg === "string" ? cfg.slice(0, cfg.lastIndexOf("/") + 1) : "";
                    if (!cfgDir) return;
                    const tabPath = String(path);
                    if (!tabPath.startsWith(cfgDir.toLowerCase()) && !info.fileName?.startsWith(cfgDir)) return;
                }
                if (!info.getSnapshot?.()) return;
            }
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
/**
 * Soft-P′: stock `Program.collectExternalModuleReferences` fills `SourceFile.imports`.
 * Host-bound LS files never pass through that path. Assigning `imports: []` here poisoned
 * importTracker.forEachImport — when `imports !== undefined` it iterates the array and
 * NEVER falls through to statement scanning, so closed/open importer files look import-less
 * and FAR never finds cross-file import sites even when getExportInfo succeeds.
 */
function ensureHostSourceFileModuleRefs(sf: any): void {
    if (!sf) return;
    // Real imports already collected — keep. Empty `[]` may be Soft-P′ poison from an
    // earlier attachHostSourceFileMetadata; rebuild from statements.
    if (sf.imports && sf.imports.length > 0) return;
    const imports: any[] = [];
    const pushSpec = (spec: any): void => {
        if (
            spec
            && typeof spec.text === "string"
            && spec.text.length
            && (spec.kind === SyntaxKind.StringLiteral || spec.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
        ) {
            imports.push(spec);
        }
    };
    // Mirror stock Program.collectExternalModuleReferences (program.ts:3362-3371):
    // statement-level import/re-export/import-equals specifiers PLUS type-space
    // import("mod").T arguments and dynamic import()/require() call arguments —
    // findModuleReferences (importTracker.forEachImport) matches module symbols
    // only through file.imports, so omitting type-space literals drops FAR refs
    // at `import('vue').X` sites (sim-nav refs-missing cross-vue cluster).
    const walk = (node: any): void => {
        if (!node) return;
        const kind = node.kind;
        if (kind === SyntaxKind.ImportDeclaration || kind === SyntaxKind.ExportDeclaration) {
            pushSpec(node.moduleSpecifier);
        }
        else if (kind === SyntaxKind.ImportEqualsDeclaration) {
            const ref = node.moduleReference;
            if (ref?.kind === SyntaxKind.ExternalModuleReference) {
                pushSpec(ref.expression);
            }
        }
        else if (kind === SyntaxKind.ImportType) {
            const arg = node.argument;
            if (arg?.kind === SyntaxKind.LiteralType) {
                pushSpec(arg.literal);
            }
        }
        else if (kind === SyntaxKind.CallExpression) {
            const expr = node.expression;
            if (expr?.kind === SyntaxKind.ImportKeyword || (expr?.kind === SyntaxKind.Identifier && expr.text === "require")) {
                pushSpec(node.arguments?.[0]);
            }
        }
        (ts as any).forEachChild?.(node, walk);
    };
    for (const statement of sf.statements ?? []) walk(statement);
    sf.imports = imports;
}

function attachHostSourceFileMetadata(sf: any, hostFileName: string): any {
    const canon = canonicalSourceFilePath(hostFileName);
    sf.fileName = hostFileName;
    sf.originalFileName = hostFileName;
    sf.path = canon as Path;
    sf.resolvedPath = canon as Path;
    ensureHostSourceFileModuleRefs(sf);
    if (!sf.moduleAugmentations) sf.moduleAugmentations = [];
    // Stock sets ambientModuleNames in collectExternalModuleReferences (program
    // construction), which the thin program skips. The export-map cache's
    // onFileChanged iterates it (ambientModuleDeclarationsAreEqual) whenever a
    // structure-reused program reports a changed file — derive it from the
    // parsed statements so ambient-module edits still invalidate the cache.
    if (!sf.ambientModuleNames) {
        sf.ambientModuleNames = ((sf.statements ?? []) as any[])
            .filter(s => s.kind === SyntaxKind.ModuleDeclaration && s.name?.kind === SyntaxKind.StringLiteral)
            .map(s => s.name.text);
    }
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
    // Soft-P′ materializes full host ASTs for closed/import-tracker files
    // (including node_modules under tsserver projectService). Stock binder
    // always attaches ExportSpecifier.symbol / SourceFile.symbol; without that,
    // FAR getReferencesAtExportSpecifier Debug.checkDefined crashes and
    // importTracker.getContainingModuleSymbol → getDirectImports(undefined)
    // reads .id on undefined. Bind those files for binder fields only — do NOT
    // brand __tnbHostBound (disk/node_modules keep RPC symbol identity).
    if (!isOverlayCandidatePath(sf.fileName)) {
        if (sf.__tnbSoftBound) return;
        sf.__tnbSoftBound = true;
        if (sf.symbol === undefined) {
            try { bindSourceFile(sf, options); } catch { /* best-effort */ }
        }
        ensureHostSourceFileModuleRefs(sf);
        return;
    }
    if (sf.symbol !== undefined) {
        sf.__tnbHostBound = true;
        ensureHostSourceFileModuleRefs(sf);
        return;
    }
    try { bindSourceFile(sf, options); } catch { /* best-effort */ }
    sf.__tnbHostBound = true;
    ensureHostSourceFileModuleRefs(sf);
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
// tsgo's JSDoc extraction keeps the comment's trailing newline; stock's parser
// strips it. Trim at the boundary so doc/tag texts match stock byte-for-byte.
function trimDocTrailingNewlines(text: string): string {
    return text.replace(/\n+$/, "");
}
function trimDocPartsTrailingNewlines(parts: any[] | undefined): any[] {
    if (!parts?.length) return parts ?? [];
    const last = parts[parts.length - 1];
    if (typeof last?.text === "string" && /\n$/.test(last.text)) {
        parts[parts.length - 1] = { ...last, text: trimDocTrailingNewlines(last.text) };
    }
    return parts;
}
function trimJsDocTagsTrailingNewlines(tags: any[] | undefined): any[] {
    if (!tags?.length) return tags ?? [];
    for (const tag of tags) {
        if (Array.isArray(tag?.text)) trimDocPartsTrailingNewlines(tag.text);
        else if (typeof tag?.text === "string") tag.text = trimDocTrailingNewlines(tag.text);
    }
    return tags;
}
function displayPartsFromDocText(text: string): any[] {
    const trimmed = trimDocTrailingNewlines(text);
    return trimmed ? [{ kind: "text", text: trimmed }] : [];
}
let _removeCommentsPrinter: any;
function getRemoveCommentsPrinter(): any {
    return _removeCommentsPrinter ??= createPrinterWithRemoveComments();
}
/** True when `pos` is assignable — host AST nodes, not RemoteNodeBase. */
function isMutableHostAstNode(node: any): boolean {
    if (!node) return false;
    try {
        const prev = node.pos;
        node.pos = prev;
        return true;
    } catch {
        return false;
    }
}
/**
 * Shape-transform a decoded tsgo TypeNode (RemoteNode) into a mutable host
 * TypeNode so stock factory/textChanges can nest/replace it. Semantics come
 * from the printed type text; no checker reimplementation.
 */
function hostifyDecodedTypeNode(typeNode: any): any {
    if (!typeNode) return undefined;
    if (isMutableHostAstNode(typeNode)) return typeNode;
    const text = usingSingleLineStringWriter(writer => {
        getRemoveCommentsPrinter().writeNode(EmitHint.Unspecified, typeNode, /*sourceFile*/ undefined, writer);
    });
    if (!text) return undefined;
    const sf = createSourceFile(
        "__tnb_typeToTypeNode.ts",
        `type __T = ${text};`,
        hostSourceFileOptions(/*languageVersion*/ 99, /*host*/ undefined),
        /*setParentNodes*/ true,
        /*scriptKind*/ 3 /* ScriptKind.TS */,
    );
    const stmt: any = sf.statements?.[0];
    return stmt?.type;
}

/** Hostify a decoded declaration-like node (index signature, etc.) for textChanges. */
function hostifyDecodedDeclarationNode(node: any): any {
    if (!node) return undefined;
    if (isMutableHostAstNode(node)) return node;
    stampIdentifierEscapedText(node);
    const text = usingSingleLineStringWriter(writer => {
        getRemoveCommentsPrinter().writeNode(EmitHint.Unspecified, node, /*sourceFile*/ undefined, writer);
    });
    if (!text) return undefined;
    const sf = createSourceFile(
        "__tnb_declNode.ts",
        `interface __D { ${text} }`,
        hostSourceFileOptions(/*languageVersion*/ 99, /*host*/ undefined),
        /*setParentNodes*/ true,
        /*scriptKind*/ 3 /* ScriptKind.TS */,
    );
    const stmt: any = sf.statements?.[0];
    const member = stmt?.members?.[0];
    return member;
}
/** Hostify signature declarations for completions/codefix (kind-sensitive parse). */
function hostifyDecodedSignatureDeclaration(node: any, kind: number): any {
    if (!node) return undefined;
    if (isMutableHostAstNode(node)) return node;
    stampIdentifierEscapedText(node);
    let text = usingSingleLineStringWriter(writer => {
        getRemoveCommentsPrinter().writeNode(EmitHint.Unspecified, node, /*sourceFile*/ undefined, writer);
    });
    if (!text) return undefined;
    // Nodebuilder often emits nameless methods (`(): T`); inject a placeholder so
    // the reparse is legal. Callers replace the name via factory.update*.
    if (/^\s*[\(<]/.test(text) || /^\s*</.test(text)) {
        text = `__m${text}`;
    }
    // MethodDeclaration must be reparsed as a class member (interface wrap yields MethodSignature).
    if (kind === SyntaxKind.MethodDeclaration) {
        const sf = createSourceFile(
            "__tnb_methodDecl.ts",
            `class __C { ${text} }`,
            hostSourceFileOptions(/*languageVersion*/ 99, /*host*/ undefined),
            /*setParentNodes*/ true,
            /*scriptKind*/ 3 /* ScriptKind.TS */,
        );
        const stmt: any = sf.statements?.[0];
        return stmt?.members?.[0];
    }
    if (kind === SyntaxKind.FunctionDeclaration) {
        if (/^\s*(async\s+)?function\b/.test(text) === false) {
            text = `function ${text}`;
        }
        const sf = createSourceFile(
            "__tnb_fnDecl.ts",
            text,
            hostSourceFileOptions(/*languageVersion*/ 99, /*host*/ undefined),
            /*setParentNodes*/ true,
            /*scriptKind*/ 3 /* ScriptKind.TS */,
        );
        return sf.statements?.[0];
    }
    // FunctionExpression / ArrowFunction
    const sf = createSourceFile(
        "__tnb_fnExpr.ts",
        `const __e = (${text});`,
        hostSourceFileOptions(/*languageVersion*/ 99, /*host*/ undefined),
        /*setParentNodes*/ true,
        /*scriptKind*/ 3 /* ScriptKind.TS */,
    );
    const stmt: any = sf.statements?.[0];
    let init = stmt?.declarationList?.declarations?.[0]?.initializer;
    while (init?.kind === SyntaxKind.ParenthesizedExpression) init = init.expression;
    return init;
}
/** Hostify a decoded expression (symbolToExpression) for factory/textChanges. */
function hostifyDecodedExpression(node: any): any {
    if (!node) return undefined;
    if (isMutableHostAstNode(node)) return node;
    stampIdentifierEscapedText(node);
    const text = usingSingleLineStringWriter(writer => {
        getRemoveCommentsPrinter().writeNode(EmitHint.Unspecified, node, /*sourceFile*/ undefined, writer);
    });
    if (!text) return undefined;
    const sf = createSourceFile(
        "__tnb_exprNode.ts",
        `const __e = (${text});`,
        hostSourceFileOptions(/*languageVersion*/ 99, /*host*/ undefined),
        /*setParentNodes*/ true,
        /*scriptKind*/ 3 /* ScriptKind.TS */,
    );
    const stmt: any = sf.statements?.[0];
    let init = stmt?.declarationList?.declarations?.[0]?.initializer;
    // Unwrap the synthetic parens from `const __e = (…);`.
    while (init?.kind === SyntaxKind.ParenthesizedExpression) init = init.expression;
    return init;
}
/** Hostify a decoded property name (symbolToNode ComputedPropertyName / Identifier). */
function hostifyDecodedPropertyName(node: any): any {
    if (!node) return undefined;
    if (isMutableHostAstNode(node)) return node;
    stampIdentifierEscapedText(node);
    const text = usingSingleLineStringWriter(writer => {
        getRemoveCommentsPrinter().writeNode(EmitHint.Unspecified, node, /*sourceFile*/ undefined, writer);
    });
    if (!text) return undefined;
    const sf = createSourceFile(
        "__tnb_propName.ts",
        `const __o = { ${text}: 0 };`,
        hostSourceFileOptions(/*languageVersion*/ 99, /*host*/ undefined),
        /*setParentNodes*/ true,
        /*scriptKind*/ 3 /* ScriptKind.TS */,
    );
    const stmt: any = sf.statements?.[0];
    const init = stmt?.declarationList?.declarations?.[0]?.initializer;
    return init?.properties?.[0]?.name;
}
/** Hostify a TypePredicateNode via function return-type position (legal syntax). */
function hostifyDecodedTypePredicateNode(node: any): any {
    if (!node) return undefined;
    if (isMutableHostAstNode(node)) return node;
    stampIdentifierEscapedText(node);
    const text = usingSingleLineStringWriter(writer => {
        getRemoveCommentsPrinter().writeNode(EmitHint.Unspecified, node, /*sourceFile*/ undefined, writer);
    });
    if (!text) return undefined;
    const sf = createSourceFile(
        "__tnb_predNode.ts",
        `function __f(x: unknown): ${text} { return true as any; }`,
        hostSourceFileOptions(/*languageVersion*/ 99, /*host*/ undefined),
        /*setParentNodes*/ true,
        /*scriptKind*/ 3 /* ScriptKind.TS */,
    );
    const stmt: any = sf.statements?.[0];
    return stmt?.type;
}

function attachTypeParameterNameSymbols(typeNode: any, typeParameters: readonly any[] | undefined): void {
    if (!typeNode || !typeParameters?.length) return;
    const symByName = new Map<string, any>();
    for (const tp of typeParameters) {
        const sym = tp?.symbol ?? tp;
        const name = symbolDisplayNameOf(sym);
        if (name) symByName.set(name, sym);
    }
    const visit = (node: any): void => {
        if (!node) return;
        if (node.kind === SyntaxKind.Identifier && !node.symbol) {
            const name = node.escapedText ?? node.text;
            const sym = symByName.get(String(name));
            if (sym) node.symbol = sym;
        }
        ts.forEachChild(node, visit);
    };
    visit(typeNode);
}
function attachTypeParameterSymbolsFromType(type: any, typeNode: any): void {
    if (!type || !typeNode) return;
    const sym = type.symbol;
    if (!(sym?.flags & SymbolFlags.TypeParameter)) return;
    const visit = (node: any): void => {
        if (!node) return;
        if (node.kind === SyntaxKind.Identifier && !node.symbol) node.symbol = sym;
        ts.forEachChild(node, visit);
    };
    visit(typeNode);
}
/**
 * Pair a Type with its typeToTypeNode result and attach `.symbol` to type
 * reference name identifiers. The emitter classifies identifier display parts
 * by node.symbol (className/interfaceName/...); RPC-decoded nodes carry no
 * symbol association, so `GenericClass<...>` would degrade to kind "text".
 */
function attachTypeReferenceSymbols(checker: any, type: any, typeNode: any): void {
    if (!type || !typeNode || typeNode.kind !== SyntaxKind.TypeReference) return;
    const nameNode = typeNode.typeName;
    const ident = nameNode?.kind === SyntaxKind.QualifiedName ? nameNode.right : nameNode;
    if (ident?.kind === SyntaxKind.Identifier && !ident.symbol) {
        const sym = type.aliasSymbol ?? type.symbol;
        const name = String(ident.escapedText ?? ident.text ?? "");
        if (sym && symbolDisplayNameOf(sym) === name) ident.symbol = sym;
    }
    const argNodes = typeNode.typeArguments;
    if (!argNodes?.length) return;
    let typeArgs: readonly any[] | undefined;
    try {
        typeArgs = type.aliasSymbol ? type.aliasTypeArguments : checker.getTypeArguments(type);
    }
    catch { return; }
    if (!typeArgs || typeArgs.length !== argNodes.length) return;
    for (let i = 0; i < argNodes.length; i++) {
        attachTypeReferenceSymbols(checker, typeArgs[i], argNodes[i]);
    }
}
function forceSingleLineEmitFlags(node: any): void {
    if (!node || typeof node !== "object") return;
    const emitNode = node.emitNode ?? (node.emitNode = { internalFlags: 0 });
    emitNode.flags = (emitNode.flags ?? 0) | EmitFlags.SingleLine;
}
function applySingleLineEmitFlagsToTypeSubtree(node: any): void {
    if (!node) return;
    forceSingleLineEmitFlags(node);
    ts.forEachChild(node, (child: any) => {
        applySingleLineEmitFlagsToTypeSubtree(child);
    });
}
/**
 * Stock NodeBuilder (checker.ts ~7416) stamps EmitFlags.SingleLine on each
 * TypeLiteral unless NodeBuilderFlags.MultilineObjectLiterals is set.
 * typeToDisplayParts / signatureToDisplayParts always OR
 * TypeFormatFlags.MultilineObjectLiterals (= 1<<10, same bit) before writeType.
 *
 * Early bridge writeType forced SingleLine on the whole type subtree for
 * signature-help part classification — that also crushed QI type-alias /
 * declaration bodies that stock prints multiline. Gate on the flag instead:
 * multiline callers clear SingleLine on TypeLiterals; others keep SingleLine.
 */
const TypeFormatFlagsMultilineObjectLiterals = 1 << 10;
/**
 * tsgo TypeFormatFlags.WriteCallStyleSignature (1<<27). Stock JS picks
 * CallSignature whenever signatureToString's `kind` arg is not Construct
 * (services always pass kind=undefined via signatureToDisplayParts). tsgo
 * instead keys off SignatureFlags.Construct unless this flag is set — without
 * it, construct sigs print as `new <T>(...)` while stock prints `<T>(...)`.
 */
const TypeFormatFlagsWriteCallStyleSignature = 1 << 27;
/** SignatureKind.Construct — only value that should keep construct print style. */
const SignatureKindConstruct = 1;
/**
 * Stock writeType → typeToString converts TypeFormatFlags → NodeBuilderFlags via
 * `toNodeBuilderFlags(flags) | IgnoreErrors | (noTruncation ? NoTruncation : 0)`
 * and passes maximumLength/verbosityLevel into NodeBuilder VerbosityContext.
 *
 * typeToDisplayParts ORs MultilineObjectLiterals | UseAliasDefinedOutsideCurrentScope
 * and passes maximumLength (QI defaultHoverMaximumTruncationLength=500).
 *
 * Bridge writeType must mask to NodeBuilderFlagsMask and OR IgnoreErrors before the
 * typeToTypeNode RPC (expects NodeBuilderFlags). maximumLength/verbosityLevel still
 * cannot cross RPC (TypeToTypeNodeParams has no Verbosity fields) — Go defaults to
 * maxTruncationLength=160 vs stock hover 500; that density delta is (b) in
 * checker/nodebuilder.go VerbosityContext + api/session.go handleTypeToTypeNode.
 * Do not fake MaxTruncationLength with NoTruncation (overshoots to 1e6).
 */
/** Matches TypeFormatFlags.NodeBuilderFlagsMask (types.ts). */
const TypeFormatFlagsNodeBuilderFlagsMask =
    (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 5) | (1 << 6) | (1 << 8) | (1 << 10) |
    (1 << 11) | (1 << 12) | (1 << 13) | (1 << 14) | (1 << 20) | (1 << 23) | (1 << 25) | (1 << 28) | (1 << 29);
/** NodeBuilderFlags.IgnoreErrors composite (Allow* recoverability bits). */
const NodeBuilderFlagsIgnoreErrors =
    (1 << 15) | (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 21) | (1 << 26);
function toWriteTypeNodeBuilderFlags(flags?: number, _maximumLength?: number): number {
    // Stock typeToString: toNodeBuilderFlags(flags) | IgnoreErrors | (noTruncation ? NoTruncation : 0).
    // Preserve caller's NoTruncation bit via the mask; do NOT invent NoTruncation from
    // maximumLength — that overshoots stock hover MaxTruncationLength (500) to Go's
    // noTruncation budget (1e6) and inflates display past stock (see defineComponent-call).
    // Passing MaxTruncationLength requires VerbosityContext on typeToTypeNode RPC → (b).
    let nodeFlags = ((flags ?? 0) & TypeFormatFlagsNodeBuilderFlagsMask) | NodeBuilderFlagsIgnoreErrors;
    return nodeFlags;
}
function clearTypeLiteralSingleLineEmitFlags(node: any): void {
    if (!node) return;
    if (node.kind === SyntaxKind.TypeLiteral && node.emitNode) {
        node.emitNode.flags = (node.emitNode.flags ?? 0) & ~EmitFlags.SingleLine;
    }
    ts.forEachChild(node, (child: any) => {
        clearTypeLiteralSingleLineEmitFlags(child);
    });
}
function applyWriteTypeEmitFlagsForFormat(typeNode: any, flags?: number): void {
    if (!typeNode) return;
    if ((flags ?? 0) & TypeFormatFlagsMultilineObjectLiterals) {
        // Stock: setEmitFlags(typeLiteral, 0) when MultilineObjectLiterals.
        // Also skip the bridge-wide SingleLine force. Clear any SingleLine tsgo
        // may have stamped so the host printer uses MultiLineTypeLiteralMembers.
        clearTypeLiteralSingleLineEmitFlags(typeNode);
    }
    else {
        applySingleLineEmitFlagsToTypeSubtree(typeNode);
    }
}
function applySingleLineEmitFlagsToDeclaration(node: any): any {
    if (!node) return node;
    const visit = (n: any): void => {
        if (!n || n.kind === SyntaxKind.SourceFile) return;
        forceSingleLineEmitFlags(n);
        ts.forEachChild(n, visit);
    };
    visit(node);
    return node;
}

/**
 * Decoded RemoteNode Identifiers expose `.text` but older native-preview builds
 * omit `.escapedText`. Stock printer `idText` reads `escapedText` only — stamp
 * an own property so emit/textChanges do not crash on undefined.length.
 */
function stampIdentifierEscapedText(node: any, fallbackName?: string): void {
    if (!node || typeof node !== "object") return;
    const kind = node.kind;
    // Accept stock (80/81) and raw tsgo (79/80) Identifier kinds — remap may not
    // have run yet when NodeBuilder first returns a decoded node.
    if (kind === SyntaxKind.Identifier || kind === SyntaxKind.PrivateIdentifier || kind === 79 || kind === 80 || kind === 81) {
        const text = node.escapedText ?? node.text ?? fallbackName;
        if (text != null && text !== "") {
            const s = String(text);
            try {
                Object.defineProperty(node, "escapedText", { value: s, configurable: true, writable: true, enumerable: true });
            } catch { /* prototype may block; best-effort */ }
            try {
                if (node.text == null) {
                    Object.defineProperty(node, "text", { value: s, configurable: true, writable: true, enumerable: true });
                }
            } catch { /* ignore */ }
        }
    }
    ts.forEachChild(node, (child: any) => stampIdentifierEscapedText(child));
}

function applySingleLineEmitFlagsRecursive(node: any): any {
    applySingleLineEmitFlagsToTypeSubtree(node);
    return node;
}
const typeKeywordNames = new Set([
    "string", "number", "boolean", "undefined", "null", "void", "never",
    "unknown", "any", "bigint", "symbol", "object",
]);
function writeTypeTextFallback(writer: any, text: string): void {
    if (!text) return;
    if (typeKeywordNames.has(text) && writer.writeKeyword) {
        writer.writeKeyword(text);
    }
    else {
        writer.write?.(text);
    }
}
function bridgeTypePredicateToHostNode(predicate: any, typeNode: any): any {
    const factory = ts.factory;
    const kind = predicate.kind as number;
    let assertsModifier: any;
    if (kind === 2 || kind === 3) {
        assertsModifier = factory.createToken(SyntaxKind.AssertsKeyword);
    }
    const parameterName = (kind === 1 || kind === 3)
        ? factory.createIdentifier(predicate.parameterName ?? "")
        : factory.createThisTypeNode();
    return factory.createTypePredicateNode(assertsModifier, parameterName, typeNode);
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

function stripQuotedModuleName(escaped: string): string {
    if (
        escaped.length >= 2
        && escaped.charCodeAt(0) === 0x22 /* " */
        && escaped.charCodeAt(escaped.length - 1) === 0x22
    ) {
        return escaped.slice(1, -1);
    }
    return escaped;
}

function normalizePackageJsonRelativePath(p: string): string {
    let s = p.replace(/\\/g, "/");
    if (s.startsWith("./")) s = s.slice(2);
    // package.json targets may carry emit extensions; binder module names do not.
    s = s.replace(/\.(d\.)?[cm]?tsx?$/i, "").replace(/\.(mjs|cjs|js)$/i, "");
    if (s.endsWith("/index")) s = s.slice(0, -"/index".length);
    return s;
}

function collectPackageExportTargets(value: unknown, out: string[]): void {
    if (typeof value === "string") {
        out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const v of value) collectPackageExportTargets(v, out);
        return;
    }
    if (value && typeof value === "object") {
        for (const v of Object.values(value as Record<string, unknown>)) {
            collectPackageExportTargets(v, out);
        }
    }
}

/**
 * Stock `symbolToString` → node builder `getSpecifierForModuleSymbol` maps a
 * file-path external module (`"…/node_modules/vue/dist/vue"`) back to the
 * package / relative specifier (`"vue"`, `"vue/server-renderer"`, `"./b"`).
 * FQN keeps the absolute binder name — only display mapping lives here.
 */
function tryPackageSpecifierFromNodeModulesPath(barePath: string): string | undefined {
    const nm = "/node_modules/";
    const idx = barePath.lastIndexOf(nm);
    if (idx < 0) return undefined;
    const after = barePath.slice(idx + nm.length);
    // Last segment must be a real package dir, not pnpm's `.pnpm` virtual store.
    if (!after || after.charCodeAt(0) === 0x2E /* . */) return undefined;
    const parsed = (ts as any).parsePackageName(after) as { packageName: string; rest: string };
    if (!parsed?.packageName) return undefined;
    const packageName = (ts as any).getPackageNameFromTypesPackageName(parsed.packageName) as string;
    const packageRoot = barePath.slice(0, idx + nm.length + parsed.packageName.length);
    const fileRel = normalizePackageJsonRelativePath(parsed.rest ?? "");

    let pj: any;
    try {
        const text = (ts as any).sys?.readFile?.(packageRoot + "/package.json");
        if (text) pj = JSON.parse(text);
    }
    catch {
        pj = undefined;
    }

    if (pj?.exports != null) {
        if (typeof pj.exports === "string") {
            if (!fileRel || normalizePackageJsonRelativePath(pj.exports) === fileRel) {
                return packageName;
            }
        }
        else if (typeof pj.exports === "object") {
            for (const key of Object.keys(pj.exports)) {
                if (key === "./package.json") continue;
                const targets: string[] = [];
                collectPackageExportTargets(pj.exports[key], targets);
                for (const t of targets) {
                    if (normalizePackageJsonRelativePath(t) !== fileRel) continue;
                    if (key === ".") return packageName;
                    if (key.startsWith("./")) return packageName + key.slice(1);
                }
            }
        }
    }
    for (const field of [pj?.types, pj?.typings, pj?.main, pj?.module]) {
        if (typeof field === "string" && normalizePackageJsonRelativePath(field) === fileRel) {
            return packageName;
        }
    }
    if (!fileRel || fileRel === "index") return packageName;
    return `${packageName}/${fileRel}`;
}

function tryRelativeModuleSpecifier(barePath: string, enclosing: any): string | undefined {
    const sf = enclosing?.kind === SyntaxKind.SourceFile
        ? enclosing
        : enclosing?.getSourceFile?.();
    const fromFile = sf?.fileName as string | undefined;
    if (!fromFile || typeof (ts as any).getRelativePathFromFile !== "function") return undefined;
    // Binder module names drop the extension; try the bare path first, then
    // common declaration suffixes so getRelativePathFromFile can resolve.
    const candidates = [barePath, barePath + ".ts", barePath + ".tsx", barePath + ".d.ts", barePath + ".js"];
    const getCanon = (f: string) => f;
    for (const to of candidates) {
        try {
            let rel = (ts as any).getRelativePathFromFile(fromFile, to, getCanon) as string;
            if (!rel) continue;
            rel = (ts as any).removeFileExtension?.(rel) ?? rel;
            if (typeof (ts as any).ensurePathIsNonModuleName === "function") {
                rel = (ts as any).ensurePathIsNonModuleName(rel);
            }
            if (rel && (rel.startsWith("./") || rel.startsWith("../"))) return rel;
        }
        catch {
            /* try next */
        }
    }
    return undefined;
}

/** Stock getSpecifierForModuleSymbol display form, or undefined to keep binder name. */
function moduleSymbolDisplaySpecifier(symbol: any, enclosing?: any): string | undefined {
    if (!enclosing || !isExternalModuleLikeSymbol(symbol)) return undefined;
    const escaped = externalModuleEscapedName(symbol);
    if (!isFilePathModuleName(escaped)) return undefined;
    const bare = stripQuotedModuleName(escaped).replace(/\\/g, "/");
    if (!bare) return undefined;
    const pkg = tryPackageSpecifierFromNodeModulesPath(bare);
    if (pkg) return `"${pkg}"`;
    const rel = tryRelativeModuleSpecifier(bare, enclosing);
    if (rel) return `"${rel}"`;
    return undefined;
}

/**
 * Stock checker.getSymbolAtLocation only resolves StringLiteral / template
 * literals to an external module in these contexts (JSDoc `@import` and
 * `require()` additionally require isInJSFile). Positional / host-bound
 * lookups that latch onto a file module at unrelated carets must stay empty
 * so quickinfo matches stock (`No content available.`).
 */
function isStockExternalModuleLookupNode(node: any): boolean {
    if (!node) return false;
    if (node.kind === SyntaxKind.SourceFile) return true;
    if (node.kind === SyntaxKind.ImportType) return true;
    if (node.parent?.kind === SyntaxKind.ModuleDeclaration && node.parent.name === node) {
        return true;
    }
    if (
        node.kind !== SyntaxKind.StringLiteral
        && node.kind !== SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
        return false;
    }
    const p = node.parent;
    if (!p) return false;
    if (p.kind === SyntaxKind.ExternalModuleReference && p.expression === node) return true;
    if (
        (p.kind === SyntaxKind.ImportDeclaration || p.kind === SyntaxKind.ExportDeclaration)
        && p.moduleSpecifier === node
    ) {
        return true;
    }
    if ((ts as any).isJSDocImportTag?.(p) && p.moduleSpecifier === node) {
        return !!(ts as any).isInJSFile?.(node);
    }
    if (p.kind === SyntaxKind.CallExpression) {
        const callee = p.expression;
        if (callee?.kind === SyntaxKind.ImportKeyword) return true;
        if (
            callee?.kind === SyntaxKind.Identifier
            && String(callee.escapedText ?? callee.text ?? "") === "require"
        ) {
            return !!(ts as any).isInJSFile?.(node);
        }
    }
    if (
        p.kind === SyntaxKind.LiteralType
        && p.parent?.kind === SyntaxKind.ImportType
        && p.parent.argument === p
    ) {
        return true;
    }
    return false;
}

function gateExternalModuleSymbolLookup(node: any, symbol: any): any {
    if (!symbol || !isExternalModuleLikeSymbol(symbol)) return symbol;
    return isStockExternalModuleLookupNode(node) ? symbol : undefined;
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

/** Own sealed `.parent` data property only — does not invoke lazy getters (no FFI). */
function symbolOwnSealedParent(symbol: any): any {
    if (!symbol) return undefined;
    const own = Object.getOwnPropertyDescriptor(symbol, "parent");
    if (!own || own.get || own.set) return undefined;
    const parent = own.value;
    return parent && typeof parent === "object" ? parent : undefined;
}

/** native-preview Symbol with a snapshot registry (wire id > 0). */
function isBridgeWireSymbol(symbol: any): boolean {
    return !!symbol
        && typeof symbol.id === "number"
        && symbol.id > 0
        && !!symbol.objectRegistry;
}

/** True when a bridge symbol's wire decls live in a host-bound (.vue) SF. */
function bridgeSymbolNeedsHostDeclRemap(
    symbol: any,
    getHostSf: (fileName: string) => any | undefined,
): boolean {
    if (!symbol || typeof symbol.hasDeclarationsResolved !== "function") return false;
    if (!symbol.hasDeclarationsResolved()) return false;
    let decls: any[] | undefined;
    try { decls = symbol.declarations as any[]; }
    catch { return false; }
    if (!decls?.length) return false;
    for (const d of decls) {
        const path = d?.path ?? d?.fileName;
        if (!path || typeof path !== "string") continue;
        try {
            const host = getHostSf(toHostFileName(path)) ?? getHostSf(path);
            if (host?.__tnbHostBound) return true;
        }
        catch { /* continue */ }
    }
    return false;
}

/** True when a wire decl path is lib / node_modules / bundled .d.ts only. */
function bridgeDeclPathIsLibOnly(path: string): boolean {
    const p = path.replace(/\\/g, "/");
    if (!p.endsWith(".d.ts")) return false;
    return p.includes("/node_modules/")
        || p.includes("bundled://")
        || p.includes("/lib.")
        || isBundledLibPath(p)
        || isHostLibFile(p);
}

/**
 * Completion Soft-P′ light-skip gate: only true when decls are resolved, live
 * entirely in lib/node_modules .d.ts, and need no host remap.
 *
 * Do NOT treat "not a .vue host-bound decl" as lib-only — project .ts symbols
 * (MyEvents in my-events.ts) would skip Soft-P′ while Alias import sites take
 * the full path, breaking FAR identity (xfile onlySTK at the defining .ts).
 * Unresolved decls must NOT skip — locals keep RemoteSourceFile decls and
 * symbolHasDeclarationInSourceFile (===) marks them GlobalsOrKeywords (15).
 */
function bridgeSymbolConfirmedLibOnlyNoHostRemap(
    symbol: any,
    getHostSf: (fileName: string) => any | undefined,
): boolean {
    if (!symbol || typeof symbol.hasDeclarationsResolved !== "function") return false;
    if (!symbol.hasDeclarationsResolved()) return false;
    if (bridgeSymbolNeedsHostDeclRemap(symbol, getHostSf)) return false;
    let decls: any[] | undefined;
    try { decls = symbol.declarations as any[]; }
    catch { return false; }
    if (!decls?.length) return false;
    for (const d of decls) {
        const path = d?.path ?? d?.fileName;
        if (!path || typeof path !== "string") return false;
        if (!bridgeDeclPathIsLibOnly(path) && !bridgeDeclPathIsLibOnly(toHostFileName(path))) {
            return false;
        }
    }
    return true;
}

/**
 * Batch-seal `.parent` for scope wire symbols that carry a real parentHandle.
 *
 * Three-state parent semantics (omitzero ≠ none):
 * 1. parentHandle > 0 and materializable → seal data property (no per-entry RPC).
 * 2. parentHandle omitted / 0 ("unfilled") → leave native-preview lazy getter;
 *    first read RPCs via fetchSymbol(getParentOfSymbol); proto memo caches the
 *    result (including confirmed undefined) until snapshot epoch bumps.
 * 3. Confirmed no parent (lazy RPC returned null) → memoized undefined; not
 *    sealed here (payload omission alone must not invent "no parent").
 */
function hydrateScopeSymbolParents(symbols: readonly any[]): void {
    if (!symbols?.length) return;
    let registry: any;
    const missingParentIds: number[] = [];
    const seen = new Set<number>();
    for (const sym of symbols) {
        if (!isBridgeWireSymbol(sym)) continue;
        if (!registry) registry = sym.objectRegistry;
        const own = Object.getOwnPropertyDescriptor(sym, "parent");
        if (own && !own.get && !own.set) continue;
        const ph = sym.parentHandle;
        if (typeof ph === "number" && ph !== 0) {
            if (registry?.getSymbol?.(ph)) continue;
            if (!seen.has(ph)) {
                seen.add(ph);
                missingParentIds.push(ph);
            }
        }
    }
    if (registry && missingParentIds.length && typeof registry.materializeSymbols === "function") {
        try { registry.materializeSymbols(missingParentIds); }
        catch { /* parent getter falls back to RPC */ }
    }
    const unfilled: any[] = [];
    for (const sym of symbols) {
        if (!isBridgeWireSymbol(sym)) continue;
        const own = Object.getOwnPropertyDescriptor(sym, "parent");
        if (own && !own.get && !own.set) continue;
        const ph = sym.parentHandle;
        // omitzero / missing handle: not "no parent" — batch-resolve below.
        if (typeof ph !== "number" || ph === 0) {
            if (
                !Object.prototype.hasOwnProperty.call(sym, "__tnbParentMemo")
                || sym.__tnbParentMemoPh !== ph
                || sym.__tnbParentMemoEpoch !== _tnbParentMemoEpoch
            ) {
                unfilled.push(sym);
            }
            continue;
        }
        const parent = registry?.getSymbol?.(ph);
        if (!parent) continue; // leave lazy getter
        try {
            Object.defineProperty(sym, "parent", { value: parent, configurable: true });
        }
        catch { /* read-only */ }
    }
    // Batch the "unfilled" remainder: each would otherwise pay one lazy
    // getParentOfSymbol RPC on first .parent read (completion's getSymbolKind
    // reads it for every entry — ~1k FFI round-trips per keystroke). The batch
    // reads the same sd.symbol.Parent the lazy path reads, so writing the
    // result (including confirmed "no parent") into the memo fields is
    // observationally identical, just one RPC.
    if (registry && unfilled.length && typeof registry.fetchParentsOfSymbols === "function") {
        try {
            const parents = registry.fetchParentsOfSymbols(unfilled.map(s => s.id));
            for (let i = 0; i < unfilled.length; i++) {
                const sym = unfilled[i];
                sym.__tnbParentMemo = parents[i];
                sym.__tnbParentMemoPh = sym.parentHandle;
                sym.__tnbParentMemoEpoch = _tnbParentMemoEpoch;
            }
        }
        catch { /* lazy getter fallback */ }
    }
}
/**
 * Stock symbolToString/writeSymbol include the accessible parent chain only
 * when an enclosingDeclaration is provided (node builder: chain is built iff
 * `context.enclosingDeclaration || UseFullyQualifiedType`) and
 * DoNotIncludeSymbolChain is not set. Quickinfo passes the source file →
 * "Indexed.prop" / "Color.Red"; renameInfo and fixAddMissingMember pass
 * nothing (or DoNotIncludeSymbolChain) → bare "Foo" / "Red". Skip
 * SourceFile / module containers — stock's node builder omits those for
 * property display. Enum parents ARE included for EnumMember (quickinfo
 * `(enum member) Color.Red = 1`); bare calls stay bare so
 * `createPropertyAccessExpression(enumExpr, symbolToString(member))` in
 * fixAddMissingMember does not become an illegal Identifier.
 */
// CheckFlags.Late — late-bound symbol for a computed property with a dynamic
// name. Identical bit (1<<12) in the fork and tsgo enums (ast/checkflags.go),
// so the raw bridge `symbol.checkFlags` can be tested directly.
const CHECKFLAGS_LATE_BIT = 1 << 12;

// Stock getNameOfSymbolAsWritten (checker.ts:11293-11310): for a symbol whose
// first named declaration has a ComputedPropertyName, the display name is the
// declaration's name TEXT (`[key]`) when the symbol is late-bound
// (CheckFlags.Late) or never received a usable literal name (escapedName
// `__computed`); binder-literal names (`["kk"]` → symbol "kk") keep the symbol
// name. The bridge otherwise reduces every name to the unescaped escapedName
// (`kk`), diverging from stock quickinfo `(property) [key]: T`. The gate
// (Late | __computed) keeps the host-declaration lookup off the hot path for
// ordinary symbols.
function symbolDisplayNameWithComputedDecl(symbol: any, getHostSf?: (fileName: string) => any | undefined): string {
    const fallback = symbolDisplayNameOf(symbol);
    if (!fallback || !getHostSf) return fallback;
    const rawName = String(symbol?.escapedName ?? symbol?.name ?? "");
    const lateLike = ((symbol?.checkFlags ?? 0) & CHECKFLAGS_LATE_BIT) !== 0 || rawName === "__computed";
    let decls: readonly any[];
    try {
        decls = symbol?.declarations;
    }
    catch {
        return fallback;
    }
    if (!decls?.length) return fallback;
    for (const decl of decls) {
        const hostDecl = remapDeclarationToHost(decl, getHostSf);
        const name = hostDecl ? (ts as any).getNameOfDeclaration?.(hostDecl) : undefined;
        if (!name) continue;
        if (lateLike) {
            return (ts as any).isComputedPropertyName?.(name)
                ? ((ts as any).declarationNameToString?.(name) ?? fallback)
                : fallback;
        }
        // Stock getNameOfSymbolAsWritten: a name written as a string/template
        // literal prints as-written (quotes included) — 'data-test-id', 'foo',
        // "onUpdate:modelValue". Bridge printed the bare unescaped name.
        if ((ts as any).isStringLiteral?.(name) || (ts as any).isNoSubstitutionTemplateLiteral?.(name)) {
            return (ts as any).declarationNameToString?.(name) ?? fallback;
        }
        return fallback;
    }
    return fallback;
}

function symbolToStringWithChain(symbol: any, enclosing?: any, flags?: number, getHostSf?: (fileName: string) => any | undefined): string {
    // With enclosingDeclaration, stock's node builder remaps file-path module
    // symbols to package/relative specifiers (QI: module "vue"); without it
    // (and FQN) the absolute binder name is preserved.
    if (enclosing) {
        const moduleDisplay = moduleSymbolDisplaySpecifier(symbol, enclosing);
        if (moduleDisplay) return moduleDisplay;
    }
    const name = symbolDisplayNameWithComputedDecl(symbol, getHostSf);
    if (!name) return "";
    if (!enclosing) {
        return name;
    }
    if (flags != null && (flags & SymbolFormatFlags.DoNotIncludeSymbolChain)) {
        return name;
    }
    // EnumMember is not Property-flagged; include it so enclosing quickinfo
    // can form `Color.Red`. Module parents stay omitted below.
    const propertyLike = SymbolFlags.Property | SymbolFlags.Method | SymbolFlags.Accessor
        | SymbolFlags.GetAccessor | SymbolFlags.SetAccessor | SymbolFlags.EnumMember;
    if (!((symbol.flags ?? 0) & propertyLike)) {
        return name;
    }
    const parent = symbolParentOf(symbol);
    if (!parent) return name;
    // Module/source-file parents: stock omits them for property FQN display.
    // Enum parents are kept for EnumMember (see above).
    if (parent.flags & (SymbolFlags.Module | SymbolFlags.ValueModule | SymbolFlags.NamespaceModule)) {
        return name;
    }
    const parentName = symbolDisplayNameOf(parent);
    if (!parentName || parentName.startsWith('"') || parentName.startsWith("'")) {
        return name;
    }
    // Internal container names (__object, __type, ...) are excluded from the
    // stock symbol chain (rename displayName is bare "aaaBbb"); only
    // getFullyQualifiedName includes them. Same "__"-not-"___" shape test as
    // isReservedExportMemberName.
    if (isReservedExportMemberName(parentName)) {
        return name;
    }
    return `${parentName}.${name}`;
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
    // getSymbolModifiers). Host-bound files always go through bindSourceFile,
    // so the statement's symbol is present whenever the statement exists.
    return findHostExportDefaultStatement(sf)?.symbol;
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
function findHostExportDefaultStatement(sf: any): any | undefined {
    if (!sf?.__tnbHostBound) return undefined;
    for (const stmt of sf.statements ?? []) {
        if (stmt.kind === SyntaxKind.ExportAssignment && !stmt.isExportEquals) {
            return stmt;
        }
    }
    return undefined;
}
/** tsgo module default-export member symbols → host bindSourceFile default-export symbol. */
function resolveHostExportDefaultSymbol(symbol: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!symbol) return symbol;
    // Note: module symbols themselves (declarations = [SourceFile]) are NOT
    // redirected here — stock getSymbolAtLocation on a module specifier returns
    // the module symbol, and its SourceFile declaration produces the whole-file
    // definition span that downstream mappers rely on. Only degenerate
    // default-export *member* symbols (tsgo RPC loses their declaration chain)
    // are re-anchored to the host binder's ExportAssignment symbol.
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
/** True when SF was host-parsed + binder-run (overlay brand or Soft-P′ soft-bind). */
function isHostParsedSourceFile(sf: any): boolean {
    return !!(sf && (sf.__tnbHostBound || sf.__tnbSoftBound));
}
function declarationNeedsHostRemap(decl: any): boolean {
    const sf = decl?.getSourceFile?.();
    // Soft-P′ soft-bound disk files are already host AST — no remap needed.
    return !!(sf && !isHostParsedSourceFile(sf));
}
/** Deepest host-parsed AST node containing `pos` (Language Service snapshot coords). */
function findHostNodeAtPosition(sf: any, pos: number): any | undefined {
    if (!isHostParsedSourceFile(sf) || typeof pos !== "number") return undefined;
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
    if (!isHostParsedSourceFile(hostSf) || !remoteSf || typeof pos !== "number") return undefined;
    try {
        const { line, character } = remoteSf.getLineAndCharacterOfPosition(pos);
        const hostPos = hostSf.getPositionOfLineAndCharacter(line, character);
        return findHostNodeAtPosition(hostSf, hostPos);
    } catch {
        return undefined;
    }
}
function findHostModuleScopedDeclaration(hostSf: any, escapedName: string): any | undefined {
    if (!isHostParsedSourceFile(hostSf) || !escapedName) return undefined;
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
 * Stock checker.copyLocallyVisibleExportSymbols: module exports are not all
 * in-scope identifiers. Exclude `default` and re-export aliases so the
 * `default` keyword completion (sortText 15) is not displaced by the module's
 * default-export symbol (property/export, sortText 11) — vue-script-global
 * completion parity witness.
 */
function isLocallyInvisibleModuleExportSymbol(symbol: any): boolean {
    // Used only while copying a module's exports table (stock
    // copyLocallyVisibleExportSymbols). Name `default` is always excluded
    // here — members of interfaces/classes go through copySymbols instead.
    const name = symbol?.escapedName ?? symbol?.name;
    if (name === "default") return true;
    for (const d of symbol?.declarations ?? []) {
        if (d?.kind === SyntaxKind.ExportSpecifier || d?.kind === SyntaxKind.NamespaceExport) {
            return true;
        }
    }
    return false;
}
/**
 * Post-filter for getSymbolsInScope results (tsgo+Soft-P′ may still surface
 * the module default-export symbol). Stock copyLocallyVisibleExportSymbols
 * excludes escapedName === InternalSymbolName.Default unconditionally.
 *
 * Wire scope symbols often arrive with parentHandle omitted/0 (unfilled). After
 * hydrate leaves the lazy getter, `.parent` may still be unresolved until first
 * read; a Module-parent-only filter misses that window and the `default`
 * keyword completion (sortText 15) is displaced by property/export (sortText 11)
 * — vue-script-global parity witness. Only keep a "default" member when its
 * parent is a class/interface/type/object container (those appear via
 * copySymbols(members) inside the type body, not as module exports).
 */
function isStolenDefaultKeywordScopeSymbol(symbol: any): boolean {
    for (const d of symbol?.declarations ?? []) {
        if (
            d?.kind === SyntaxKind.ExportSpecifier
            || d?.kind === SyntaxKind.NamespaceExport
            || d?.kind === SyntaxKind.ExportAssignment
        ) {
            return true;
        }
    }
    const name = symbol?.escapedName ?? symbol?.name;
    if (name !== "default") return false;
    const parentFlags = symbol?.parent?.flags ?? 0;
    // Member-container parents: keep (rare `default` property name).
    const memberContainer = SymbolFlags.Class | SymbolFlags.Interface
        | SymbolFlags.TypeLiteral | SymbolFlags.ObjectLiteral;
    if (parentFlags & memberContainer) return false;
    // Module parent, missing parent (wire-stripped), or any other case:
    // treat as module default export — exclude so the keyword wins.
    return true;
}
function copyLocallyVisibleExportSymbolsFromTable(table: any, meaning: number, out: Map<string, any>): void {
    if (!table || !meaning) return;
    const add = (sym: any) => {
        if (isLocallyInvisibleModuleExportSymbol(sym)) return;
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
 * bindSourceFile locals/exports walk for genuine host-only virtual files
 * (__tnbHostBound with no tsgo mirror). Real project files that are host-bound
 * for LS token walks still use the getSymbolsInScope RPC (globals via tsgo).
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
                    // Stock: meaning & ModuleMember + copyLocallyVisibleExportSymbols.
                    copyLocallyVisibleExportSymbolsFromTable(
                        sf.symbol?.exports,
                        meaning & SymbolFlags.ModuleMember,
                        symbols,
                    );
                }
                break;
            }
            case SyntaxKind.ModuleDeclaration:
                copyLocallyVisibleExportSymbolsFromTable(
                    node.symbol?.exports,
                    meaning & SymbolFlags.ModuleMember,
                    symbols,
                );
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
/** tsgo getSymbolsInScope can miss host-bound import bindings (e.g. type-only namespace aliases). */
function mergeHostLocalScopeSymbols(tsgoSymbols: any[], location: any, meaning: number): any[] {
    const sf = location?.getSourceFile?.();
    // Soft-P′ disk files use __tnbSoftBound; overlays use __tnbHostBound. Both are
    // host-parsed so declaration identity (=== sourceFile) must prefer host.
    if (!isHostParsedSourceFile(sf)) return tsgoSymbols;
    // getHostSymbolsInScope currently gates on __tnbHostBound; for soft-bound SFs
    // walk locals via the same binder tables when present.
    let hostLocals = getHostSymbolsInScope(location, meaning);
    if (!hostLocals.length && sf.__tnbSoftBound) {
        hostLocals = getHostSymbolsInScopeSoft(location, meaning);
    }
    if (!hostLocals.length) return tsgoSymbols;
    const hostLocalByName = new Map<string, any>();
    for (const sym of hostLocals) {
        const id = sym.escapedName ?? sym.name;
        if (!id) continue;
        const decls = sym.declarations ?? (sym.valueDeclaration ? [sym.valueDeclaration] : undefined);
        if (!decls?.some((d: any) => d.getSourceFile?.() === sf)) continue;
        hostLocalByName.set(String(id), sym);
    }
    if (!hostLocalByName.size) return tsgoSymbols;
    const seen = new Set<string>();
    const merged: any[] = [];
    // Prefer host binder identity for file-locals so stock
    // symbolHasDeclarationInSourceFile (===) assigns LocationPriority sortText.
    for (const sym of tsgoSymbols) {
        const id = sym.escapedName ?? sym.name;
        const key = id ? String(id) : "";
        const host = key ? hostLocalByName.get(key) : undefined;
        if (host) {
            if (!seen.has(key)) {
                merged.push(host);
                seen.add(key);
            }
            continue;
        }
        merged.push(sym);
        if (key) seen.add(key);
    }
    for (const [key, sym] of hostLocalByName) {
        if (seen.has(key)) continue;
        merged.unshift(sym);
        seen.add(key);
    }
    return merged;
}

/** Soft-bound SF local walk (same as host-bound, without __tnbHostBound gate). */
function getHostSymbolsInScopeSoft(location: any, meaning: number): any[] {
    const sf = location?.getSourceFile?.();
    if (!isHostParsedSourceFile(sf)) return [];
    if (location.flags & NodeFlags.InWithStatement) return [];
    const symbols = new Map<string, any>();
    let node = location;
    while (node) {
        if (node.locals) {
            copyScopeSymbolsFromTable(node.locals, meaning, symbols);
        }
        switch (node.kind) {
            case SyntaxKind.SourceFile: {
                if (sf.externalModuleIndicator || sf.commonJsModuleIndicator) {
                    copyLocallyVisibleExportSymbolsFromTable(
                        sf.symbol?.exports,
                        meaning & SymbolFlags.ModuleMember,
                        symbols,
                    );
                }
                break;
            }
            case SyntaxKind.ModuleDeclaration:
                copyLocallyVisibleExportSymbolsFromTable(
                    node.symbol?.exports,
                    meaning & SymbolFlags.ModuleMember,
                    symbols,
                );
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
    // findHostNodeAtPosition returns the deepest node at pos. A declaration
    // whose getStart lands on a leading modifier resolves to that keyword
    // token (`export class C` → ExportKeyword), not the declaration. Climb to
    // the enclosing ancestor of the same kind as the remote declaration.
    // decl.kind is normalized to fork SyntaxKind by the RemoteNode hooks, but
    // accept the raw tsgo kind remap too in case a handle escaped them.
    const wantKind = decl.kind;
    const wantKindAlt = remapKind(decl.kind);
    if (hostNode.kind !== wantKind && hostNode.kind !== wantKindAlt) {
        for (let anc = hostNode.parent; anc && anc.kind !== SyntaxKind.SourceFile; anc = anc.parent) {
            if (anc.kind === wantKind || anc.kind === wantKindAlt) {
                hostNode = anc;
                break;
            }
        }
    }
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
/**
 * True for external-module symbols: stock `isExternalModuleSymbol` requires
 * Module flags and an escapedName that starts with `"`.
 */
function isExternalModuleLikeSymbol(sym: any): boolean {
    if (!sym || !((sym.flags ?? 0) & SymbolFlags.Module)) return false;
    const name = String(sym.escapedName ?? sym.name ?? "");
    return name.length > 0 && name.charCodeAt(0) === 0x22; /* " */
}

function hostModuleSymbolFromSourceFileName(
    fileName: string | undefined,
    getHostSf: (fileName: string) => any | undefined,
): any | undefined {
    if (!fileName) return undefined;
    const hostSf = getHostSf(fileName);
    if (hostSf?.symbol && isExternalModuleLikeSymbol(hostSf.symbol)) return hostSf.symbol;
    return undefined;
}

/**
 * Climb to an enclosing `declare module "X"` / augmentation. Ambient exports
 * (e.g. `GlobalComponents` under `"vue"`) must parent to that module — not
 * the containing SourceFile's file-path module.
 */
function enclosingStringAmbientModuleSymbol(node: any): any | undefined {
    for (let cur = node; cur; cur = cur.parent) {
        if (cur.kind === SyntaxKind.ModuleDeclaration) {
            const name = cur.name;
            if (name && name.kind === SyntaxKind.StringLiteral) {
                const modSym = cur.symbol;
                if (modSym && isExternalModuleLikeSymbol(modSym)) return modSym;
                // Binder may lag; synthesize nothing — fall through to file.
                if (modSym) return modSym;
            }
        }
        if (cur.kind === SyntaxKind.SourceFile) break;
    }
    return undefined;
}

function externalModuleEscapedName(sym: any): string {
    return String(sym?.escapedName ?? sym?.name ?? "");
}

/** True when two external-module symbols name the same logical module. */
function sameExternalModuleIdentity(a: any, b: any): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.id != null && b.id != null && a.id === b.id) return true;
    const an = externalModuleEscapedName(a);
    const bn = externalModuleEscapedName(b);
    return an.length > 0 && an === bn;
}

/** Top-level `declare module "X"` scan; statements decode without a parent climb. */
function sourceFileStatementsHaveStringAmbientModule(sf: any): boolean {
    try {
        for (const s of sf?.statements ?? []) {
            if (s?.kind === SyntaxKind.ModuleDeclaration && s.name?.kind === SyntaxKind.StringLiteral) return true;
        }
        return false;
    }
    catch { return true; } // fail open — keep the climb
}
// "File contains a string ambient module" memo. node_modules declarations are
// path-keyed (content-stable in a session; MiniSourceFileCache reuses their
// decoded objects on the same assumption). Everything else keys on the
// SourceFile object so edited project files can never serve a stale flag.
const _stringAmbientByPath = new Map<string, boolean>();
const _stringAmbientBySf = new WeakMap<object, boolean>();

/**
 * Resolve the exporting module's host symbol from a symbol's declarations.
 * Prefer enclosing string ambient modules over the containing SourceFile
 * (augmentation parents are `"vue"`, not `"…/fixture.vue"`). Falls back to
 * escapedName path forms for bare module symbols whose declarations are remote.
 */
function resolveHostExternalModuleSymbol(
    symbol: any,
    getHostSf: (fileName: string) => any | undefined,
): any | undefined {
    if (!symbol) return undefined;
    try {
        const decls: readonly any[] | undefined = symbol.declarations;
        if (decls?.length) {
            for (const d of decls) {
                // Bridge NodeHandles carry their file path on the wire. Use it
                // to gate the remote work: resolving a remote node's SourceFile
                // or climbing .parent decodes ancestor nodes one by one, and
                // refineNavSymbol funnels ~2k scope symbols through here per
                // completion keystroke.
                const wireRaw = d?.kind !== SyntaxKind.SourceFile ? (d?.path ?? d?.fileName) : undefined;
                if (typeof wireRaw === "string" && wireRaw.length) {
                    const wirePath = toHostFileName(wireRaw);
                    if (isHostLibFile(wirePath) || isBundledLibPath(wirePath) || wireRaw.includes("bundled://")) {
                        // Default-lib declaration: default libs contain no
                        // string ambient modules and are never host-parsed.
                        continue;
                    }
                    const isNm = wirePath.includes("/node_modules/");
                    let sfLazy: any;
                    let hasAmbient = isNm ? _stringAmbientByPath.get(wirePath) : undefined;
                    if (hasAmbient === undefined) {
                        sfLazy = d?.getSourceFile?.();
                        if (!isNm && sfLazy) hasAmbient = _stringAmbientBySf.get(sfLazy);
                        if (hasAmbient === undefined) {
                            hasAmbient = sfLazy ? sourceFileStatementsHaveStringAmbientModule(sfLazy) : true;
                            if (sfLazy) {
                                if (isNm) _stringAmbientByPath.set(wirePath, hasAmbient);
                                else _stringAmbientBySf.set(sfLazy, hasAmbient);
                            }
                        }
                    }
                    if (hasAmbient) {
                        const ambient = enclosingStringAmbientModuleSymbol(d);
                        if (ambient && isExternalModuleLikeSymbol(ambient)) return ambient;
                    }
                    // Host lookup must use the SourceFile's own fileName: the
                    // wire path is a canonical (lowercased on case-insensitive
                    // hosts) tsgo path, which misses the host's script table
                    // and re-parses the file under a duplicate identity.
                    sfLazy ??= d?.getSourceFile?.();
                    const hostMod = hostModuleSymbolFromSourceFileName(sfLazy?.fileName, getHostSf);
                    if (hostMod) return hostMod;
                    if (sfLazy?.symbol && isExternalModuleLikeSymbol(sfLazy.symbol)) return sfLazy.symbol;
                    continue;
                }
                const ambient = enclosingStringAmbientModuleSymbol(d);
                if (ambient && isExternalModuleLikeSymbol(ambient)) return ambient;
                const sf = d?.kind === SyntaxKind.SourceFile ? d : d?.getSourceFile?.();
                const hostMod = hostModuleSymbolFromSourceFileName(sf?.fileName, getHostSf);
                if (hostMod) return hostMod;
                if (sf?.symbol && isExternalModuleLikeSymbol(sf.symbol)) return sf.symbol;
            }
        }
    }
    catch { /* best-effort */ }
    if (isExternalModuleLikeSymbol(symbol)) {
        const raw = String(symbol.escapedName ?? symbol.name ?? "");
        if (raw.length >= 2 && raw.charCodeAt(0) === 0x22 && raw.charCodeAt(raw.length - 1) === 0x22) {
            const bare = raw.slice(1, -1);
            // Package / ambient names (`"vue"`) are not disk paths — do not
            // invent host file modules for them.
            if (!bare.includes("/") && !bare.includes("\\") && !/\.(ts|tsx|js|jsx|mts|cts|d\.ts)$/.test(bare)) {
                return undefined;
            }
            for (const candidate of [bare, bare + ".ts", bare + ".tsx", bare + ".d.ts", bare + ".js", bare + ".jsx"]) {
                const hostMod = hostModuleSymbolFromSourceFileName(candidate, getHostSf);
                if (hostMod) return hostMod;
            }
        }
    }
    return undefined;
}

/**
 * True when a declaration is itself an export form or carries the Export
 * modifier — stock `getImportOrExportSymbol` uses the same signals.
 */
function declarationHasExportModifier(decl: any): boolean {
    if (!decl) return false;
    const kind = decl.kind;
    if (
        kind === SyntaxKind.ExportSpecifier
        || kind === SyntaxKind.ExportAssignment
        || kind === SyntaxKind.NamespaceExport
        || kind === SyntaxKind.ExportDeclaration
    ) {
        return true;
    }
    try {
        if (typeof (ts as any).hasSyntacticModifier === "function"
            && (ts as any).hasSyntacticModifier(decl, ModifierFlags.Export)) {
            return true;
        }
    }
    catch { /* best-effort */ }
    const mods = decl.modifiers;
    if (mods) {
        for (const m of mods) {
            if (m.kind === SyntaxKind.ExportKeyword) return true;
        }
    }
    const cached = decl.modifierFlagsCache;
    if (typeof cached === "number" && (cached & ModifierFlags.Export)) return true;
    return false;
}

/** True when `symbol` is the (or the local side of the) export named in `moduleSym.exports`. */
function symbolIsInModuleExportsTable(moduleSym: any, symbol: any): boolean {
    if (!moduleSym?.exports || !symbol) return false;
    const key = symbol.escapedName ?? symbol.name;
    if (key == null || key === "") return false;
    let entry: any;
    try {
        entry = typeof moduleSym.exports.get === "function" ? moduleSym.exports.get(key) : undefined;
    }
    catch { return false; }
    if (!entry) return false;
    if (entry === symbol) return true;
    const es = symbol.exportSymbol;
    if (es && typeof es === "object" && es === entry) return true;
    if (entry.exportSymbol === symbol) return true;
    if (entry.id != null && symbol.id != null && entry.id === symbol.id) return true;
    return false;
}

/**
 * Narrowed S′ gate: only module exports get parent forced to the external
 * module symbol. Properties / locals keep stock parents (`__type`, `__object`,
 * class/interface containers) so rename fullDisplayName stays correct.
 */
function isModuleExportForParentRewrite(symbol: any, moduleSym: any | undefined): boolean {
    const es = symbol.exportSymbol;
    if (es && typeof es === "object") return true;
    for (const decl of symbol.declarations ?? []) {
        if (declarationHasExportModifier(decl)) return true;
    }
    if (moduleSym && symbolIsInModuleExportsTable(moduleSym, symbol)) return true;
    return false;
}

/**
 * Package / ambient module names (`"vue"`) vs file-path modules
 * (`"…/fixture.vue"`). Used to allow correcting mistaken Soft-P′ parents for
 * `declare module` augmentations without permitting the reverse rewrite.
 */
function isPackageAmbientModuleName(escaped: string): boolean {
    if (escaped.length < 3 || escaped.charCodeAt(0) !== 0x22 /* " */) return false;
    const bare = escaped.charCodeAt(escaped.length - 1) === 0x22
        ? escaped.slice(1, -1)
        : escaped.slice(1);
    return !!bare && !bare.includes("/") && !bare.includes("\\")
        && !/\.(ts|tsx|js|jsx|mts|cts|d\.ts|vue)$/i.test(bare);
}

function isFilePathModuleName(escaped: string): boolean {
    if (!escaped) return false;
    const bare = escaped.charCodeAt(0) === 0x22 && escaped.charCodeAt(escaped.length - 1) === 0x22
        ? escaped.slice(1, -1)
        : escaped;
    return bare.includes("/") || bare.includes("\\")
        || /\.(ts|tsx|js|jsx|mts|cts|d\.ts|vue)$/i.test(bare);
}

/**
 * May we set `symbol.parent = moduleSym`?
 * - Non-module parents (`__type` / `__object` / class / interface): never.
 * - Existing external-module parent: only same-identity host canonicalize
 *   (`"vue"` must not become `"…/fixture.vue"`), except correcting a file-path
 *   parent up to an enclosing package ambient (`GlobalComponents` under
 *   `declare module 'vue'`).
 * - Otherwise only true module exports (see isModuleExportForParentRewrite).
 */
function mayRewriteSymbolParentToModule(symbol: any, moduleSym: any): boolean {
    if (!moduleSym || !isModuleExportForParentRewrite(symbol, moduleSym)) return false;
    const parent = symbolOwnSealedParent(symbol);
    if (parent && typeof parent === "object") {
        if (!isExternalModuleLikeSymbol(parent)) return false;
        if (!sameExternalModuleIdentity(parent, moduleSym)) {
            // Augmentation exports must parent to `"vue"`, not the host .vue SF
            // module. Soft-P′ / bind order sometimes stamps the file module first.
            if (
                !(
                    isPackageAmbientModuleName(externalModuleEscapedName(moduleSym))
                    && isFilePathModuleName(externalModuleEscapedName(parent))
                )
            ) {
                return false;
            }
        }
    }
    return true;
}

/**
 * S′: restore stock invariants that `importTracker.getExportInfo` / FAR
 * `searchForImportsOfExport` rely on:
 * - `symbol.exportSymbol` must be an object or undefined (NOT a numeric wire handle —
 *   a truthy number makes getImportOrExportSymbol call getExportInfo(number) → fail).
 * - exported symbol's `.parent` must be the external module symbol, and that
 *   identity must match `getSymbolAtLocation(moduleSpecifier)` (prefer host `sf.symbol`).
 * Parent rewrite is gated: only true module exports; never overwrite non-module
 * containers; never replace an ambient module parent with a different module.
 */
function ensureExportedSymbolModuleParent(
    symbol: any,
    getHostSf: (fileName: string) => any | undefined,
): any {
    if (!symbol) return symbol;

    // Numeric wire handle: resolve via getExportSymbol() or clear so stock
    // falls through to the hasSyntacticModifier(Export) path on `symbol` itself.
    const rawExport = symbol.exportSymbol;
    if (typeof rawExport === "number") {
        let resolved: any;
        try {
            if (typeof symbol.getExportSymbol === "function") resolved = symbol.getExportSymbol();
        }
        catch { resolved = undefined; }
        const value = resolved && typeof resolved === "object" ? resolved : undefined;
        // Class-field `exportSymbol: number` must be deleted before redefine;
        // a failed defineProperty leaves a truthy number and S′ stays broken.
        try { delete (symbol as any).exportSymbol; } catch { /* best-effort */ }
        try {
            Object.defineProperty(symbol, "exportSymbol", {
                value,
                configurable: true,
                enumerable: true,
                writable: true,
            });
        }
        catch {
            try { symbol.exportSymbol = value; } catch { /* read-only */ }
        }
        // If the field is still a number, S′ wiring cannot help this symbol —
        // callers should prefer host binder identity when available.
        if (typeof symbol.exportSymbol === "number") {
            if (_traceSymEnabled) {
                traceSym(`ensureExportedSymbolModuleParent exportSymbol-still-number id=${symbol.id}`);
            }
        }
    }

    const exportSymObj = (() => {
        const es = symbol.exportSymbol;
        return es && typeof es === "object" ? es : undefined;
    })();

    let moduleSym =
        resolveHostExternalModuleSymbol(symbol, getHostSf)
        ?? resolveHostExternalModuleSymbol(exportSymObj, getHostSf);
    if (!moduleSym) {
        const parent = symbolOwnSealedParent(symbol) ?? (exportSymObj ? symbolOwnSealedParent(exportSymObj) : undefined);
        if (parent && isExternalModuleLikeSymbol(parent)) {
            moduleSym = resolveHostExternalModuleSymbol(parent, getHostSf) ?? parent;
        }
    }

    if (moduleSym && mayRewriteSymbolParentToModule(symbol, moduleSym)) {
        try {
            Object.defineProperty(symbol, "parent", { value: moduleSym, configurable: true });
        }
        catch { /* best-effort */ }
        if (exportSymObj && mayRewriteSymbolParentToModule(exportSymObj, moduleSym)) {
            try {
                Object.defineProperty(exportSymObj, "parent", { value: moduleSym, configurable: true });
            }
            catch { /* best-effort */ }
        }
    }

    // Module symbols themselves (module-specifier lookups): canonicalize to
    // host sf.symbol so getSymbolId matches exportSymbol.parent. Ambient /
    // package names must not be remapped onto an unrelated file module.
    if (isExternalModuleLikeSymbol(symbol)) {
        const hostMod = resolveHostExternalModuleSymbol(symbol, getHostSf);
        if (hostMod && hostMod !== symbol && sameExternalModuleIdentity(symbol, hostMod)) {
            return hostMod;
        }
    }

    return symbol;
}

function refineHostNavigationSymbol(symbol: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!symbol) return symbol;
    let refined = resolveHostExportDefaultSymbol(symbol, getHostSf);
    refined = remapSymbolDeclarationsToHost(refined, getHostSf);
    refined = canonicalizeSymbolToHostIdentity(refined, getHostSf);
    refined = ensureExportedSymbolModuleParent(refined, getHostSf);
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
            case SyntaxKind.InterfaceDeclaration:
            case SyntaxKind.TypeAliasDeclaration:
            case SyntaxKind.EnumDeclaration:
            case SyntaxKind.ModuleDeclaration:
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
    // Stock checker.getSymbolAtLocation: after declaration-name handling
    // (parent.name === node above ≈ isDeclarationNameOrImportPropertyName),
    // the switch only resolves EntityName / this / super / meta / jsx-ns
    // shapes; default → undefined. Unconditionally returning node.symbol
    // here falsely surfaces binder symbols on TypeLiteral (__type) and
    // VariableDeclaration (binding) when the caret sits past `]` — stock
    // quickinfo stays empty, TNB reported success. Gate on the same shapes
    // stock's switch enters; everything else lets cache/RPC decide.
    switch (node.kind) {
        case SyntaxKind.Identifier:
        case SyntaxKind.PrivateIdentifier:
        case SyntaxKind.PropertyAccessExpression:
        case SyntaxKind.QualifiedName:
        case SyntaxKind.ThisKeyword:
        case SyntaxKind.SuperKeyword:
        case SyntaxKind.ThisType:
        case SyntaxKind.MetaProperty:
        case SyntaxKind.JsxNamespacedName:
            return ensureSymbolContextualDocCompat(node.symbol);
        default:
            return undefined;
    }
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
let _tsgoEnums: { SyntaxKind: any; NodeFlags: any; ObjectFlags: any; SignatureFlags: any } | undefined;
function loadTsgoEnums(): { SyntaxKind: any; NodeFlags: any; ObjectFlags: any; SignatureFlags: any } {
    if (_tsgoEnums) return _tsgoEnums;
    const path = require("path") as typeof import("path");
    const enumsDir = path.join(getNativePreviewDir(), "dist", "enums");
    const load = (file: string, name: string) => require(path.join(enumsDir, file))[name];
    _tsgoEnums = {
        SyntaxKind: load("syntaxKind.js", "SyntaxKind"),
        NodeFlags: load("nodeFlags.js", "NodeFlags"),
        ObjectFlags: load("objectFlags.js", "ObjectFlags"),
        SignatureFlags: load("signatureFlags.js", "SignatureFlags"),
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

// ── SignatureFlags remap (tsgo bit layout → fork bit layout), by member name ──
// tsgo inserts a Construct bit (1<<2) the fork does not have (construct-ness
// lives in SignatureKind there), shifting Abstract (tsgo 1<<3 vs fork 1<<2)
// and every bit above it. vendor Signature.flags carries the RAW tsgo layout
// (constructor: `this.flags = data.flags`), but fork services read it against
// the FORK enum — symbolDisplay.ts prints `abstract` for alias construct
// signatures when `signature.flags & SignatureFlags.Abstract` (fork 1<<2) is
// set, which the tsgo Construct bit lights up on every construct signature.
// buildFlagPairsByName drops the tsgo-only Construct bit and lands each named
// bit on its fork home.
let _signatureFlagsPairs: ReadonlyArray<readonly [number, number]> | undefined;
const _signatureFlagsRemapCache = new Map<number, number>();

function signatureFlagsPairs(): ReadonlyArray<readonly [number, number]> {
    if (!_signatureFlagsPairs) {
        const tsgo = loadTsgoEnums();
        _signatureFlagsPairs = buildFlagPairsByName(tsgo.SignatureFlags, (ts as any).SignatureFlags);
    }
    return _signatureFlagsPairs;
}

function remapSignatureFlags(tsgoFlags: number): number {
    if (!tsgoFlags) return 0;
    const cached = _signatureFlagsRemapCache.get(tsgoFlags);
    if (cached !== undefined) return cached;
    const out = remapFlagsByPairs(tsgoFlags, signatureFlagsPairs());
    _signatureFlagsRemapCache.set(tsgoFlags, out);
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
                // RemoteNode.forEachChild stops when the visitor returns truthy;
                // Array.push does, so token walks must not return push's length.
                this.forEachChild((child: any) => { children.push(child); });
                return children;
            };
        }
        if (typeof RemoteNode.prototype.getFirstToken !== "function") {
            RemoteNode.prototype.getFirstToken = function (this: any, sourceFile?: any) {
                const children = this.getChildren(sourceFile);
                if (!children.length) return undefined;
                for (const child of children) {
                    if (child.kind < SyntaxKind.FirstJSDocNode || child.kind > SyntaxKind.LastJSDocNode) {
                        return child.kind < SyntaxKind.FirstNode
                            ? child
                            : child.getFirstToken?.(sourceFile);
                    }
                }
                return undefined;
            };
        }
        if (typeof RemoteNode.prototype.getLastToken !== "function") {
            RemoteNode.prototype.getLastToken = function (this: any, sourceFile?: any) {
                const children = this.getChildren(sourceFile);
                const child = children[children.length - 1];
                if (!child) return undefined;
                return child.kind < SyntaxKind.FirstNode
                    ? child
                    : child.getLastToken?.(sourceFile);
            };
        }
        if (typeof RemoteNode.prototype.getChildCount !== "function") {
            RemoteNode.prototype.getChildCount = function (this: any, sourceFile?: any) {
                return this.getChildren(sourceFile).length;
            };
        }
        // tsgo names TypeParameterDeclaration's default `defaultType` (`default`
        // is a Go keyword); stock consumers read `.default` (emitter's
        // emitTypeParameter prints `= D`, services read it for defaults).
        // Alias it at the boundary so decoded nodes keep the stock shape.
        if (!Object.getOwnPropertyDescriptor(RemoteNode.prototype, "default")) {
            Object.defineProperty(RemoteNode.prototype, "default", {
                configurable: true,
                get(this: any) { return this.defaultType; },
            });
        }
        // Boundary invariant: file names visible to JS consumers are host
        // paths. RemoteSourceFile.fileName reads the wire string, which is
        // bundled:///libs/lib.*.d.ts for tsgo's embedded libs — leaking that
        // into e.g. DefinitionInfo.fileName crashes tsserver span mapping
        // (goto definition on lib members). NodeHandle.getSourceFile() already
        // resolves to host names; align the decoded-node path. RPC identity is
        // unaffected: node ids embed sourceFile.path (raw wire path), and
        // tsgo-facing lookups renormalize via toTsgoFileName.
        const RemoteSourceFile = nodeModule.RemoteSourceFile;
        const fileNameDesc = RemoteSourceFile?.prototype
            && Object.getOwnPropertyDescriptor(RemoteSourceFile.prototype, "fileName");
        if (fileNameDesc?.get) {
            const rawGet = fileNameDesc.get;
            Object.defineProperty(RemoteSourceFile.prototype, "fileName", {
                configurable: true,
                get(this: any) { return toHostFileName(rawGet.call(this)); },
            });
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
    const _tp0 = _rpcTraceLog ? Date.now() : 0;
    let configFilePath = options.configFilePath as string;
    if (!configFilePath) {
        throw new Error("createTsgoProgram: options.configFilePath is required");
    }
    configFilePath = resolveTsconfigPath(configFilePath, host);
    options.configFilePath = configFilePath;
    const configDiags = configFileParsingDiagnostics ?? [];

    // Bridge initialize() sets _tsgoUseCaseSensitive before any path below is canonicalized.
    ensureBridgeSession();
    if (_tp0) _rpcTraceEvent("thinProgram.t", `afterEnsureBridge ms=${Date.now()-_tp0}`);

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
    // Soft-P′ FAR needs real `SourceFile.imports` for every program file, but that
    // full materialization must be gated to tsserver (projectService). PreferHost
    // alone also covers vue-tsc overlays — forcing getOrCreateSourceFile for the
    // entire --build reference graph OOMs (~4–8GB) on packages/tsc typecheck.
    const softPMaterializeAllForImportTracker = !!(lsHost as any)?.projectService;
    programCtx.pendingOverlays = overlays.length > 0 ? overlays : undefined;
    programCtx.pendingExtraFileExtensions = collectExtraFileExtensions(names, options);
    _lastExtraFileExtensions = programCtx.pendingExtraFileExtensions;
    _hasHostBoundFiles = preferHostSourceFiles;
    if (_tp0) _rpcTraceEvent("thinProgram.t", `afterHostOverlayCollect ms=${Date.now()-_tp0} overlays=${overlays.length} names=${names.size}`);
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
    if (_tp0) _rpcTraceEvent("thinProgram.t", `beforeCreateChecker ms=${Date.now()-_tp0}`);

    const checker = createTsgoChecker(thinProgramForChecker as any);
    if (_tp0) _rpcTraceEvent("thinProgram.t", `afterCreateChecker ms=${Date.now()-_tp0}`);

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

    // ── structureIsReused (tsserver cache invalidation) ──
    // updateGraphWorker (server/project.ts) clears the export-map cache whenever
    // a new program reports StructureIsReused.Not, and the thin program is
    // rebuilt on every updateGraph — a constant `Not` wiped the cache on each
    // keystroke, so auto-import completionInfo re-scanned every module (~400ms)
    // instead of hitting the cache (~2ms). Mirror stock
    // tryReuseStructureFromOldProgram against the previous thin program for the
    // same tsconfig: Completely when the tsgo file set and structure-affecting
    // options are unchanged (content-only overlay refresh — the same edits that
    // stock reports Completely for), Not on the first program or when files
    // were added/removed or options changed. Completely rather than SafeModules
    // because it also skips updateGraphWorker's hasNewProgram bookkeeping —
    // the rootFilesMap walk there materializes a full host-parsed SourceFile
    // per root file (~430ms per keystroke on a 371-file project), while with
    // an unchanged file set nothing it maintains can move (resolvedPaths are
    // fixed by the set, thin programs have no missing file paths, and
    // exportMapCache.onFileChanged below it still sees content changes).
    // Skipped in build mode: `tsc -b` programs are one-shot and the shape
    // memo would pin every project's file list for the whole build.
    let structureIsReused = StructureIsReused.Not;
    if (!(options as any).tscBuild) {
        let shapes = typeof lsHost === "object" && lsHost !== null ? _programShapeByHost.get(lsHost) : undefined;
        if (!shapes && typeof lsHost === "object" && lsHost !== null) {
            shapes = new Map();
            _programShapeByHost.set(lsHost, shapes);
        }
        const shapeMap = shapes ?? _programShapeNoHost;
        const shapeFileNames = [...getTsgoSourceFileNames()].sort();
        const prevShape = shapeMap.get(configFilePath);
        if (
            prevShape
            && shapeFileNames.length > 0
            && prevShape.fileNames.length === shapeFileNames.length
            && prevShape.fileNames.every((n, i) => n === shapeFileNames[i])
            && !ts.changesAffectModuleResolution(prevShape.options, options)
            && !ts.optionsHaveChanges(prevShape.options, options, ts.sourceFileAffectingCompilerOptions)
        ) {
            structureIsReused = StructureIsReused.Completely;
        }
        _rpcTraceEvent(
            "thinProgram.structureIsReused",
            `value=${structureIsReused === StructureIsReused.Completely ? "Completely" : "Not"}`
            + ` files=${shapeFileNames.length} config=${configFilePath}`,
        );
        if (_tp0) _rpcTraceEvent("thinProgram.t", `afterStructureReuse ms=${Date.now()-_tp0}`);
        shapeMap.set(configFilePath, { fileNames: shapeFileNames, options });
    }

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
        // Disk-stable library declarations: reuse the bound host AST from the
        // previous program generation when the script version is unchanged.
        const stableSfCache = isStableHostSfPath(hostFileName) ? getHostSfStableCache(hostForLs()) : undefined;
        if (stableSfCache) {
            const hit = stableSfCache.get(hostFileName);
            if (hit && hit.version === String(scriptVersion)) {
                ensureHostSourceFileBound(hit.sf, options);
                ensureTnbVersion(hit.sf, hostFileName);
                sfCache.set(cacheKey, hit.sf);
                return hit.sf;
            }
        }
        const rememberStable = (sf: any): any => {
            if (stableSfCache && sf) stableSfCache.set(hostFileName, { version: String(scriptVersion), sf });
            return sf;
        };
        _tnbFullSfMaterializations++;
        if (process.env.TNB_SF_MATERIALIZE_STATS === "1") {
            tnbLogSfMaterialize(`[TNB_SF_MATERIALIZE] full+1 total soft=${_tnbLightStubCreations} full=${_tnbFullSfMaterializations} file=${hostFileName}`);
        }

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
                return rememberStable(hostSf);
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
                    return rememberStable(hostSf);
                }
                const scriptKind = resolveLanguageServiceScriptKind(ls, fileName, hostFileName, /*fromHostSnapshot*/ true);
                const sf = attachHostSourceFileMetadata(
                    createSkeletonSourceFile(hostFileName, text, options.target ?? 99, scriptKind),
                    hostFileName,
                );
                ensureTnbVersion(sf, hostFileName);
                sfCache.set(cacheKey, sf);
                return rememberStable(sf);
            }
        }

        // Default libs (lib.*.d.ts): stock LS token walks (FAR/highlights/rename)
        // traverse program.getSourceFiles() and surface declaration entries in
        // lib files; the bridge's never-host-parse rule dropped them from the
        // walk (sim-nav refs-missing cluster). Under tsserver (projectService)
        // host-parse once per content version and reuse via the stable cache —
        // lib content is fixed per install, same rule as node_modules .d.ts.
        // createBoundHostSourceFile returns undefined on empty text → fall
        // through to the tsgo-backed skeleton below (checker RPC unaffected).
        if (softPMaterializeAllForImportTracker && isHostLibFile(hostFileName)) {
            const libText = host?.readFile?.(hostFileName) ?? "";
            const hostSf = createBoundHostSourceFile(hostFileName, fileName, libText);
            if (hostSf) {
                ensureTnbVersion(hostSf, hostFileName);
                sfCache.set(cacheKey, hostSf);
                return rememberStable(hostSf);
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
        _tnbLightStubCreations++;
        if (process.env.TNB_SF_MATERIALIZE_STATS === "1") {
            tnbLogSfMaterialize(`[TNB_SF_MATERIALIZE] lightStub+1 total soft=${_tnbLightStubCreations} full=${_tnbFullSfMaterializations} file=${hostFileName}`);
        }
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
                // Callers query with host-cased fileNames OR canonical
                // lowercase Paths (NodeHandle.path, builder byPath walks) —
                // index both forms so member files never false-negative.
                names.add(toHostFileName(n));
                names.add(canonicalSourceFilePath(n));
            }
            programFileNamesCache = { proj, names };
        }
        const hit = programFileNamesCache.names.has(toHostFileName(fileName))
            || programFileNamesCache.names.has(canonicalSourceFilePath(fileName));
        if (!hit) {
            _navTrace(() => `programContainsFile miss: file=${fileName} cfg=${configFilePath} names=${programFileNamesCache!.names.size}`);
        }
        return hit;
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
            // Build mode: the builder asks for both kinds for every program
            // file (buildinfo walk + emitFilesAndReportErrors) — ~2 RPCs per
            // file whose Go-side results are already memoized after the
            // prefetched whole-program pass, so the cost was almost entirely
            // per-call bridge overhead. One batch RPC fills the memo up
            // front; files the batch does not cover (host-virtual name
            // mismatches) still fall through to the per-file RPC below.
            // Never batch for interactive hosts: an editor asks for one open
            // file, not the whole program.
            if ((options as any).tscBuild && process.env.TNB_BATCH_DIAG !== "0" && typeof proj.program.getDiagnosticsBatch === "function") {
                try {
                    const entries = proj.program.getDiagnosticsBatch() ?? [];
                    if (process.env.TNB_BATCH_DIAG_DEBUG === "1") {
                        process.stderr.write(`[batch-diag] entries=${entries.length} keys=${JSON.stringify(entries.slice(0, 3).map((e: any) => toHostFileName(e.fileName)))}\n`);
                    }
                    for (const entry of entries) {
                        const hostFileName = toHostFileName(entry.fileName);
                        const syntactic = mapTsgoDiagnostics(entry.syntactic, getDiagnosticSourceFile);
                        const semantic = mapTsgoDiagnostics(entry.semantic, getDiagnosticSourceFile);
                        // Builder callers pass sourceFile.fileName, which may be
                        // the canonical (lowercased) path rather than tsgo's
                        // original-casing name — index under both.
                        for (const key of new Set([hostFileName, canonicalSourceFilePath(hostFileName)])) {
                            perFileDiagCache.syntactic.set(key, syntactic);
                            perFileDiagCache.semantic.set(key, semantic);
                        }
                    }
                }
                catch (e) {
                    // Batch is an optimization only — per-file RPCs still serve misses.
                    if (process.env.TNB_BATCH_DIAG_DEBUG === "1") {
                        process.stderr.write(`[batch-diag] failed: ${(e as any)?.message}\n`);
                    }
                }
            }
        }
        return perFileDiagCache;
    };
    const getSyntacticDiagnosticsForFile = (proj: any, fileName: string): readonly any[] => {
        const cache = getPerFileDiagCache(proj);
        let result = cache.syntactic.get(fileName);
        if (!result) {
            if (process.env.TNB_BATCH_DIAG_DEBUG === "1") {
                process.stderr.write(`[batch-diag] syntactic miss: ${fileName}\n`);
            }
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
            // Soft-P′: tsserver (projectService) must not hand import tracker light
            // stubs with imports:[]. Full host-bound AST keeps forEachImport able
            // to discover closed importer files. Do NOT key this on preferHost —
            // vue-tsc overlays set preferHost without projectService and OOM if
            // the whole program is materialized (see softPMaterializeAllForImportTracker).
            if (softPMaterializeAllForImportTracker || fileHasHostSourceContent(pathStr, hostFileName)) {
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
            // file. Soft-P′: under tsserver projectService always materialize
            // real host-bound SourceFiles so FAR import discovery sees imports
            // on closed files. preferLightProgramFiles keeps stubs; vue-tsc
            // (preferHost via overlays, no projectService) keeps content-gated
            // materialization to avoid --build OOM.
            for (const name of names) {
                // Default libs join the LS walk view only under tsserver
                // (projectService), where FAR/highlights/rename need their
                // declaration entries (stock parity); other modes keep the
                // exclusion — no token walks there, just wasted AST cost.
                if (isHostLibFile(name) && !softPMaterializeAllForImportTracker) continue;
                const hostFileName = toHostFileName(name);
                let sf: any;
                if (preferLightProgramFiles) {
                    sf = getOrCreateLightSourceFile(name);
                }
                else if (softPMaterializeAllForImportTracker || fileHasHostSourceContent(name, hostFileName)) {
                    sf = getOrCreateSourceFile(name);
                }
                else {
                    sf = getOrCreateLightSourceFile(name);
                }
                if (sf) result.push(sf);
            }
            if (process.env.TNB_SF_MATERIALIZE_STATS === "1") {
                tnbLogSfMaterialize(
                    `[TNB_SF_MATERIALIZE] getSourceFiles n=${result.length} `
                    + `preferHost=${preferHostSourceFiles} softPAll=${softPMaterializeAllForImportTracker} `
                    + `preferLight=${preferLightProgramFiles} `
                    + `soft=${_tnbLightStubCreations} full=${_tnbFullSfMaterializations}`,
                );
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
        // Batch auto-import export index (exportInfoMap cold populate).
        getModuleExportMap: (importingFileName?: string) => {
            const proj = project;
            if (!proj?.checker || typeof proj.checker.getModuleExportMap !== "function") return undefined;
            try {
                const batch = proj.checker.getModuleExportMap(importingFileName ? tsgoFileArg(importingFileName) : undefined);
                // TEMP cont6 dump (not for commit): first divergence between export-map and completion.
                if (process.env.TNB_C6_DUMP === "1" && batch?.modules) {
                    try {
                        const fs = require("node:fs") as typeof import("node:fs");
                        const watch = new Set(["events", "node:events", "dgram", "node:dgram", "stream", "node:stream", "async_hooks", "node:async_hooks"]);
                        const rows = [];
                        for (const m of batch.modules) {
                            const name = String(m.moduleName ?? "").replace(/^"|"$/g, "");
                            if (!watch.has(name)) continue;
                            rows.push({ name, file: m.moduleFileName || "", named: (m.namedExports ?? []).length, def: !!m.defaultExport });
                        }
                        fs.appendFileSync("/tmp/tnb-c6-mem-dump.jsonl", JSON.stringify({
                            t: Date.now(), importingFileName: importingFileName ?? null,
                            modules: batch.modules.length, rows,
                        }) + "\n");
                    } catch { /* ignore */ }
                }
                return batch;
            } catch {
                return undefined;
            }
        },
        // Batch auto-import module specifier resolution (collectAutoImports cold path).
        getModuleSpecifiersBatch: (importingFileName: string, moduleSymbols: readonly any[], preferences: any) => {
            const proj = project;
            if (!proj?.checker || typeof proj.checker.getModuleSpecifiersBatch !== "function") return undefined;
            try {
                return proj.checker.getModuleSpecifiersBatch(
                    tsgoFileArg(importingFileName),
                    moduleSymbols,
                    preferences && {
                        importModuleSpecifierPreference: preferences.importModuleSpecifierPreference,
                        importModuleSpecifierEnding: preferences.importModuleSpecifierEnding,
                        autoImportSpecifierExcludeRegexes: preferences.autoImportSpecifierExcludeRegexes,
                    },
                );
            } catch {
                return undefined;
            }
        },
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
        // No resolution cache on the thin program; resolve through the checker
        // (tsgo RPC) so services' getReferenceAtPosition can produce stock's
        // file-start definition for module specifiers.
        getResolvedModuleFromModuleSpecifier: (moduleSpecifier: any, _sourceFile?: any) => {
            try {
                const sym = checker.resolveExternalModuleName?.(moduleSpecifier);
                const decl = sym?.declarations?.[0];
                const sf = decl && (decl.kind === ts.SyntaxKind.SourceFile ? decl : decl.getSourceFile?.());
                const fileName = sf?.fileName;
                if (typeof fileName !== "string" || !fileName) return undefined;
                return {
                    resolvedModule: {
                        resolvedFileName: fileName,
                        extension: ts.extensionFromPath(fileName),
                        isExternalLibraryImport: fileName.includes("/node_modules/"),
                    },
                    failedLookupLocations: [],
                };
            } catch { return undefined; }
        },
        getResolvedTypeReferenceDirective: () => undefined,
        getResolvedTypeReferenceDirectiveFromTypeReferenceDirective: () => undefined,
        getLibFileFromReference: () => undefined,
        forEachResolvedProjectReference: () => undefined,
        getResolvedProjectReferenceByPath: () => undefined,
        getProgramDiagnosticsContainer: () => { throw new Error("tsgoChecker: Program.getProgramDiagnosticsContainer is not available on tsgo-backed programs"); },
        getCurrentPackagesMap: () => undefined,
        structureIsReused,
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
    programCtx.thinProgram = thinProgram;
    _hostProgramRef = thinProgram;

    return new Proxy(thinProgram, {
        get(target: any, prop: string | symbol, receiver: any) {
            if (prop in target) return Reflect.get(target, prop, receiver);
            if (typeof prop !== "string") return undefined;
            return (..._args: any[]) => {
                traceThrow("Program", prop);
                throw new Error(`tsgoChecker: Program.${prop} is not implemented on the tsgo-backed program`);
            };
        },
        has: (target: any, p) => p in target,
        ownKeys: () => Object.keys(thinProgram),
        getOwnPropertyDescriptor: (target: any, p) => Object.getOwnPropertyDescriptor(target, p),
    });
}

/**
 * Stock binder attaches .symbol on nameless signature decls (Constructor →
 * InternalSymbolName.Constructor, CallSignature → __call, etc.). RemoteNode
 * AST omits binder symbols, and getSymbolAtLocation(decl) does not recover
 * them (stock also requires getSymbolOfDeclaration / the binder slot).
 * Recover via the containing class/interface members table, then fall back
 * to a constructor/signature shim whose `.parent` is the container so
 * createDefinitionFromSignatureDeclaration / symbolMatchesSignature match
 * stock (class + constructor defs for `new GenericClass`).
 */
function memberSymbolDisplayName(m: any): string {
    return unescapeTsgoSymbolName(String(m?.escapedName ?? m?.name ?? ""));
}

function collectContainerMemberSymbols(parentSym: any): any[] {
    const out: any[] = [];
    const seen = new Set<any>();
    const push = (m: any) => {
        if (!m || seen.has(m)) return;
        seen.add(m);
        out.push(m);
    };
    try {
        if (typeof parentSym.getMembers === "function") {
            const list = parentSym.getMembers();
            // v7.0.2+ returns a ReadonlyMap; earlier bridge returned an array.
            if (list && typeof list.values === "function" && typeof list.get === "function") for (const m of list.values()) push(m);
            else if (list?.length) for (const m of list) push(m);
        }
    } catch { /* best-effort */ }
    // Host SymbolObject (post refineNavSymbol) exposes `.members` as a Map /
    // SymbolTable, not getMembers(). Falling back to only getMembers() missed
    // `__constructor` and forced the class-symbol fallback (crash-safe but
    // dropped the class-name definition for `new GenericClass`).
    try {
        const table = parentSym.members;
        if (table && typeof table.values === "function") {
            for (const m of table.values()) push(m);
        }
        else if (table && typeof table === "object") {
            for (const key of Object.keys(table)) push(table[key]);
        }
    } catch { /* best-effort */ }
    try {
        if (typeof parentSym.getExports === "function") {
            const list = parentSym.getExports();
            if (list && typeof list.values === "function" && typeof list.get === "function") for (const m of list.values()) push(m);
            else if (list?.length) for (const m of list) push(m);
        }
    } catch { /* best-effort */ }
    try {
        const table = parentSym.exports;
        if (table && typeof table.values === "function") {
            for (const m of table.values()) push(m);
        }
        else if (table && typeof table === "object") {
            for (const key of Object.keys(table)) push(table[key]);
        }
    } catch { /* best-effort */ }
    return out;
}

function ensureMemberSymbolParent(member: any, parentSym: any): any {
    if (!member || !parentSym) return member;
    try {
        const existing = symbolParentOf(member);
        if (existing === parentSym) return member;
        // Force parent to the container we resolved. A pre-existing parent with
        // a different object identity breaks symbolMatchesSignature's
        // `s === decl.symbol.parent` check against getRootSymbols(class).
        Object.defineProperty(member, "parent", { value: parentSym, configurable: true });
    } catch { /* best-effort */ }
    return member;
}

/**
 * goToDefinition for `new Foo` matches symbolMatchesSignature then filters
 * definitions with `isClassDeclaration` / `isClassExpression`. Bridge class
 * symbols often expose declaration handles whose `.kind` is still a raw tsgo
 * value (or omit the ClassDeclaration entirely), so the filter drops the
 * class-name span and only the constructor sigInfo remains. Re-anchor the
 * container symbol onto the live ClassDeclaration/ClassExpression node
 * (already kind-remapped via RemoteNode) so the stock filter keeps it.
 */
function ensureContainerDeclarationOnSymbol(parentSym: any, parent: any): void {
    if (!parentSym || !parent) return;
    // Declaration handles may still carry raw tsgo kinds; remap before the
    // fork-kind classLike test so we don't bail on a real ClassDeclaration.
    if (typeof parent.kind === "number") {
        const remappedParentKind = remapKind(parent.kind);
        if (remappedParentKind !== parent.kind) {
            try {
                Object.defineProperty(parent, "kind", {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: remappedParentKind,
                });
            }
            catch {
                try { parent.kind = remappedParentKind; } catch { /* read-only kind */ }
            }
        }
    }
    const classLike =
        parent.kind === SyntaxKind.ClassDeclaration
        || parent.kind === SyntaxKind.ClassExpression
        || parent.kind === SyntaxKind.InterfaceDeclaration;
    if (!classLike) return;
    try {
        // Remap raw tsgo kinds on any existing declaration handles so
        // isClassDeclaration / isClassExpression type-guards fire.
        const declsRaw: any[] = Array.isArray(parentSym.declarations) ? [...parentSym.declarations] : [];
        for (const d of declsRaw) {
            if (!d || typeof d.kind !== "number") continue;
            const remapped = remapKind(d.kind);
            if (remapped === d.kind) continue;
            try {
                Object.defineProperty(d, "kind", {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: remapped,
                });
            }
            catch {
                try { d.kind = remapped; } catch { /* read-only kind */ }
            }
        }
        const decls = declsRaw;
        const already = decls.some((d: any) =>
            d === parent
            || (d
                && d.kind === parent.kind
                && typeof d.pos === "number"
                && d.pos === parent.pos
                && d.end === parent.end),
        );
        if (!already) decls.unshift(parent);
        // Prefer the remapped live node even when a stale handle was present.
        const preferred = decls.filter((d: any) => d && d.kind === parent.kind);
        const rest = decls.filter((d: any) => !d || d.kind !== parent.kind);
        const next = preferred.length ? [...preferred, ...rest] : decls;
        const hasForkClassKind = next.some((d: any) =>
            d
            && (d.kind === SyntaxKind.ClassDeclaration
                || d.kind === SyntaxKind.ClassExpression
                || d.kind === SyntaxKind.InterfaceDeclaration),
        );
        if (!hasForkClassKind) next.unshift(parent);
        try {
            parentSym.declarations = next;
        }
        catch {
            Object.defineProperty(parentSym, "declarations", {
                configurable: true,
                enumerable: true,
                get: () => next,
            });
        }
        if (!parentSym.valueDeclaration) {
            try { parentSym.valueDeclaration = parent; }
            catch {
                try {
                    Object.defineProperty(parentSym, "valueDeclaration", {
                        configurable: true,
                        enumerable: true,
                        get: () => parent,
                    });
                } catch { /* read-only */ }
            }
        }
    } catch { /* best-effort */ }
}

/** Ensure Class/Interface symbols keep a fork-kind class-like declaration. */
function ensureClassLikeSymbolDeclarations(sym: any): any {
    if (!sym) return sym;
    const flags = sym.flags ?? 0;
    if (!(flags & (SymbolFlags.Class | SymbolFlags.Interface))) return sym;
    try {
        const decl = sym.valueDeclaration ?? sym.declarations?.[0];
        if (decl) ensureContainerDeclarationOnSymbol(sym, decl);
    } catch { /* best-effort */ }
    return sym;
}

function namelessSignatureSymbolShim(n: any, parentSym: any, flags: number, name: string): any {
    // Minimal Symbol-shaped object so getCombinedLocalAndExportSymbolFlags and
    // symbolMatchesSignature (s === decl.symbol.parent) behave like stock.
    return {
        flags,
        name,
        escapedName: name,
        parent: parentSym,
        valueDeclaration: n,
        declarations: [n],
        exportSymbol: undefined,
        getFlags() { return this.flags; },
        getName() { return this.name; },
        getEscapedName() { return this.escapedName; },
        getDeclarations() { return this.declarations; },
    };
}

/**
 * Climb paren / as / satisfies / non-null wrappers to the binding parent.
 * Vue `generic` SFCs emit `const __VLS_export = (<T,>(…) => …);` so the
 * signature declaration's immediate parent is ParenthesizedExpression.
 */
function peelExpressionWrappersForBindingParent(node: any): any {
    let cur = node?.parent;
    while (
        cur
        && (
            cur.kind === SyntaxKind.ParenthesizedExpression
            || cur.kind === SyntaxKind.AsExpression
            || cur.kind === SyntaxKind.SatisfiesExpression
            || cur.kind === SyntaxKind.NonNullExpression
            || cur.kind === SyntaxKind.TypeAssertionExpression
        )
    ) {
        cur = cur.parent;
    }
    return cur;
}

// ── nav-path debug trace (default OFF; TNB_TRACE_NAV=1 → TNB_TRACE_NAV_FILE) ──
const _navTraceFile = process.env.TNB_TRACE_NAV === "1"
    ? (process.env.TNB_TRACE_NAV_FILE || "/tmp/tnb-nav-trace.log")
    : "";
function _navTrace(msg: () => string): void {
    if (!_navTraceFile) return;
    try {
        (require("fs") as typeof import("fs")).appendFileSync(_navTraceFile, `${Date.now()} ${msg()}\n`);
    } catch { /* best-effort */ }
}

function resolveNamelessDeclarationSymbol(n: any, project: any): any {
    if (!n || !project?.checker) return undefined;
    const parent = peelExpressionWrappersForBindingParent(n) ?? n.parent;
    if (!parent) return undefined;
    let parentSym = parent.symbol;
    if (!parentSym && parent.name) {
        try { parentSym = project.checker.getSymbolAtLocation(parent.name); } catch { /* best-effort */ }
    }
    if (!parentSym && !parent.name) {
        // Anonymous container (TypeLiteral in a .d.ts — e.g. Vue component
        // construct signatures inside `defineComponent`'s return type). Stock
        // binder gives decl.symbol.parent = the type-literal symbol ("__type");
        // recover it through the container's type.
        try { parentSym = project.checker.getTypeAtLocation(parent)?.symbol; } catch { /* best-effort */ }
    }
    if (parentSym) {
        // Keep class-name definitions when symbolMatchesSignature takes the
        // constructor branch (strict isClassDeclaration filter).
        ensureContainerDeclarationOnSymbol(parentSym, parent);
    }

    const isAnonFunction =
        n.kind === SyntaxKind.ArrowFunction || n.kind === SyntaxKind.FunctionExpression;
    const wantFlags =
        n.kind === SyntaxKind.Constructor ? SymbolFlags.Constructor :
        n.kind === SyntaxKind.ConstructSignature || n.kind === SyntaxKind.ConstructorType ? SymbolFlags.Signature :
        n.kind === SyntaxKind.CallSignature || n.kind === SyntaxKind.FunctionType ? SymbolFlags.Signature :
        n.kind === SyntaxKind.IndexSignature ? SymbolFlags.Signature :
        isAnonFunction ? SymbolFlags.Function :
        0;
    const wantNames = new Set<string>([
        "__constructor", "constructor",
        "__call", "call",
        "__new", "new",
        "__index", "index",
        "__function",
    ]);
    const members = collectContainerMemberSymbols(parentSym);
    if (members.length) {
        for (const m of members) {
            const nm = memberSymbolDisplayName(m);
            if (wantNames.has(nm)) return ensureMemberSymbolParent(m, parentSym);
        }
        if (wantFlags) {
            for (const m of members) {
                if (m?.flags & wantFlags) return ensureMemberSymbolParent(m, parentSym);
            }
        }
    }
    // No members table entry (rare): synthesize a constructor/signature symbol
    // with `.parent = class` so symbolMatchesSignature still pulls the class
    // declaration into getDefinitionAtPosition's result list.
    // Anonymous ArrowFunction / FunctionExpression (Vue generic functional
    // components): stock binder uses InternalSymbolName.Function ("__function").
    if (wantFlags) {
        const shimName =
            n.kind === SyntaxKind.Constructor ? "__constructor" :
            n.kind === SyntaxKind.CallSignature || n.kind === SyntaxKind.FunctionType ? "__call" :
            n.kind === SyntaxKind.ConstructSignature || n.kind === SyntaxKind.ConstructorType ? "__new" :
            isAnonFunction ? "__function" :
            "__index";
        return namelessSignatureSymbolShim(n, parentSym, wantFlags, shimName);
    }
    return parentSym;
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
        if (self._resolvedNode === undefined || self._resolvedNode === null) {
            // Prefer the handle's own producing project (NodeHandle.canonicalProject,
            // v7.0.2+): with multiple configured projects open, the global
            // _currentProjectRef may point at a sibling project that doesn't
            // contain this handle's file — resolve() would miss and services
            // then crash on undefined structural fields (e.g.
            // ExportAssignment.expression → isIdentifier(undefined)).
            let resolved: any = null;
            try { resolved = self.resolve() ?? null; } catch { /* handle without canonicalProject */ }
            if (resolved === null) {
                const project = _currentProjectRef.project;
                if (project) {
                    try { resolved = self.resolve(project) ?? null; } catch { /* best-effort */ }
                }
            }
            // Do not memoize failure: a transient miss (project unset during an
            // early call, or a snapshot rotation) must not poison the handle for
            // the rest of the session.
            if (resolved === null) {
                _navTrace(() => `resolveSelf miss: path=${self?.path} kind=${self?.kind} index=${self?.index}`);
                return self._resolvedNode = null;
            }
            self._resolvedNode = resolved;
        }
        return self._resolvedNode;
    };
    // NodeHandle.getSourceFile() — scope manager calls this on declaration
    // handles to check if a symbol is from a lib file. Short-circuit to
    // project.program.getSourceFile(path) without full Node materialisation.
    if (typeof proto.getSourceFile !== "function") {
        proto.getSourceFile = function () {
            // Prefer the handle's producing project (v7.0.2 canonicalProject):
            // the global _currentProjectRef may point at a sibling project that
            // doesn't contain this handle's file.
            try {
                const own = (this as any).canonicalProject?.program?.getSourceFile(this.path);
                if (own) return own;
            } catch { /* best-effort */ }
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
        "comment", "condition", "constraint", "declarationList", "declarations", "default", "defaultType",
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
        // Binding/identity: createDefinitionFromSignatureDeclaration reads
        // decl.symbol (IndexInfo.declaration / Signature.declaration handles).
        "symbol",
    ];
    for (const f of STRUCTURAL_FIELDS) {
        if (!Object.getOwnPropertyDescriptor(proto, f)) {
            Object.defineProperty(proto, f, {
                configurable: true,
                get() { return resolveSelf(this)?.[f]; },
            });
        }
    }
    // RemoteNode AST encoding omits binder symbols. Signature.declaration /
    // named declarations still need .symbol for createDefinitionFromSignatureDeclaration.
    // Fall back to checker.getSymbolAtLocation(node.name) when the resolved
    // node has no own symbol (FunctionDeclaration / MethodDeclaration / etc.).
    // Constructors / call·construct·index signatures have no .name — stock
    // binder still attaches decl.symbol (__constructor / __call / …). Without
    // that, createDefinitionFromSignatureDeclaration passes undefined into
    // getCombinedLocalAndExportSymbolFlags and crashes on .exportSymbol.
    {
        const desc = Object.getOwnPropertyDescriptor(proto, "symbol");
        if (desc?.get) {
            const prevGet = desc.get;
            Object.defineProperty(proto, "symbol", {
                configurable: true,
                get() {
                    const own = prevGet.call(this);
                    if (own) return own;
                    const n = resolveSelf(this);
                    const project = _currentProjectRef.project;
                    if (!n || !project?.checker) {
                        _navTrace(() => `symbol-getter bail: n=${!!n} checker=${!!project?.checker} path=${(this as any)?.path} kind=${(this as any)?.kind}`);
                        return undefined;
                    }
                    try {
                        const nameNode = n.name;
                        if (nameNode) {
                            const sym = project.checker.getSymbolAtLocation(nameNode);
                            // Class/interface containers: keep a kind-remapped
                            // declaration on the symbol so goToDefinition's
                            // isClassDeclaration filter keeps the class-name span.
                            if (sym) {
                                ensureContainerDeclarationOnSymbol(sym, n);
                                return sym;
                            }
                            _navTrace(() => `symbol-getter named-miss: kind=${n.kind} name=${String(nameNode.text ?? "").slice(0, 40)} sf=${n.getSourceFile?.()?.fileName}`);
                            // Named binding miss (e.g. generated __VLS_export behind
                            // wrappers): still recover nameless function shims.
                        }
                        const shim = resolveNamelessDeclarationSymbol(n, project);
                        if (!shim) _navTrace(() => `symbol-getter nameless-miss: kind=${n.kind} sf=${n.getSourceFile?.()?.fileName}`);
                        return shim;
                    } catch (e) {
                        _navTrace(() => `symbol-getter throw: kind=${n?.kind} err=${String((e as any)?.message ?? e).slice(0, 120)}`);
                    }
                    return undefined;
                },
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
        if (project) {
            // Re-point the module-global active-project ref at THIS checker's
            // project. With several configured projects in one tsserver
            // session, the sibling project's creation leaves the ref pointing
            // at itself; non-adapter consumers (NodeHandle/Type proto hooks,
            // thin-program helpers) then resolve against the wrong project and
            // silently miss (e.g. references returning [] for a file whose
            // sibling project is merely open).
            if (_currentProjectRef.project !== project) {
                _currentProjectRef.project = project;
            }
            return project;
        }

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
            patchSignatureFlagsRemap(sync, project);
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
        patchSignatureFlagsRemap(sync, project);
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
    const symByPos = new Map<string, Map<string, any>>();
    // Start-keyed symbols from the allIdentifiers prefetch RPC (returns only
    // start positions, never undefined, always real symbol sites). Kept
    // separate from the exact-span symByPos so start-keyed entries can never
    // collide with a different token's span keys.
    const symPrefetchByPos = new Map<string, Map<number, any>>();
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
    const getSymFileCache = (fileName: string, create = false): Map<string, any> | undefined => {
        const key = symCacheFileName(fileName);
        let fc = symByPos.get(key);
        if (!fc && create) {
            fc = new Map();
            symByPos.set(key, fc);
        }
        return fc;
    };
    // Exact-span keys only. The old start/end/end-1 triple-key scheme let a
    // token's END key collide with the next token's START key, so a cached
    // `undefined` (no-symbol token, e.g. `(`) poisoned the adjacent
    // identifier's lookup and getSymbolAtLocation returned undefined without
    // ever querying (def for `useCssModule` went empty).
    const probeSymCache = (fileName: string, start: number, end: number): { found: boolean; sym: any } => {
        const fc = getSymFileCache(fileName);
        if (!fc) return { found: false, sym: undefined };
        const key = `${start}:${end}`;
        if (fc.has(key)) return { found: true, sym: fc.get(key) };
        const pf = symPrefetchByPos.get(symCacheFileName(fileName));
        if (pf?.has(start)) return { found: true, sym: pf.get(start) };
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
        fc.set(`${start}:${end}`, sym);
    };
    // refineNavSymbol memo: the same symbol is refined once even when queried
    // from many reference sites (e.g. 100 refs to `foo`). Keyed by symbol
    // object identity (tsgo symbols are id-keyed singletons via objectRegistry;
    // host-bound symbols are real TS symbol objects). Cleared on snapshot
    // refresh alongside symByPos.
    let refinedSymBySym = new WeakMap<any, any>();
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
    // tsserver (projectService) needs full ambient export batch for exportInfoMap;
    // vue-tsc / builder hosts without projectService use the light batch.
    const isProjectServiceProgram = !!(programCtx?.lsHost as any)?.projectService;
    /** tryFindAmbientModule memo — keyed unquoted module name; null = miss. */
    const ambientModuleByNameCache = new Map<string, any | null>();
    // Light ambient-module batch for builder referenced-files (module names +
    // declaration merge only). Prefer Checker.getAmbientModules; fall back to
    // getModuleExportMap when the method is missing or throws. null = fetch
    // failed; undefined = not fetched.
    let ambientModuleBatchCache: any = undefined;
    // Checker-quality ambient symbols for tryFindAmbientModule / export-info
    // rehydrate. Binder-only light symbols lack merged exports and can hang
    // getAliasedSymbol when auto-import walks ambient modules.
    let ambientModuleExportBatchCache: any = undefined;
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
                    if (resolved) {
                        // Authoritative "no export=" from the checker — the
                        // host exports fallback below cannot find one either
                        // (the mirror parsed the same content). Materializing
                        // .exports here cost a getExportsOfSymbol RPC + sorted
                        // Map per module per generation in the auto-import
                        // codefix scan.
                        return moduleSymbol;
                    }
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
        _rpcTraceEvent(
            "overlay.refresh.clearCaches",
            `files=${openFilesWithContent.length} paths=${openFilesWithContent.map(f => f.fileName).join(",")}`
            + ` symByPosFiles=${symByPos.size} symbolsInScope=${symbolsInScopeCache.size}`
            + ` nodeType=${nodeTypeCache.size} typeOfSymbol=${typeOfSymbolCache.size}`
            + ` properties=${propertiesCache.size}`,
        );
        symByPos.clear();
        symPrefetchByPos.clear();
        hostBoundSfMemo.clear();
        symPrefetched.clear();
        symPrefetchPopulated.clear();
        moduleSpecPrefetched.clear();
        symbolsInScopeCache.clear();
        ambientModuleByNameCache.clear();
        ambientModuleBatchCache = undefined;
        ambientModuleExportBatchCache = undefined;
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
        // Invalidate Symbol.parent memos pinned on instances that outlive the
        // cleared maps (Soft-P′ / host-bound may still hold Symbol refs).
        _tnbParentMemoEpoch++;
        // WeakMap has no clear(); drop Soft-P′/S′ memo so remapped decls cannot
        // stick across overlay content refresh (comment claimed this already).
        refinedSymBySym = new WeakMap();
    }

    function getAmbientModuleBatch(): any {
        if (ambientModuleBatchCache !== undefined) return ambientModuleBatchCache ?? undefined;
        try {
            const getAmbient = project.checker.getAmbientModules;
            if (typeof getAmbient === "function") {
                ambientModuleBatchCache = getAmbient.call(project.checker) ?? null;
            }
        }
        catch { /* fall through to export-map fallback */ }
        if (ambientModuleBatchCache === undefined) {
            try {
                ambientModuleBatchCache = project.checker.getModuleExportMap?.() ?? null;
            }
            catch {
                ambientModuleBatchCache = null;
            }
        }
        return ambientModuleBatchCache ?? undefined;
    }

    function getAmbientModuleExportBatch(): any {
        if (ambientModuleExportBatchCache !== undefined) return ambientModuleExportBatchCache ?? undefined;
        try {
            ambientModuleExportBatchCache = project.checker.getModuleExportMap?.() ?? null;
        }
        catch {
            ambientModuleExportBatchCache = null;
        }
        return ambientModuleExportBatchCache ?? undefined;
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
        // Cross-generation reuse: same RemoteSourceFile object ⇒ same index.
        if (sf && typeof sf === "object") {
            const stable = _nodeIndexBySf.get(sf);
            if (stable) {
                nodeIndexCache.set(fileName, stable);
                return stable;
            }
        }
        if (process.env.TNB_TRACE_NODEINDEX === "1") {
            try {
                require("fs").appendFileSync("/tmp/tnb-nodeindex.log", `build file=${fileName} sfType=${sf?.constructor?.name}\n`);
            } catch { /* trace only */ }
        }
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
        if (sf && typeof sf === "object") _nodeIndexBySf.set(sf, idx);
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
        let pf = symPrefetchByPos.get(cacheName);
        if (!pf) { pf = new Map(); symPrefetchByPos.set(cacheName, pf); }
        for (const [pos, sym] of byPos) {
            pf.set(pos, sym);
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

    /**
     * Map a host AST node to its tsgo mirror. Stock TypeChecker entry points
     * (getTypeAtLocation / getSignatureFromDeclaration) call getParseTreeNode
     * first so synthesized transform clones still resolve via `.original`.
     * Without that walk, convertToAsyncFunction's renameCollidingVarNames clone
     * misses the tsgo index (pos may be -1 / no fileName) and early-returns.
     */
    function resolveHostNodeToTsgo(node: any, nodeTest?: (n: any) => boolean): any {
        if (!node) return undefined;
        const parseNode = getParseTreeNode(node, nodeTest as any);
        const target = parseNode ?? (!nodeTest ? node : undefined);
        if (!target) return undefined;
        const sf = target.getSourceFile?.();
        if (!sf?.fileName) return undefined;
        // Synthesized nodes that never linked an original have no source span.
        if (typeof target.pos === "number" && target.pos < 0) return undefined;
        let start: number;
        let end: number;
        try {
            start = typeof target.getStart === "function" ? target.getStart(sf) : target.pos;
            end = typeof target.getEnd === "function" ? target.getEnd(sf) : target.end;
        }
        catch {
            return undefined;
        }
        if (typeof start !== "number" || typeof end !== "number" || start < 0) return undefined;
        return findTsgoNodeAtPosition(sf.fileName, start, target.kind, end);
    }

    /**
     * Map a host enclosingDeclaration to its tsgo mirror for NodeBuilder
     * context. signatureHelp's contextual invocations pass *tokens* (e.g. the
     * OpenParenToken of `onEvent(`), which never appear in the tsgo node index
     * (forEachChild skips tokens), so the exact-position lookup misses and Go
     * loses the enclosing context — disabling stock's annotation-reuse branch
     * (`once?: boolean` degrades to `once?: boolean | undefined`). Fall back
     * to the innermost tsgo *node* containing the position; NodeBuilder only
     * needs it for scoping/reuse, not identity.
     */
    function mapHostEnclosingToTsgo(enclosingDeclaration: any): any {
        if (!enclosingDeclaration || typeof enclosingDeclaration.getStart !== "function") return undefined;
        const sf = enclosingDeclaration.getSourceFile?.();
        if (!sf?.fileName) return undefined;
        const start = enclosingDeclaration.getStart(sf);
        const exact = findTsgoNodeAtPosition(sf.fileName, start, enclosingDeclaration.kind, enclosingDeclaration.getEnd(sf));
        if (exact) return exact;
        const tsgoSf = getTsgoSourceFile(sf.fileName);
        if (!tsgoSf) return undefined;
        let deepest: any;
        let cur: any = tsgoSf;
        for (;;) {
            let next: any;
            cur.forEachChild?.((child: any) => {
                if (next) return;
                const cPos = child.pos ?? child.getFullStart?.();
                const cEnd = typeof child.getEnd === "function" ? child.getEnd() : child.end;
                if (cPos <= start && start < cEnd) next = child;
            });
            if (!next) break;
            deepest = next;
            cur = next;
        }
        return deepest;
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
        // SourceFile declarations (module symbols): the tsgo counterpart is the
        // mirror SourceFile itself — resolve it directly instead of walking the
        // whole file to index every node position (auto-import codefix resolves
        // the module symbol of every external module per keystroke; the index
        // build was the dominant cost for project files, whose RemoteSourceFile
        // objects are not retained across generations).
        if (decl.kind === SyntaxKind.SourceFile) {
            const tsgoSf = getTsgoSourceFile(sf.fileName);
            if (!tsgoSf || tsgoSf.kind !== SyntaxKind.SourceFile) return undefined;
            try {
                return project.checker.getSymbolAtLocation(tsgoSf) ?? undefined;
            } catch {
                return undefined;
            }
        }
        // Nameless module default-export declarations — `export default …`
        // ExportAssignment (host binder symbol re-anchored by
        // resolveHostExportDefaultSymbol) and anonymous `export default
        // class/function` declarations. There is no name node to anchor on and
        // the checker returns no symbol for the statement/declaration node
        // itself — recover the tsgo member through the module symbol's exports
        // table instead (the host binder names these symbols "default" /
        // "export=", matching the exports-table key).
        const isNamelessDefaultExport = decl.kind === SyntaxKind.ExportAssignment
            || (!decl.name && !!(decl.modifiers?.some?.((m: any) => m.kind === SyntaxKind.DefaultKeyword)));
        if (isNamelessDefaultExport) {
            const tsgoSf = getTsgoSourceFile(sf.fileName);
            if (!tsgoSf || tsgoSf.kind !== SyntaxKind.SourceFile) return undefined;
            try {
                const moduleSym = project.checker.getSymbolAtLocation(tsgoSf);
                const memberName = decl.kind === SyntaxKind.ExportAssignment && decl.isExportEquals ? "export=" : "default";
                return moduleSym?.exports?.get?.(memberName) ?? undefined;
            } catch {
                return undefined;
            }
        }
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
        // isNullableType — stock Type method; installed in patchTypeProto via checker RPC.
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
                const proj = projectForBridgeObject(this) ?? _currentProjectRef.project;
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
                const proj = projectForBridgeObject(this) ?? _currentProjectRef.project;
                if (!proj) return [];
                return proj.checker.getAugmentedPropertiesOfType(this) ?? [];
            };
        }
        if (!proto.getBaseTypes) {
            proto.getBaseTypes = function () {
                return getBaseTypesCached(this);
            };
        }
        if (!proto.getNonNullableType) {
            proto.getNonNullableType = function () {
                const proj = projectForBridgeObject(this) ?? _currentProjectRef.project;
                if (!proj) return this;
                const t = proj.checker.getNonNullableType(this);
                if (t) fixupType(t);
                return t ?? this;
            };
        }
        if (!proto.getNonOptionalType) {
            proto.getNonOptionalType = function () {
                const proj = projectForBridgeObject(this) ?? _currentProjectRef.project;
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
                const proj = projectForBridgeObject(this) ?? _currentProjectRef.project;
                if (!proj) return undefined;
                if (typeof this.flags === "number" && (this.flags & TF.TypeParameter) !== 0) {
                    const t = proj.checker.getConstraintOfTypeParameter(this);
                    if (t) fixupType(t);
                    return t;
                }
                return undefined;
            };
        }
        // getNumberIndexType / getStringIndexType — stock Type path:
        // checker.getIndexTypeOfType(this, IndexKind.String|Number).
        if (!proto.getNumberIndexType) {
            proto.getNumberIndexType = function () {
                const proj = projectForBridgeObject(this) ?? _currentProjectRef.project;
                if (!proj) return undefined;
                const t = proj.checker.getIndexTypeOfType(this, 1 /* IndexKind.Number */);
                if (t) fixupType(t);
                return t;
            };
        }
        if (!proto.getStringIndexType) {
            proto.getStringIndexType = function () {
                const proj = projectForBridgeObject(this) ?? _currentProjectRef.project;
                if (!proj) return undefined;
                const t = proj.checker.getIndexTypeOfType(this, 0 /* IndexKind.String */);
                if (t) fixupType(t);
                return t;
            };
        }
        // isNullableType — stock Type path: checker.isNullableType(this).
        if (!proto.isNullableType) {
            proto.isNullableType = function () {
                const proj = projectForBridgeObject(this) ?? _currentProjectRef.project;
                if (!proj) return false;
                return !!proj.checker.isNullableType(this);
            };
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
                const proj = projectForBridgeObject(this) ?? _currentProjectRef.project;
                if (!proj) return undefined;
                const t = proj.checker.getReturnTypeOfSignature(this);
                if (t) fixupType(t);
                return t;
            };
        }
        // getTypeParameterAtPosition — stock SignatureObject delegates to
        // checker.getParameterType; bridge Signature implements it via registry
        // RPC. Wrap to fixupType for LS consumers.
        if (proto.getTypeParameterAtPosition) {
            const orig = proto.getTypeParameterAtPosition;
            proto.getTypeParameterAtPosition = function (pos: number) {
                const t = orig.call(this, pos);
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
                parts = trimDocPartsTrailingNewlines(jsDocCommentsFromDeclarations([decl]) ?? []);
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
                tags = trimJsDocTagsTrailingNewlines(jsDocTagsFromDeclarations([decl]) ?? []);
            }
            catch { tags = []; }
            if (tags.length) this.__tnbJsDocTags = tags;
            return tags;
        };
    }

    // ── SignatureFlags boundary remap ─────────────────────────────────
    // Raw tsgo flags per remapped Signature, kept so the native-preview
    // getters (hasRestParameter/isConstruct/isAbstract) can keep reading TSGO
    // semantics after `flags` is rewritten to the fork layout. The WeakMap
    // doubles as the already-remapped marker (registry memoizes instances, so
    // a cache hit must not remap a second time).
    const _sigRawFlags = new WeakMap<object, number>();

    // All Signature instances funnel through
    // ProjectObjectRegistry.getOrCreateSignature (single `new Signature` site
    // in the native-preview bundle, memoized per registry). Wrapping that one
    // method remaps every signature exactly once at creation. The registry
    // class is not exported, so reach its prototype through a live instance.
    function patchSignatureFlagsRemap(s: any, project: any): void {
        const proc = tnbBridgeProcessState();
        if (proc.sigFlagsRemapApplied) return;
        const registry = project?.checker?.objectRegistry;
        const registryProto = registry ? Object.getPrototypeOf(registry) : undefined;
        const sigProto = s?.Signature?.prototype;
        if (!registryProto?.getOrCreateSignature || !sigProto) return;
        proc.sigFlagsRemapApplied = true;
        const origGetOrCreateSignature = registryProto.getOrCreateSignature;
        registryProto.getOrCreateSignature = function (this: any, data: any) {
            const sig = origGetOrCreateSignature.call(this, data);
            if (sig && typeof sig.flags === "number" && !_sigRawFlags.has(sig)) {
                const raw = sig.flags as number;
                _sigRawFlags.set(sig, raw);
                sig.flags = remapSignatureFlags(raw);
            }
            return sig;
        };
        // The native-preview Signature getters read `this.flags` against the
        // TSGO enum; keep them correct off the raw stored value.
        const tsgoSF = loadTsgoEnums().SignatureFlags;
        const rawFlagsOf = (self: any): number => _sigRawFlags.get(self) ?? self?.flags ?? 0;
        for (const [getterName, bit] of [
            ["hasRestParameter", tsgoSF.HasRestParameter],
            ["isConstruct", tsgoSF.Construct],
            ["isAbstract", tsgoSF.Abstract],
        ] as const) {
            Object.defineProperty(sigProto, getterName, {
                configurable: true,
                get(this: any) { return (rawFlagsOf(this) & (bit as number)) !== 0; },
            });
        }
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
        // Stock EnumLike defaulting (tryGetValueFromType) reads `type.symbol.exports`
        // as a Map and picks the first member via `.values()`. Bridge Symbol only
        // exposes getExports(); materialize a Map lazily.
        if (!Object.getOwnPropertyDescriptor(proto, "exports")) {
            Object.defineProperty(proto, "exports", {
                configurable: true,
                get() {
                    if (Object.prototype.hasOwnProperty.call(this, "__tnbExports")) return this.__tnbExports;
                    try {
                        const list = typeof this.getExports === "function" ? this.getExports() : undefined;
                        // v7.0.2+ getExports() returns a ReadonlyMap already in the
                        // checker's canonical (declaration) order — use it directly.
                        if (list && typeof list.get === "function" && typeof list.values === "function") {
                            this.__tnbExports = list.size ? list : undefined;
                            return this.__tnbExports;
                        }
                        if (!list?.length) {
                            this.__tnbExports = undefined;
                            return undefined;
                        }
                        // Match stock SymbolTable insertion (= declaration) order so
                        // firstOrUndefinedIterator(exports.values()) picks the same
                        // enum member as stock (e.g. Color.Red not Color.Green).
                        // Sort key: bare NodeHandle (path, index) when available —
                        // node indexes are assigned in document order, so this
                        // reproduces position order without resolving the remote
                        // node (NodeHandle.pos → resolveSelf → getSourceFile RPC
                        // per declaration; codefix export scans hit this for
                        // every export of every module).
                        const declKey = (s: any): [string, number] => {
                            const d = s?.valueDeclaration ?? s?.declarations?.[0];
                            if (d == null) return ["", 0];
                            if (typeof d.index === "number" && typeof d.path === "string") {
                                return [d.path, d.index];
                            }
                            const pos = typeof d.pos === "number" ? d.pos : 0;
                            return [String(d.getSourceFile?.()?.fileName ?? ""), pos];
                        };
                        const sorted = list.slice().sort((a: any, b: any) => {
                            const [fa, ka] = declKey(a);
                            const [fb, kb] = declKey(b);
                            return fa < fb ? -1 : fa > fb ? 1 : ka - kb;
                        });
                        const map = new Map<string, any>();
                        for (const s of sorted) {
                            const key = String(s?.escapedName ?? s?.name ?? "");
                            if (key) map.set(key, s);
                        }
                        this.__tnbExports = map.size ? map : undefined;
                        return this.__tnbExports;
                    } catch {
                        this.__tnbExports = undefined;
                        return undefined;
                    }
                },
            });
        }
        // Memoize Symbol.parent across repeated reads in one snapshot epoch.
        // Covers confirmed-none (RPC null) so omitzero symbols pay one lazy
        // getParentOfSymbol, not per-entry FFI. Invalidate on: parentHandle
        // upgrade (ph key) or overlay content refresh (_tnbParentMemoEpoch).
        // Soft-P′ instance data properties still shadow this getter.
        // parentHandle===0 ("unfilled") stays lazy — do not seal undefined.
        const parentDesc = Object.getOwnPropertyDescriptor(proto, "parent");
        if (parentDesc?.get && !(parentDesc as any).__tnbParentMemo) {
            const rawGet = parentDesc.get;
            Object.defineProperty(proto, "parent", {
                configurable: true,
                enumerable: parentDesc.enumerable ?? true,
                get() {
                    const ph = this.parentHandle;
                    if (
                        Object.prototype.hasOwnProperty.call(this, "__tnbParentMemo")
                        && this.__tnbParentMemoPh === ph
                        && this.__tnbParentMemoEpoch === _tnbParentMemoEpoch
                    ) {
                        return this.__tnbParentMemo;
                    }
                    let result: any;
                    try { result = rawGet.call(this); }
                    catch { result = undefined; }
                    try {
                        Object.defineProperty(this, "__tnbParentMemo", {
                            value: result,
                            writable: true,
                            configurable: true,
                        });
                        Object.defineProperty(this, "__tnbParentMemoPh", {
                            value: ph,
                            writable: true,
                            configurable: true,
                        });
                        Object.defineProperty(this, "__tnbParentMemoEpoch", {
                            value: _tnbParentMemoEpoch,
                            writable: true,
                            configurable: true,
                        });
                    }
                    catch {
                        this.__tnbParentMemo = result;
                        this.__tnbParentMemoPh = ph;
                        this.__tnbParentMemoEpoch = _tnbParentMemoEpoch;
                    }
                    return result;
                },
            });
            (Object.getOwnPropertyDescriptor(proto, "parent") as any).__tnbParentMemo = true;
        }

        // Stock TransientSymbol carries `links.checkFlags`; getCheckFlags reads
        // it whenever SymbolFlags.Transient is set. tsgo symbols expose raw
        // `checkFlags` (bit layout audited identical) but no `links` object, so
        // a Transient-flagged tsgo symbol flowing into stock services
        // (find-all-refs fromRoot, SymbolDisplay getSymbolKind) would crash on
        // `links.checkFlags`. Satisfy the contract at the prototype.
        // Also provide lazy `links.type` → getTypeOfSymbol for inferFromUsage
        // readback of materialized transient parameters (inferFromUsage.ts:1207).
        if (!Object.getOwnPropertyDescriptor(proto, "links")) {
            Object.defineProperty(proto, "links", {
                configurable: true,
                get() {
                    if (this.__tnbLinks) return this.__tnbLinks;
                    const self = this;
                    const links: any = { checkFlags: this.checkFlags ?? 0 };
                    Object.defineProperty(links, "type", {
                        configurable: true,
                        enumerable: true,
                        get() {
                            if (Object.prototype.hasOwnProperty.call(this, "_type")) return this._type;
                            try {
                                ensureProject();
                                const t = rpc().getTypeOfSymbol(self);
                                if (t) fixupType(t);
                                this._type = t;
                                return t;
                            }
                            catch {
                                return undefined;
                            }
                        },
                        set(v: any) {
                            this._type = v;
                        },
                    });
                    this.__tnbLinks = links;
                    return links;
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
                    const tags = trimJsDocTagsTrailingNewlines(checker.getJsDocTagsOfSymbol(this) ?? []);
                    if (tags.length) return tags;
                }
                catch { /* fall through */ }
            }
            if (decls?.length) {
                const decl = resolveDocDeclaration(decls[0]);
                if (decl) {
                    try {
                        return trimJsDocTagsTrailingNewlines(jsDocTagsFromDeclarations([decl]) ?? []);
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

    // Cross-project routing: a bridge TypeObject/Signature knows its producing
    // project via its (private) objectRegistry. With several configured
    // projects in one tsserver session, _currentProjectRef may point at a
    // sibling project whose Go-side registry doesn't own this handle — the RPC
    // then dies with "type handle N not found in project registry". Prefer the
    // object's own project when it exposes one.
    function projectForBridgeObject(obj: any): any {
        return obj?.objectRegistry?.project;
    }

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
        const proj = projectForBridgeObject(type) ?? _currentProjectRef.project;
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
        const proj = projectForBridgeObject(type) ?? _currentProjectRef.project;
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
        const proj = projectForBridgeObject(type) ?? _currentProjectRef.project;
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
    // Memoized per checker generation: refineNavSymbol resolves the module
    // parent of ~2k scope symbols per completion, each walking declarations
    // and calling getHostBoundSf per declaration file. Repeating the
    // resolveHostFileName + getScriptVersion + sfCache probe per call burned
    // most of the completion wall. null = confirmed not host-parsed.
    const hostBoundSfMemo = new Map<string, any>();
    const getHostBoundSf = (fileName: string): any | undefined => {
        const memo = hostBoundSfMemo.get(fileName);
        if (memo !== undefined) return memo === null ? undefined : memo;
        // Lib files never take the host-parse path (getOrCreateSourceFile
        // gates preferHostSourceFiles on !isHostLibFile), so probing them
        // here only materializes a tsgo-backed skeleton (readFile +
        // computeLineStarts on lib.dom.d.ts, per generation) to then reject
        // it. Skip the program lookup entirely.
        if (isBundledLibPath(fileName) || isHostLibFile(toHostFileName(fileName))) {
            hostBoundSfMemo.set(fileName, null);
            return undefined;
        }
        // Prefer THIS project's thin program: _hostProgramRef is module-global
        // and tracks the most recently created project. With two configured
        // projects open, routing through the sibling's program misses this
        // project's host-bound .vue files, memoizes null, and refineNavSymbol
        // then returns symbols whose declarations stay remote — FAR identity
        // matching silently finds nothing (refs [] on a self-import).
        const getSourceFile = programCtx?.thinProgram?.getSourceFile
            ?? _hostProgramRef?.getSourceFile
            ?? program.getSourceFile;
        const sf = getSourceFile?.(fileName);
        // Soft-P′ soft-bound disk/node_modules files carry binder fields
        // (ExportSpecifier.symbol) without the overlay identity brand.
        if (!isHostParsedSourceFile(sf)) {
            hostBoundSfMemo.set(fileName, null);
            return undefined;
        }
        hostBoundSfMemo.set(fileName, sf);
        return sf;
    };
    const refineNavSymbol = (sym: any) => {
        if (!sym) return sym;
        const cached = refinedSymBySym.get(sym);
        if (cached !== undefined) return cached;
        // Completion pulls ~1000 getSymbolsInScope globals per keystroke.
        // When host-bound (.vue) files exist, pure lib/ambient symbols with no
        // exportSymbol/Alias and confirmed-no host-bound decls skip Soft-P′ —
        // that was getSourceFile×N. Unresolved decls must take the full path so
        // locals keep stock sortText (symbolHasDeclarationInSourceFile ===).
        if (
            _hasHostBoundFiles
            && isBridgeWireSymbol(sym)
            && !sym.exportSymbol
            && !((sym.flags ?? 0) & SymbolFlags.Alias)
            && bridgeSymbolConfirmedLibOnlyNoHostRemap(sym, getHostBoundSf)
        ) {
            // Pure lib/ambient globals under a vue/host-bound project.
            // Still apply S′: skipping Soft-P′ remap is fine for completion
            // (no host decls), but FAR `getExportInfo` needs `.parent` as the
            // external module (`exportSymbol.parent`). Without S′, package
            // re-exports (vue→reactivity `ref`) lose cross-`.vue` import refs.
            const light = ensureExportedSymbolModuleParent(
                ensureSymbolContextualDocCompat(sym),
                getHostBoundSf,
            );
            refinedSymBySym.set(sym, light);
            return light;
        }
        if (!_hasHostBoundFiles) {
            // Soft-P′ path may lack host-bound remapping, but S′ still applies:
            // numeric exportSymbol must not reach importTracker.getExportInfo.
            const refinedNoHost = ensureExportedSymbolModuleParent(
                ensureClassLikeSymbolDeclarations(ensureSymbolContextualDocCompat(sym)),
                getHostBoundSf,
            );
            refinedSymBySym.set(sym, refinedNoHost);
            return refinedNoHost;
        }
        const refined = ensureClassLikeSymbolDeclarations(
            ensureSymbolContextualDocCompat(refineHostNavigationSymbol(sym, getHostBoundSf)),
        );
        if (_traceSymEnabled) traceSym(`refineNavSymbol in=${traceSymSymbol(sym)} out=${traceSymSymbol(refined)}`);
        refinedSymBySym.set(sym, refined);
        return refined;
    };

    // Stock checker.getSymbolAtLocation keyword switch: most keywords →
    // undefined; Function/Class/Default/=> resolve via parent declaration.
    // Returns:
    //   { action:"continue" }           — not keyword-governed; keep looking up
    //   { action:"undefined" }          — stock returns undefined
    //   { action:"redirect", node }     — continue lookup with this node instead
    //   { action:"symbol", symbol }     — already resolved
    function classifyKeywordSymbolLookup(node: any):
        | { action: "continue" }
        | { action: "undefined" }
        | { action: "redirect"; node: any }
        | { action: "symbol"; symbol: any } {
        const kind = node?.kind;
        switch (kind) {
            case SyntaxKind.DefaultKeyword:
            case SyntaxKind.FunctionKeyword:
            case SyntaxKind.EqualsGreaterThanToken:
            case SyntaxKind.ClassKeyword: {
                const parent = node.parent;
                if (!parent) return { action: "undefined" };
                // Prefer the declaration name so Soft-P′ remapping / host identity
                // matches Identifier lookups. parent.symbol can retain RemoteSourceFile
                // decls that FAR filters out under documentHighlights filesToSearch.
                if (parent.name && parent.name !== node) return { action: "redirect", node: parent.name };
                if (parent.symbol) return { action: "symbol", symbol: parent.symbol };
                return { action: "undefined" };
            }
            case SyntaxKind.ConstructorKeyword: {
                const ctor = node.parent;
                if (ctor?.kind === SyntaxKind.Constructor && ctor.parent?.symbol) {
                    return { action: "symbol", symbol: ctor.parent.symbol };
                }
                return { action: "undefined" };
            }
            case SyntaxKind.ExportKeyword: {
                if (node.parent?.kind === SyntaxKind.ExportAssignment && node.parent.symbol) {
                    return { action: "symbol", symbol: node.parent.symbol };
                }
                return { action: "undefined" };
            }
            // This / Super / InstanceOf / MetaProperty need the expression /
            // special paths below — do not short-circuit.
            case SyntaxKind.ThisKeyword:
            case SyntaxKind.SuperKeyword:
            case SyntaxKind.ThisType:
            case SyntaxKind.InstanceOfKeyword:
            case SyntaxKind.MetaProperty:
                return { action: "continue" };
            // Stock: ImportKeyword/NewKeyword resolve only as meta-property
            // keywords (import.meta / new.target); an ImportDeclaration's
            // `import` keyword is undefined, not the module symbol.
            case SyntaxKind.ImportKeyword:
            case SyntaxKind.NewKeyword:
                return node.parent?.kind === SyntaxKind.MetaProperty
                    ? { action: "continue" }
                    : { action: "undefined" };
            // Interpolation punctuation spans (`...${`, `}...${`, `}...`):
            // stock's switch has no case for these tokens → undefined.
            // Positional RPC would latch onto the neighboring interpolated
            // identifier ((parameter) id at a `${` span).
            case SyntaxKind.TemplateHead:
            case SyntaxKind.TemplateMiddle:
            case SyntaxKind.TemplateTail:
                return { action: "undefined" };
            // `{` (object literal braces): stock's switch has no OpenBraceToken
            // case → default undefined. Positional RPC resolves the brace of an
            // export-assigned object literal to the `default` symbol, which made
            // go-to-def on `defineComponent({...})` include the local
            // export-assignment statement as an extra definition.
            case SyntaxKind.OpenBraceToken:
                return { action: "undefined" };
            // JSDocComment only (not the whole FirstJSDocNode..LastJSDocNode
            // range): stock returns undefined for the comment container, and
            // allowing positional/cache hits here poisons quickinfo inside
            // param JSDoc (`/** left */ a`) after an earlier probe warms
            // symByPos. Broader JSDoc* short-circuit breaks component-meta
            // (JSDoc type/tag nodes still need normal resolution).
            case SyntaxKind.JSDocComment:
                return { action: "undefined" };
            default:
                // Remaining keywords (extends, as, type, interface, …): stock
                // default branch returns undefined. Blocking positional RPC here
                // is what restores find-refs asserts + quickinfo empty parity.
                if (typeof kind === "number"
                    && kind >= SyntaxKind.FirstKeyword
                    && kind <= SyntaxKind.LastKeyword) {
                    return { action: "undefined" };
                }
                return { action: "continue" };
        }
    }

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
            // Stock (checker.ts:1714-1716): getParseTreeNode(nodeIn) then
            // getTypeOfNode, else errorType. Walk original before position map.
            return memoGet(nodeTypeCache, node, () => {
                const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
                const tsgoNode = resolveHostNodeToTsgo(node);
                if (!tsgoNode) {
                    // Stock returns errorType (TypeFlags.Any intrinsic "error").
                    // Prefer getErrorType when wired; else getAnyType (same flags).
                    const fallback = typeof project.checker.getErrorType === "function"
                        ? project.checker.getErrorType()
                        : project.checker.getAnyType?.();
                    if (process.env.TSGO_PROFILE === "1") { const d = Date.now() - t0; _stats.queryCount++; _stats.queryMs += d; _stats.getTypeCount++; _stats.getTypeMs += d; }
                    return fallback;
                }
                const r = computeGetTypeAtLocation(tsgoNode);
                if (process.env.TSGO_PROFILE === "1") { const d = Date.now() - t0; _stats.queryCount++; _stats.queryMs += d; _stats.getTypeCount++; _stats.getTypeMs += d; }
                return r;
            });
        },
        getSymbolAtLocation(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            // Stock resolves `a.b` to the symbol of `b`
            // (getSymbolOfNameOrPropertyAccessExpression). Query the name node
            // for the whole pipeline — the position-keyed symbol cache stores
            // identifier entries, so probing with the whole-node span would hit
            // the LHS identifier that shares the node's start position (e.g.
            // signatureHelp call-target `ctx.withThis` displaying `ctx`).
            if (node.kind === SyntaxKind.PropertyAccessExpression && node.name?.getSourceFile) {
                node = node.name;
            }
            const lookupNode = node;
            const finish = (sym: any) => gateExternalModuleSymbolLookup(lookupNode, sym);
            // Stock checker.getSymbolAtLocation (switch on node.kind): most
            // keywords return undefined; a few resolve via the parent
            // declaration. Never "symbol at this text position" — positional
            // RPC would latch onto a neighboring identifier (ExtendsKeyword →
            // type param T; AsKeyword / export / type → decl name), which
            // breaks find-all-refs Debug.asserts and quickinfo empty-result
            // parity with stock.
            const kw = classifyKeywordSymbolLookup(node);
            if (kw.action === "undefined") return undefined;
            if (kw.action === "symbol") return finish(refineNavSymbol(kw.symbol));
            if (kw.action === "redirect") node = kw.node;
            // Stock getSymbolAtLocation switch: NamedTupleMember falls through to
            // default → undefined. Positional RPC on the member span (`value: T`)
            // latches onto the element-type identifier (type param T); SymbolDisplay
            // then sets kind="type parameter" with empty displayParts (Type meaning
            // absent at the NamedTupleMember location). QI should use the type
            // fallback path → displayString "T" like stock.
            if (node.kind === SyntaxKind.NamedTupleMember) {
                return undefined;
            }
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
            // first statement (e.g. the codegen export const) which lacks the default export.
            if (node.kind === SyntaxKind.SourceFile && sf.symbol) {
                // Return the module symbol directly. Do NOT write symByPos here:
                // this whole-file symbol has no single span, and caching it under
                // position 0 would poison lookups for any real node at pos 0.
                // This branch already short-circuits every SourceFile query, so a
                // cache is unnecessary anyway.
                // Do not refineNavSymbol here — resolveHostExportDefaultSymbol would
                // replace the module symbol with the codegen export const, breaking
                // getExportsOfModule (component-meta needs the module + default export).
                if (_traceSymEnabled) traceSym(`getSymbolAtLocation return path=sourcefile sym=${traceSymSymbol(sf.symbol)}`);
                return finish(sf.symbol);
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
            // Always run refineNavSymbol (remap + canonicalizeSymbolToHostIdentity):
            // returning raw rpc-canonical locals while getRootSymbols() refinesthem
            // to host identity makes search.includes(root) fail (destruct refs /
            // extract free-var).
            if (_hasHostBoundFiles && sf.__tnbHostBound && !isCrossFileImportExportName(node)) {
                const hostSym = getHostBoundSymbolAtLocation(node);
                if (hostSym) {
                    // Prefer tsgo bridge identity when available so FAR
                    // search.includes / getRelatedSymbol stay coherent across
                    // import (RPC) ↔ local (host-first) sites. Preferring bare
                    // host SymbolObject here made fromUse miss the def span
                    // (bridge root ≠ host binder). S′ is restored by
                    // refineNavSymbol → ensureExportedSymbolModuleParent
                    // (numeric exportSymbol cleared/resolved; parent = host
                    // module symbol matching moduleSpecifier getSymbolAtLocation).
                    const rpcSym = resolveRpcSymbol(hostSym);
                    const refined = refineNavSymbol(rpcSym ?? hostSym);
                    storeSymCache(cacheName, start, end, refined);
                    recordHit();
                    if (_traceSymEnabled) {
                        traceSym(
                            `getSymbolAtLocation return path=host-first `
                            + `source=${rpcSym ? "rpc-canonical" : "host-only"} `
                            + `sym=${traceSymSymbol(refined)}`,
                        );
                    }
                    return finish(refined);
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
                return finish(sym);
            };
            let cached = probeSymCache(cacheName, start, end);
            if (cached.found) {
                recordHit();
                if (_traceSymEnabled) traceSym(`getSymbolAtLocation return path=cache sym=${traceSymSymbol(cached.sym)}`);
                return finish(cached.sym);
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
                        return finish(cached.sym);
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
            {
                const cached = probeSymCache(cacheName, start, end);
                if (cached.found) {
                    recordHit();
                    if (_traceSymEnabled) traceSym(`getSymbolAtLocation return path=cache sym=${traceSymSymbol(cached.sym)}`);
                    return finish(cached.sym);
                }
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
            // Stock's TypeChecker.getTypeOfSymbolAtLocation always returns a Type
            // (never undefined). Returning undefined lets tryGetReturnTypeOfFunction
            // crash on `type.symbol` (cluster E: typeDefinition at `return`).
            // getErrorType/getAnyType can also be unavailable before checker
            // intrinsics are wired (cold prefix) — synthesize a minimal Any.
            const errorOrAny = (): any => {
                let fallback: any;
                try {
                    fallback = typeof project.checker.getErrorType === "function"
                        ? project.checker.getErrorType()
                        : project.checker.getAnyType?.();
                } catch { fallback = undefined; }
                if (fallback) {
                    fixupType(fallback);
                    return fallback;
                }
                // Last resort: object shaped enough for tryGetReturnTypeOfFunction
                // (`type.symbol === …`) and definitionFromType (`t.symbol && …`).
                const TF = sync.TypeFlags;
                return {
                    flags: TF?.Any ?? 1,
                    symbol: undefined,
                    getFlags() { return this.flags; },
                    getSymbol() { return undefined; },
                    getCallSignatures() { return []; },
                    getConstructSignatures() { return []; },
                    getProperties() { return []; },
                    getProperty() { return undefined; },
                    getApparentProperties() { return []; },
                    getStringIndexType() { return undefined; },
                    getNumberIndexType() { return undefined; },
                    getBaseTypes() { return []; },
                    isUnion() { return false; },
                    isIntersection() { return false; },
                    isLiteral() { return false; },
                    isStringLiteral() { return false; },
                    isNumberLiteral() { return false; },
                    isTypeParameter() { return false; },
                    isClassOrInterface() { return false; },
                    isClass() { return false; },
                };
            };
            const sf = location?.getSourceFile?.();
            if (sf) {
                let start: number | undefined;
                let end: number | undefined;
                try {
                    start = location.getStart(sf);
                    end = location.getEnd(sf);
                } catch { /* fall through */ }
                if (typeof start === "number") {
                    try {
                        const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, location.kind, end);
                        if (_traceSymEnabled) traceSym(`getTypeOfSymbolAtLocation sym=${traceSymSymbol(symbol)} locKind=${location.kind} start=${start} hit=${!!tsgoNode} hitKind=${tsgoNode?.kind}`);
                        if (tsgoNode) {
                            const t = rpc().getTypeOfSymbolAtLocation(symbol, tsgoNode);
                            if (_traceSymEnabled) traceSym(`getTypeOfSymbolAtLocation rpc-result flags=${t?.flags} id=${t?.id}`);
                            if (t) { fixupType(t); return t; }
                        }
                    } catch (e) {
                        if (_traceSymEnabled) traceSym(`getTypeOfSymbolAtLocation rpc-throw ${String((e as any)?.message ?? e).split("\n")[0]}`);
                        /* fall through to errorType */
                    }
                }
            }
            // Auto-import completion entries may query export symbols at virtual-doc
            // locations where the host AST node has no tsgo mirror yet — fall back
            // to the location-independent type.
            if (typeof project.checker.getTypeOfSymbol === "function") {
                try {
                    const t = rpc().getTypeOfSymbol(symbol);
                    if (t) { fixupType(t); return t; }
                } catch { /* fall through to errorType */ }
            }
            return errorOrAny();
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
        // Signature help uses CheckMode.IsForSignatureHelp + cache clear — not
        // the ordinary getResolvedSignature RPC. Stock fills candidatesOutArray
        // as a side effect; we push into the caller-supplied array and return
        // the resolved signature.
        getResolvedSignatureForSignatureHelp(node: any, candidatesOutArray?: any[], argumentCount?: number): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            const { resolved, candidates } = project.checker.getResolvedSignatureForSignatureHelp(tsgoNode, argumentCount);
            if (candidatesOutArray) {
                candidatesOutArray.length = 0;
                for (const c of candidates) candidatesOutArray.push(c);
            }
            return resolved;
        },
        getExpandedParameters(signature: any, skipUnionExpanding?: boolean): any {
            if (!signature) return [];
            ensureProject();
            return project.checker.getExpandedParameters(signature, skipUnionExpanding);
        },
        hasEffectiveRestParameter(signature: any): boolean {
            if (!signature) return false;
            ensureProject();
            return project.checker.hasEffectiveRestParameter(signature);
        },
        getContextualTypeForObjectLiteralElement(element: any, _contextFlags?: number): any {
            if (!element) return undefined;
            ensureProject();
            const sf = element.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, element.getStart(sf), element.kind, element.getEnd(sf));
            if (!tsgoNode) return undefined;
            // LS callers omit flags; Go defaults to ContextFlagsNone.
            const t = project.checker.getContextualTypeForObjectLiteralElement(tsgoNode, 0);
            if (t) fixupType(t);
            return t;
        },
        // signatureHelp / convertParamsToDestructuredObject: parameter optionality.
        // Host ParameterDeclaration → tsgo mirror (same mapping as isDeclarationVisible).
        isOptionalParameter(node: any): boolean {
            if (!node) return false;
            const sf = node.getSourceFile?.();
            if (!sf?.fileName) return false;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = node.getStart(sf);
                end = node.getEnd(sf);
            } catch { return false; }
            if (typeof start !== "number") return false;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
            if (!tsgoNode || tsgoNode.kind !== node.kind) return false;
            return !!project.checker.isOptionalParameter(tsgoNode);
        },
        // symbolDisplay / references: whether a signature decl is the overload
        // implementation body. Host SignatureDeclaration → tsgo mirror.
        isImplementationOfOverload(node: any): boolean {
            if (!node) return false;
            const sf = node.getSourceFile?.();
            if (!sf?.fileName) return false;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = node.getStart(sf);
                end = node.getEnd(sf);
            } catch { return false; }
            if (typeof start !== "number") return false;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
            if (!tsgoNode || tsgoNode.kind !== node.kind) return false;
            return !!project.checker.isImplementationOfOverload(tsgoNode);
        },
        // SymbolDisplay / references: enum member constant value (e.g.
        // "(enum member) Color.Red = 1"). Host AST nodes must be mapped to
        // tsgo RemoteNode — bare getConstantValue RPC dies in getNodeId.
        getConstantValue(node: any): string | number | undefined {
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
            if (!tsgoNode || tsgoNode.kind !== node.kind) return undefined;
            try {
                return project.checker.getConstantValue(tsgoNode);
            } catch { return undefined; }
        },
        // SymbolDisplay resolves a type parameter's owning signature from its
        // declaration ("(type parameter) T in pick<...>"). Declarations reaching
        // here are JS-side AST nodes (post declaration-remap); map to the tsgo
        // mirror before the RPC, same as getResolvedSignature above.
        getSignatureFromDeclaration(declaration: any): any {
            if (!declaration) return undefined;
            ensureProject();
            // Stock (checker.ts:1796-1798): getParseTreeNode(declarationIn, isFunctionLike).
            const tsgoNode = resolveHostNodeToTsgo(declaration, isFunctionLike);
            if (!tsgoNode) return undefined;
            return project.checker.getSignatureFromDeclaration(tsgoNode);
        },
        getTypeFromTypeNode(typeNode: any): any {
            // Host type nodes (e.g. async return annotations) must be mapped to
            // RemoteNode before the RPC — getNodeId requires a tsgo node.
            ensureProject();
            let node = typeNode;
            if (typeNode && typeof typeNode.getStart === "function") {
                const sf = typeNode.getSourceFile?.();
                if (sf?.fileName) {
                    let start: number | undefined;
                    let end: number | undefined;
                    try {
                        start = typeNode.getStart(sf);
                        end = typeNode.getEnd(sf);
                    } catch { /* ignore */ }
                    if (typeof start === "number") {
                        const mapped = findTsgoNodeAtPosition(sf.fileName, start, typeNode.kind, end);
                        if (mapped) node = mapped;
                    }
                }
            }
            const t = project.checker.getTypeFromTypeNode(node);
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

        // Host enclosingDeclaration → tsgo mirror (getNodeId needs RemoteNode).
        // Decoded RemoteNode is hostified so factory/textChanges can mutate pos.
        typeToTypeNode(type: any, enclosingDeclaration?: any, flags?: number): any {
            if (!type) return undefined;
            ensureProject();
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            const typeNode = project.checker.typeToTypeNode(type, tsgoLocation, flags);
            if (!typeNode) return undefined;
            attachTypeReferenceSymbols(project.checker, type, typeNode);
            // Same MultilineObjectLiterals gate as writeType (stock NodeBuilder).
            // hostifyDecodedTypeNode re-parses via a single-line string writer for
            // mutable AST; emit flags still matter for callers that print before hostify.
            applyWriteTypeEmitFlagsForFormat(typeNode, flags);
            return hostifyDecodedTypeNode(typeNode);
        },
        // Stock typeToString → NodeBuilder uses enclosingDeclaration for
        // alias/`typeof`/indexed-access reuse (UseAliasDefinedOutsideCurrentScope
        // alone is not enough for annotation reuse). Map host → tsgo mirror.
        typeToString(type: any, enclosing?: any, flags?: number): string {
            ensureProject();
            const tsgoLocation = mapHostEnclosingToTsgo(enclosing);
            return project.checker.typeToString(type, tsgoLocation, flags);
        },
        // SymbolDisplay formats type-parameter-typed variables via the checker
        // nodebuilder ("const row: Row extends BaseRow"). The tsgo RPC decodes
        // the built declaration node; host-bound enclosing declarations are
        // mapped to their tsgo mirror (name resolution scope), else omitted.
        typeParameterToDeclaration(parameter: any, enclosingDeclaration?: any, flags?: number): any {
            if (!parameter) return undefined;
            ensureProject();
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            const node = project.checker.typeParameterToDeclaration(parameter, tsgoLocation, flags);
            if (node?.name && parameter?.symbol) {
                node.name.symbol = parameter.symbol;
            }
            return applySingleLineEmitFlagsToDeclaration(node);
        },
        applySingleLineEmitFlags(node: any): any {
            return applySingleLineEmitFlagsRecursive(node);
        },
        // SymbolDisplay renders "interface Wrap<W>" / "type Pair<P> = ..." by
        // asking for the symbol's type parameter declarations and printing them
        // as a list. Symbols reaching here can be host binder symbols (post
        // declaration-remap); resolve to the tsgo counterpart first. The printer
        // only needs an array with NodeArray shape (pos/end/hasTrailingComma).
        symbolToTypeParameterDeclarations(symbol: any, enclosingDeclaration?: any, flags?: number): any {
            if (!symbol) return undefined;
            ensureProject();
            const rpcSym = resolveRpcSymbol(symbol);
            if (!rpcSym) return undefined;
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            const nodes = project.checker.symbolToTypeParameterDeclarations(rpcSym, tsgoLocation, flags) ?? [];
            const list: any = nodes.slice();
            list.pos = -1;
            list.end = -1;
            list.hasTrailingComma = false;
            return list;
        },
        // signatureHelp itemInfoForParameters builds ParameterDeclaration nodes
        // via symbolToParameterDeclaration. Host symbols → resolveRpcSymbol;
        // enclosingDeclaration is host-bound → map to tsgo mirror.
        symbolToParameterDeclaration(symbol: any, enclosingDeclaration?: any, flags?: number): any {
            if (!symbol) return undefined;
            ensureProject();
            const rpcSym = resolveRpcSymbol(symbol);
            if (!rpcSym) return undefined;
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            const node = project.checker.symbolToParameterDeclaration(rpcSym, tsgoLocation, flags);
            if (node?.type) {
                let typeParams: readonly any[] | undefined;
                const paramDecl = rpcSym.valueDeclaration ?? rpcSym.declarations?.[0];
                const parent = paramDecl?.parent;
                if (parent) {
                    const sf = parent.getSourceFile?.();
                    if (sf?.fileName) {
                        const tsgoParent = findTsgoNodeAtPosition(sf.fileName, parent.getStart(sf), parent.kind, parent.getEnd(sf));
                        if (tsgoParent) {
                            const sig = project.checker.getSignatureFromDeclaration(tsgoParent);
                            typeParams = sig?.typeParameters ?? sig?.target?.typeParameters;
                            if (typeParams) for (const t of typeParams) fixupType(t);
                        }
                    }
                }
                attachTypeParameterNameSymbols(node.type, typeParams);
            }
            return applySingleLineEmitFlagsToDeclaration(node);
        },
        getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(symbol: any): any {
            if (!symbol) return undefined;
            ensureProject();
            const rpcSym = resolveRpcSymbol(symbol);
            if (!rpcSym) return undefined;
            const tps = project.checker.getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(rpcSym);
            if (!tps) return undefined;
            for (const t of tps) fixupType(t);
            return tps;
        },
        // Stock checker exposes writer-based emitters consumed by the services
        // displayParts builders (typeToDisplayParts/symbolToDisplayParts/
        // signatureToDisplayParts → quickInfo, references symbolDisplayString).
        // tsgo has no writer RPC; build a TypeNode via typeToTypeNode and print
        // with the host printer so DisplayPartsSymbolWriter gets keyword/punct
        // kinds (signatureHelp return-type suffix, quickInfo, etc.).
        //
        // Stock signature: writeType(type, enclosing, flags, writer, maximumLength,
        // verbosityLevel, out). Convert flags like typeToString; see
        // toWriteTypeNodeBuilderFlags. verbosityLevel requires VerbosityContext on
        // the Go NodeBuilder — not available over typeToTypeNode RPC → (b).
        writeType(
            type: any,
            enclosingDeclaration?: any,
            flags?: number,
            writer?: any,
            maximumLength?: number,
            _verbosityLevel?: number,
            _out?: any,
        ): void {
            if (!type || !writer) return;
            ensureProject();
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            const nodeBuilderFlags = toWriteTypeNodeBuilderFlags(flags, maximumLength);
            const typeNode = project.checker.typeToTypeNode(type, tsgoLocation, nodeBuilderFlags);
            if (typeNode) {
                attachTypeParameterSymbolsFromType(type, typeNode);
                attachTypeReferenceSymbols(project.checker, type, typeNode);
                applyWriteTypeEmitFlagsForFormat(typeNode, flags);
                const sourceFile = enclosingDeclaration?.getSourceFile?.();
                getRemoveCommentsPrinter().writeNode(EmitHint.Unspecified, typeNode, sourceFile, writer);
                return;
            }
            // typeToString RPC → typeToStringEx (IgnoreErrors + TypeFormatFlags). Verbosity /
            // MaxTruncationLength still unavailable over RPC → (b).
            const text = project.checker.typeToString(type, tsgoLocation, flags) ?? "";
            writeTypeTextFallback(writer, text);
        },
        writeTypePredicate(predicate: any, enclosingDeclaration?: any, flags?: number, writer?: any): void {
            if (!predicate || !writer) return;
            ensureProject();
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            const typeNode = predicate.type
                ? project.checker.typeToTypeNode(predicate.type, tsgoLocation, flags)
                : undefined;
            const predicateNode = bridgeTypePredicateToHostNode(predicate, typeNode);
            const sourceFile = enclosingDeclaration?.getSourceFile?.();
            getRemoveCommentsPrinter().writeNode(EmitHint.Unspecified, predicateNode, sourceFile, writer);
        },
        typePredicateToString(predicate: any, enclosingDeclaration?: any, flags?: number): string {
            if (!predicate) return "";
            return usingSingleLineStringWriter(writer => checkerProxyRef.writeTypePredicate(predicate, enclosingDeclaration, flags, writer));
        },
        writeSymbol(symbol: any, enclosing?: any, _meaning?: number, flags?: number, writer?: any): void {
            if (!symbol || !writer) return;
            const text = symbolToStringWithChain(symbol, enclosing, flags, getHostBoundSf);
            if (text) writer.writeSymbol?.(text, symbol);
        },
        // Stock writeSignature → signatureToString(enclosing, flags, kind, writer,
        // maximumLength, verbosityLevel, out). Map enclosing; pass kind so
        // call-style is preserved (see signatureToString). Accept but do not
        // invent truncation flags for maximumLength — VerbosityContext is (b).
        writeSignature(
            signature: any,
            enclosing?: any,
            flags?: number,
            kind?: any,
            writer?: any,
            _maximumLength?: number,
            _verbosityLevel?: number,
            _out?: any,
        ): void {
            if (!signature || !writer) return;
            ensureProject();
            // Accept maximumLength/verbosityLevel for stock signature parity; RPC
            // signatureToString has no VerbosityContext → density tracked as (b).
            const text = checkerProxyRef.signatureToString(signature, enclosing, flags, kind) ?? "";
            if (text) writer.write?.(text);
        },
        // tsgo has no symbolToString/getFullyQualifiedName RPC. Stock semantics
        // for the common LS consumers (renameInfo displayName/fullDisplayName,
        // definition names) reduce to the unescaped symbol name qualified by
        // the parent chain — both symbol kinds (host SymbolObject and bridge
        // Symbol) carry name/parent, so this is served uniformly in JS.
        symbolToString(symbol: any, enclosing?: any, _meaning?: number, flags?: number): string {
            return symbolToStringWithChain(symbol, enclosing, flags, getHostBoundSf);
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
        signatureToString(signature: any, enclosingDeclaration?: any, flags?: number, kind?: number): string {
            ensureProject();
            if (!signature || typeof signature.id !== "number") return "";
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            // Stock: ConstructSignature only when kind===SignatureKind.Construct.
            // tsgo: Construct when signature.flags&Construct unless WriteCallStyleSignature.
            // Services signatureToDisplayParts always passes kind=undefined → call style.
            let effectiveFlags = flags ?? 0;
            if (kind !== SignatureKindConstruct) {
                effectiveFlags |= TypeFormatFlagsWriteCallStyleSignature;
            }
            return project.checker.signatureToString(signature, tsgoLocation, effectiveFlags) ?? "";
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
            if (!signature) return undefined;
            try {
                const t = project.checker.getReturnTypeOfSignature(signature);
                if (t) {
                    fixupType(t);
                    // Some tsgo return types omit `.symbol`; definitionFromType
                    // and tryGetReturnTypeOfFunction read it. Ensure the property
                    // exists (value may still be undefined).
                    if (!("symbol" in t)) {
                        try {
                            const sym = typeof t.getSymbol === "function" ? t.getSymbol() : undefined;
                            Object.defineProperty(t, "symbol", {
                                configurable: true,
                                enumerable: true,
                                writable: true,
                                value: sym,
                            });
                        } catch { /* best-effort */ }
                    }
                    return t;
                }
            } catch { /* fall through */ }
            return undefined;
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
        // goToDefinition / references / rename: index-signature infos at a
        // property-access name. Host Identifier → tsgo mirror; undefined vs []
        // must match stock (non-PA-name → undefined).
        getIndexInfosAtLocation(node: any): readonly any[] | undefined {
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
            if (!tsgoNode || tsgoNode.kind !== node.kind) return undefined;
            const infos = project.checker.getIndexInfosAtLocation(tsgoNode);
            // Stock returns undefined (not []) for non-PA-name; preserve that.
            if (infos == null) return undefined;
            // Declaration NodeHandles carry .symbol from IndexInfoResponse.symbol
            // (attached in native-preview materializeIndexInfo). Resolve to RemoteNode
            // so createDefinitionFromSignatureDeclaration can read positions/name.
            return infos.map((info: any) => {
                const decl = info?.declaration;
                if (decl && typeof decl.resolve === "function") {
                    const resolved = decl.resolve(project);
                    if (resolved) {
                        if (decl.symbol && !resolved.symbol) {
                            Object.defineProperty(resolved, "symbol", { value: decl.symbol, configurable: true });
                        }
                        return { ...info, declaration: resolved };
                    }
                }
                return info;
            });
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
        // ── Type/Symbol query batch (22 methods) ──
        getAwaitedType(type: any): any {
            ensureProject();
            if (!type) return undefined;
            const t = project.checker.getAwaitedType(type);
            if (t) fixupType(t);
            return t;
        },
        getNullableType(type: any, flags: number): any {
            ensureProject();
            if (!type) return type;
            const t = project.checker.getNullableType(type, flags);
            if (t) fixupType(t);
            return t;
        },
        isNullableType(type: any): boolean {
            ensureProject();
            if (!type) return false;
            return !!project.checker.isNullableType(type);
        },
        getElementTypeOfArrayType(type: any): any {
            ensureProject();
            if (!type) return undefined;
            const t = project.checker.getElementTypeOfArrayType(type);
            if (t) fixupType(t);
            return t;
        },
        getIndexInfoOfType(type: any, kind: number): any {
            ensureProject();
            if (!type) return undefined;
            const info = project.checker.getIndexInfoOfType(type, kind);
            if (!info) return undefined;
            // Stock IndexInfo.type; bridge materializeIndexInfo uses valueType.
            const typeField = info.type ?? info.valueType;
            if (typeField) fixupType(typeField);
            if (info.keyType) fixupType(info.keyType);
            const decl = info?.declaration;
            if (decl && typeof decl.resolve === "function") {
                const resolved = decl.resolve(project);
                if (resolved) {
                    if (decl.symbol && !resolved.symbol) {
                        Object.defineProperty(resolved, "symbol", { value: decl.symbol, configurable: true });
                    }
                    return { ...info, type: typeField, valueType: info.valueType ?? typeField, declaration: resolved };
                }
            }
            return { ...info, type: typeField, valueType: info.valueType ?? typeField };
        },
        getIndexTypeOfType(type: any, kind: number): any {
            ensureProject();
            if (!type) return undefined;
            const t = project.checker.getIndexTypeOfType(type, kind);
            if (t) fixupType(t);
            return t;
        },
        getTypeOfPropertyOfType(type: any, name: string): any {
            ensureProject();
            if (!type || typeof name !== "string") return undefined;
            const t = project.checker.getTypeOfPropertyOfType(type, name);
            if (t) fixupType(t);
            return t;
        },
        getTypeOfPropertyOfContextualType(type: any, name: string): any {
            ensureProject();
            if (!type || typeof name !== "string") return undefined;
            const t = project.checker.getTypeOfPropertyOfContextualType(type, name);
            if (t) fixupType(t);
            return t;
        },
        fillMissingTypeArguments(
            typeArguments: readonly any[],
            typeParameters: readonly any[] | undefined,
            minTypeArgumentCount: number,
            isJavaScriptImplicitAny: boolean,
        ): any[] {
            ensureProject();
            const results = project.checker.fillMissingTypeArguments(
                typeArguments ?? [],
                typeParameters,
                minTypeArgumentCount,
                !!isJavaScriptImplicitAny,
            );
            if (results) for (const t of results) if (t) fixupType(t);
            return results ?? [];
        },
        getWidenedLiteralType(type: any): any {
            ensureProject();
            if (!type) return type;
            const t = project.checker.getWidenedLiteralType(type);
            if (t) fixupType(t);
            return t;
        },
        // Stock returns IterableIterator; array is for-of compatible.
        getUnmatchedProperties(
            source: any,
            target: any,
            requireOptionalProperties: boolean,
            matchDiscriminantProperties: boolean,
        ): any[] {
            ensureProject();
            if (!source || !target) return [];
            return project.checker.getUnmatchedProperties(
                source,
                target,
                !!requireOptionalProperties,
                !!matchDiscriminantProperties,
            ) ?? [];
        },
        isEmptyAnonymousObjectType(type: any): boolean {
            ensureProject();
            if (!type) return false;
            return !!project.checker.isEmptyAnonymousObjectType(type);
        },
        isLibType(type: any): boolean {
            ensureProject();
            if (!type) return false;
            return !!project.checker.isLibType(type);
        },
        symbolIsValue(symbol: any): boolean {
            if (!symbol) return false;
            ensureProject();
            try { return !!rpc().symbolIsValue(symbol); } catch { return false; }
        },
        // Go export takes the parameter node only; enclosing is unused on the RPC.
        requiresAddingImplicitUndefined(node: any, _enclosing?: any): boolean {
            if (!node) return false;
            const sf = node.getSourceFile?.();
            if (!sf?.fileName) return false;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = node.getStart(sf);
                end = node.getEnd(sf);
            } catch { return false; }
            if (typeof start !== "number") return false;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
            if (!tsgoNode || tsgoNode.kind !== node.kind) return false;
            return !!project.checker.requiresAddingImplicitUndefined(tsgoNode);
        },
        getTypeOnlyAliasDeclaration(symbol: any): any {
            if (!symbol) return undefined;
            ensureProject();
            try {
                const handle = rpc().getTypeOnlyAliasDeclaration(symbol);
                if (!handle) return undefined;
                if (typeof handle.resolve === "function") {
                    const resolved = handle.resolve(project);
                    if (resolved) return resolved;
                }
                return handle;
            } catch { return undefined; }
        },
        resolveExternalModuleName(moduleSpecifier: any): any {
            if (!moduleSpecifier) return undefined;
            const sf = moduleSpecifier.getSourceFile?.();
            if (!sf?.fileName) return undefined;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = moduleSpecifier.getStart(sf);
                end = moduleSpecifier.getEnd(sf);
            } catch { return undefined; }
            if (typeof start !== "number") return undefined;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, moduleSpecifier.kind, end);
            if (!tsgoNode) return undefined;
            try {
                return refineNavSymbol(project.checker.resolveExternalModuleName(tsgoNode));
            } catch { return undefined; }
        },
        getPropertySymbolOfDestructuringAssignment(location: any): any {
            if (!location) return undefined;
            const sf = location.getSourceFile?.();
            if (!sf?.fileName) return undefined;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = location.getStart(sf);
                end = location.getEnd(sf);
            } catch { return undefined; }
            if (typeof start !== "number") return undefined;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, location.kind, end);
            if (!tsgoNode) return undefined;
            try {
                return refineNavSymbol(project.checker.getPropertySymbolOfDestructuringAssignment(tsgoNode));
            } catch { return undefined; }
        },
        isSymbolAccessible(
            symbol: any,
            enclosingDeclaration: any,
            meaning: number,
            shouldComputeAliasesToMakeVisible: boolean,
        ): { accessibility: number; errorSymbolName?: string; errorModuleName?: string } {
            if (!symbol) return { accessibility: 3 /* NotResolved */ };
            ensureProject();
            const rpcSym = resolveRpcSymbol(symbol) ?? (isTsgoBridgeSymbol(symbol) ? symbol : undefined);
            if (!rpcSym) return { accessibility: 3 /* NotResolved */ };
            const tsgoEnclosing = mapHostEnclosingToTsgo(enclosingDeclaration);
            try {
                return project.checker.isSymbolAccessible(
                    rpcSym,
                    tsgoEnclosing,
                    meaning >>> 0,
                    !!shouldComputeAliasesToMakeVisible,
                ) ?? { accessibility: 0 };
            } catch {
                return { accessibility: 3 /* NotResolved */ };
            }
        },
        getIndexInfosOfIndexSymbol(indexSymbol: any, siblingSymbols?: readonly any[]): any[] {
            if (!indexSymbol) return [];
            ensureProject();
            const rpcSym = resolveRpcSymbol(indexSymbol) ?? (isTsgoBridgeSymbol(indexSymbol) ? indexSymbol : undefined);
            if (!rpcSym) return [];
            let siblings: any[] | undefined;
            if (siblingSymbols?.length) {
                siblings = [];
                for (const s of siblingSymbols) {
                    const r = resolveRpcSymbol(s) ?? (isTsgoBridgeSymbol(s) ? s : undefined);
                    if (r) siblings.push(r);
                }
            }
            let infos: any[] | undefined;
            try {
                infos = project.checker.getIndexInfosOfIndexSymbol(rpcSym, siblings);
            } catch { return []; }
            if (!infos) return [];
            return infos.map((info: any) => {
                const typeField = info?.type ?? info?.valueType;
                if (typeField) fixupType(typeField);
                if (info?.keyType) fixupType(info.keyType);
                const decl = info?.declaration;
                if (decl && typeof decl.resolve === "function") {
                    const resolved = decl.resolve(project);
                    if (resolved) {
                        if (decl.symbol && !resolved.symbol) {
                            Object.defineProperty(resolved, "symbol", { value: decl.symbol, configurable: true });
                        }
                        return { ...info, type: typeField, valueType: info.valueType ?? typeField, declaration: resolved };
                    }
                }
                return { ...info, type: typeField, valueType: info?.valueType ?? typeField };
            });
        },
        containsArgumentsReference(node: any): boolean {
            if (!node) return false;
            const sf = node.getSourceFile?.();
            if (!sf?.fileName) return false;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = node.getStart(sf);
                end = node.getEnd(sf);
            } catch { return false; }
            if (typeof start !== "number") return false;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
            if (!tsgoNode || tsgoNode.kind !== node.kind) return false;
            return !!project.checker.containsArgumentsReference(tsgoNode);
        },
        getAugmentedPropertiesOfType(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            return project.checker.getAugmentedPropertiesOfType(type) ?? [];
        },
        getSuggestedSymbolForNonexistentProperty(name: any, containingType: any): any {
            if (!name || !containingType) return undefined;
            ensureProject();
            // Stock accepts MemberName | string; Go takes *ast.Node. LS always passes a node.
            if (typeof name === "string") return undefined;
            const sf = name.getSourceFile?.();
            if (!sf?.fileName) return undefined;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = name.getStart(sf);
                end = name.getEnd(sf);
            } catch { return undefined; }
            if (typeof start !== "number") return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, name.kind, end);
            if (!tsgoNode) return undefined;
            try {
                return refineNavSymbol(project.checker.getSuggestedSymbolForNonexistentProperty(tsgoNode, containingType));
            } catch { return undefined; }
        },
        getSuggestedSymbolForNonexistentClassMember(name: string, baseType: any): any {
            if (typeof name !== "string" || !baseType) return undefined;
            ensureProject();
            try {
                return refineNavSymbol(project.checker.getSuggestedSymbolForNonexistentClassMember(name, baseType));
            } catch { return undefined; }
        },
        getSuggestedSymbolForNonexistentJSXAttribute(name: any, containingType: any): any {
            if (!containingType) return undefined;
            ensureProject();
            const strName = typeof name === "string" ? name : (name?.escapedText ?? name?.text ?? name?.getText?.());
            if (typeof strName !== "string" || !strName) return undefined;
            try {
                return refineNavSymbol(project.checker.getSuggestedSymbolForNonexistentJSXAttribute(strName, containingType));
            } catch { return undefined; }
        },
        getSuggestedSymbolForNonexistentModule(name: any, targetModule: any): any {
            if (!name || !targetModule) return undefined;
            ensureProject();
            const rpcMod = resolveRpcSymbol(targetModule) ?? (isTsgoBridgeSymbol(targetModule) ? targetModule : undefined);
            if (!rpcMod) return undefined;
            const sf = name.getSourceFile?.();
            if (!sf?.fileName) return undefined;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = name.getStart(sf);
                end = name.getEnd(sf);
            } catch { return undefined; }
            if (typeof start !== "number") return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, name.kind, end);
            if (!tsgoNode) return undefined;
            try {
                return refineNavSymbol(project.checker.getSuggestedSymbolForNonexistentModule(tsgoNode, rpcMod));
            } catch { return undefined; }
        },
        getSuggestedSymbolForNonexistentSymbol(location: any, name: string, meaning: number): any {
            if (!location || typeof name !== "string") return undefined;
            ensureProject();
            const sf = location.getSourceFile?.();
            if (!sf?.fileName) return undefined;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = location.getStart(sf);
                end = location.getEnd(sf);
            } catch { return undefined; }
            if (typeof start !== "number") return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, location.kind, end);
            if (!tsgoNode) return undefined;
            try {
                return refineNavSymbol(project.checker.getSuggestedSymbolForNonexistentSymbol(tsgoNode, name, meaning >>> 0));
            } catch { return undefined; }
        },
        symbolToExpression(symbol: any, meaning: number, enclosingDeclaration?: any, flags?: number, internalFlags?: number): any {
            if (!symbol) return undefined;
            ensureProject();
            const rpcSym = resolveRpcSymbol(symbol) ?? (isTsgoBridgeSymbol(symbol) ? symbol : undefined);
            if (!rpcSym) return undefined;
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            try {
                const node = project.checker.symbolToExpression(rpcSym, meaning >>> 0, tsgoLocation, flags, internalFlags);
                if (!node) return undefined;
                applySingleLineEmitFlagsToDeclaration(node);
                stampIdentifierEscapedText(node);
                return hostifyDecodedExpression(node) ?? node;
            } catch { return undefined; }
        },
        // Unlocks class-member snippet completions (addNewNodeForMemberSymbol →
        // createSignatureDeclarationFromSignature) which pass a host ClassLike as
        // enclosingDeclaration; bare "tsgo" forwarding dies in getNodeId.
        signatureToSignatureDeclaration(
            signature: any,
            kind: number,
            enclosingDeclaration?: any,
            flags?: number,
            _internalFlags?: number,
            _tracker?: any,
        ): any {
            if (!signature) return undefined;
            ensureProject();
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            try {
                const node = project.checker.signatureToSignatureDeclaration(
                    signature,
                    kind,
                    tsgoLocation,
                    flags,
                );
                if (!node) return undefined;
                applySingleLineEmitFlagsToDeclaration(node);
                stampIdentifierEscapedText(node);
                // Never fall back to the decoded node — factory.update* needs mutable pos.
                return hostifyDecodedSignatureDeclaration(node, kind);
            }
            catch { return undefined; }
        },
        symbolToNode(symbol: any, meaning: number, enclosingDeclaration?: any, flags?: number, internalFlags?: number): any {
            if (!symbol) return undefined;
            ensureProject();
            const rpcSym = resolveRpcSymbol(symbol) ?? (isTsgoBridgeSymbol(symbol) ? symbol : undefined);
            if (!rpcSym) return undefined;
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            try {
                const node = project.checker.symbolToNode(rpcSym, meaning >>> 0, tsgoLocation, flags, internalFlags);
                if (!node) return undefined;
                applySingleLineEmitFlagsToDeclaration(node);
                stampIdentifierEscapedText(node);
                return hostifyDecodedPropertyName(node) ?? hostifyDecodedExpression(node) ?? node;
            } catch { return undefined; }
        },
        symbolToEntityName(symbol: any, meaning: number, enclosingDeclaration?: any, flags?: number, internalFlags?: number): any {
            if (!symbol) return undefined;
            ensureProject();
            const rpcSym = resolveRpcSymbol(symbol) ?? (isTsgoBridgeSymbol(symbol) ? symbol : undefined);
            if (!rpcSym) return undefined;
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            try {
                const node = project.checker.symbolToEntityName(rpcSym, meaning >>> 0, tsgoLocation, flags, internalFlags);
                if (!node) return undefined;
                applySingleLineEmitFlagsToDeclaration(node);
                stampIdentifierEscapedText(node);
                return hostifyDecodedExpression(node) ?? node;
            } catch { return undefined; }
        },
        typePredicateToTypePredicateNode(predicate: any, enclosingDeclaration?: any, flags?: number): any {
            if (!predicate) return undefined;
            ensureProject();
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            try {
                const node = project.checker.typePredicateToTypePredicateNode(predicate, tsgoLocation, flags);
                if (!node) return undefined;
                applySingleLineEmitFlagsToDeclaration(node);
                // Shape fixup: decoded parameterName Identifier may lack escapedText.
                const pn = node.parameterName;
                const predKind = predicate.kind as number;
                if (pn && (predKind === 1 || predKind === 3)) {
                    const name = String(predicate.parameterName ?? pn.text ?? pn.escapedText ?? "");
                    if (name) {
                        try {
                            Object.defineProperty(pn, "escapedText", { value: name, configurable: true, writable: true, enumerable: true });
                            Object.defineProperty(pn, "text", { value: name, configurable: true, writable: true, enumerable: true });
                        } catch { stampIdentifierEscapedText(pn, name); }
                    }
                }
                stampIdentifierEscapedText(node);
                // Type predicates are illegal in `type T = …`; reparse as a return type.
                return hostifyDecodedTypePredicateNode(node) ?? node;
            } catch { return undefined; }
        },
        indexInfoToIndexSignatureDeclaration(info: any, enclosingDeclaration?: any, flags?: number): any {
            if (!info) return undefined;
            ensureProject();
            const tsgoLocation = mapHostEnclosingToTsgo(enclosingDeclaration);
            try {
                // Pass IndexInfo shape through; sync API reconstructs from key/value/readonly/declaration.
                const keyId = info.keyType?.id;
                const valId = (info.type ?? info.valueType)?.id;
                if (process.env.TNB_TRACE_INDEXINFO === "1") {
                    try {
                        const fs = require("fs") as typeof import("fs");
                        fs.appendFileSync("/tmp/tnb-indexinfo-trace.jsonl", JSON.stringify({
                            keyId, valId, hasDecl: !!info.declaration, declKind: info.declaration?.kind,
                            isReadonly: !!info.isReadonly, hasLocation: !!tsgoLocation,
                        }) + "\n");
                    } catch { /* ignore */ }
                }
                if (typeof keyId !== "number" || typeof valId !== "number") {
                    if (process.env.TNB_TRACE_INDEXINFO === "1") {
                        try {
                            const fs = require("fs") as typeof import("fs");
                            fs.appendFileSync("/tmp/tnb-indexinfo-trace.jsonl", JSON.stringify({ err: "missing type ids", keyId, valId }) + "\n");
                        } catch { /* ignore */ }
                    }
                    return undefined;
                }
                const node = project.checker.indexInfoToIndexSignatureDeclaration(info, tsgoLocation, flags);
                if (!node) {
                    if (process.env.TNB_TRACE_INDEXINFO === "1") {
                        try {
                            const fs = require("fs") as typeof import("fs");
                            fs.appendFileSync("/tmp/tnb-indexinfo-trace.jsonl", JSON.stringify({ err: "rpc returned empty", keyId, valId }) + "\n");
                        } catch { /* ignore */ }
                    }
                    return undefined;
                }
                applySingleLineEmitFlagsToDeclaration(node);
                stampIdentifierEscapedText(node);
                // textChanges.insertMemberAtStart needs a mutable host AST node.
                return hostifyDecodedDeclarationNode(node) ?? node;
            } catch (e) {
                if (process.env.TNB_TRACE_INDEXINFO === "1") {
                    try {
                        const fs = require("fs") as typeof import("fs");
                        fs.appendFileSync("/tmp/tnb-indexinfo-trace.jsonl", JSON.stringify({ err: String((e as any)?.message ?? e) }) + "\n");
                    } catch { /* ignore */ }
                }
                return undefined;
            }
        },
        // ── Misc batch 2+5+6 (Promise / B-combo / JSX / inlay) ──
        getPromiseType(): any {
            ensureProject();
            const t = project.checker.getPromiseType();
            if (t) fixupType(t);
            return t;
        },
        getPromiseLikeType(): any {
            ensureProject();
            const t = project.checker.getPromiseLikeType();
            if (t) fixupType(t);
            return t;
        },
        getAnyAsyncIterableType(): any {
            ensureProject();
            const t = project.checker.getAnyAsyncIterableType();
            if (t) fixupType(t);
            return t;
        },
        getExactOptionalProperties(type: any): any[] {
            if (!type) return [];
            ensureProject();
            try {
                const props = project.checker.getExactOptionalProperties(type) ?? [];
                // addOptionalPropertyUndefined mutates valueDeclaration.type via
                // textChanges; RemoteNode declarations are read-only → remap to host.
                return props.map((p: any) => refineNavSymbol(p));
            } catch { return []; }
        },
        getJsxNamespace(location?: any): string {
            ensureProject();
            let tsgoLocation: any;
            if (location && typeof location.getStart === "function") {
                const sf = location.getSourceFile?.();
                if (sf?.fileName) {
                    try {
                        tsgoLocation = findTsgoNodeAtPosition(
                            sf.fileName,
                            location.getStart(sf),
                            location.kind,
                            location.getEnd(sf),
                        );
                    } catch { /* optional */ }
                }
            } else if (location && typeof location.id === "number") {
                tsgoLocation = location;
            }
            try {
                return project.checker.getJsxNamespace(tsgoLocation) ?? "";
            } catch { return ""; }
        },
        getJsxFragmentFactory(location: any): string {
            if (!location) return "";
            ensureProject();
            let tsgoLocation: any;
            if (typeof location.getStart === "function") {
                const sf = location.getSourceFile?.();
                if (sf?.fileName) {
                    try {
                        tsgoLocation = findTsgoNodeAtPosition(
                            sf.fileName,
                            location.getStart(sf),
                            location.kind,
                            location.getEnd(sf),
                        );
                    } catch { return ""; }
                }
            } else if (typeof location.id === "number" || typeof location.resolve === "function") {
                tsgoLocation = location;
            }
            if (!tsgoLocation) return "";
            try {
                return project.checker.getJsxFragmentFactory(tsgoLocation) ?? "";
            } catch { return ""; }
        },
        getParameterIdentifierInfoAtPosition(signature: any, position: number): any {
            if (!signature) return undefined;
            ensureProject();
            let info: any;
            try {
                info = project.checker.getParameterIdentifierInfoAtPosition(signature, position);
            } catch { return undefined; }
            if (!info) return undefined;
            let parameter = info.parameter;
            if (parameter && typeof parameter.resolve === "function") {
                const resolved = parameter.resolve(project);
                if (resolved) {
                    // Prefer host Identifier when the declaration file is host-bound
                    // (interactive inlay displayParts need createTextSpanFromNode).
                    parameter = remapDeclarationToHost(resolved, (fileName: string) => {
                        try {
                            const host = hostForOverlaySyncLocal();
                            const overlayCtx = programCtx?.overlayHostCtx;
                            if (!host || !overlayCtx?.options || !fileName) return undefined;
                            const hostFile = resolveHostFileName(fileName, host);
                            return sourceFileFromHostSnapshot(host, hostFile, hostFile, overlayCtx.options.target ?? 99);
                        } catch { return undefined; }
                    });
                }
            }
            return {
                parameter,
                parameterName: info.parameterName,
                isRestParameter: !!info.isRestParameter,
            };
        },
        // ── Constructor batch 7+8 ──
        // Local placeholders for createSymbol/createIndexInfo; materialize at
        // createSignature / createAnonymousType boundaries via atomic Go RPCs.
        createSymbol(flags: number, name: any): any {
            // Stock ORs Transient; callers write links.type before materialization.
            return {
                flags: (flags | SymbolFlags.Transient) >>> 0,
                escapedName: name,
                name,
                links: { checkFlags: 0 },
                __tnbPlaceholder: true,
            };
        },
        createIndexInfo(keyType: any, valueType: any, isReadonly: boolean): any {
            return {
                keyType,
                type: valueType,
                valueType,
                isReadonly: !!isReadonly,
                declaration: undefined,
            };
        },
        createArrayType(elementType: any): any {
            ensureProject();
            if (!elementType) return undefined;
            const t = project.checker.createArrayType(elementType);
            if (t) fixupType(t);
            return t;
        },
        createPromiseType(promisedType: any): any {
            ensureProject();
            if (!promisedType) return undefined;
            const t = project.checker.createPromiseType(promisedType);
            if (t) fixupType(t);
            return t;
        },
        createSignature(
            declaration: any,
            typeParameters: any,
            thisParameter: any,
            parameters: any[],
            returnType: any,
            typePredicate: any,
            minArgumentCount: number,
            flags: number,
        ): any {
            ensureProject();
            // Go createSignatureFromParts now accepts typeParameters (+ optional
            // thisParameter). declaration / typePredicate still omitted — Node /
            // TypePredicate wire forms are not in this RPC (deviation).
            const materialized: any[] = [];
            for (const p of parameters ?? []) {
                if (p?.__tnbPlaceholder) {
                    const typed = project.checker.createTransientSymbolWithType(
                        p.flags >>> 0,
                        String(p.escapedName ?? p.name ?? ""),
                        p.links?.type,
                    );
                    materialized.push(typed);
                }
                else if (p && typeof p.id === "number") {
                    materialized.push(p);
                }
                else if (p) {
                    const rpcSym = resolveRpcSymbol(p);
                    if (rpcSym && typeof rpcSym.id === "number") materialized.push(rpcSym);
                }
            }
            const typeParamHandles: any[] = [];
            if (typeParameters) {
                for (const tp of typeParameters) {
                    if (tp && typeof tp.id === "number") typeParamHandles.push(tp);
                }
            }
            let thisParamRemote: any;
            if (thisParameter) {
                if (typeof thisParameter.id === "number") thisParamRemote = thisParameter;
                else {
                    const rpcSym = resolveRpcSymbol(thisParameter);
                    if (rpcSym && typeof rpcSym.id === "number") thisParamRemote = rpcSym;
                }
            }
            void declaration;
            void typePredicate;
            const sig = project.checker.createSignatureFromParts(
                materialized,
                returnType,
                minArgumentCount ?? 0,
                flags ?? 0,
                typeParamHandles,
                thisParamRemote,
            );
            return sig;
        },
        createAnonymousType(
            symbol: any,
            members: any,
            callSignatures: any[],
            constructSignatures: any[],
            indexInfos: any[],
        ): any {
            ensureProject();
            const memberSyms: any[] = [];
            if (members) {
                const values = typeof members.values === "function"
                    ? [...members.values()]
                    : Array.isArray(members) ? members : Object.values(members);
                for (const m of values) {
                    if (!m) continue;
                    if (m.__tnbPlaceholder) {
                        memberSyms.push(project.checker.createTransientSymbolWithType(
                            m.flags >>> 0,
                            String(m.escapedName ?? m.name ?? ""),
                            m.links?.type,
                        ));
                    }
                    else if (typeof m.id === "number") {
                        memberSyms.push(m);
                    }
                    else {
                        const rpcSym = resolveRpcSymbol(m);
                        if (rpcSym && typeof rpcSym.id === "number") memberSyms.push(rpcSym);
                    }
                }
            }
            let owner: any;
            if (symbol) {
                if (typeof symbol.id === "number") owner = symbol;
                else owner = resolveRpcSymbol(symbol);
            }
            const indexParts = (indexInfos ?? []).map((info: any) => ({
                keyType: info.keyType,
                valueType: info.type ?? info.valueType,
                isReadonly: !!info.isReadonly,
            }));
            const t = project.checker.createAnonymousTypeFromParts(
                owner && typeof owner.id === "number" ? owner : undefined,
                memberSyms,
                callSignatures ?? [],
                constructSignatures ?? [],
                indexParts,
            );
            if (t) fixupType(t);
            return t;
        },
        // ── Final-3: override status / expando / symbolWalker narrow RPC ──
        getMemberOverrideModifierStatus(node: any, member: any, memberSymbol: any): number {
            // Stock MemberOverrideStatus.Ok = 0. Synthetic ClassElement (completions)
            // cannot be mapped via findTsgoNodeAtPosition — extract modifier flags in JS.
            if (!node || !memberSymbol) return 0;
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf?.fileName) return 0;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = node.getStart(sf);
                end = node.getEnd(sf);
            }
            catch { return 0; }
            if (typeof start !== "number") return 0;
            const tsgoClass = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
            if (!tsgoClass) return 0;
            const rpcSym = resolveRpcSymbol(memberSymbol)
                ?? (isTsgoBridgeSymbol(memberSymbol) ? memberSymbol : undefined);
            if (!rpcSym || typeof rpcSym.id !== "number") return 0;
            const cacheFlags = Number(member?.modifierFlagsCache ?? 0);
            // ModifierFlags: Override=1<<4, Abstract=1<<6, Static=1<<8
            let memberHasOverride = !!(cacheFlags & (1 << 4));
            let memberHasAbstract = !!(cacheFlags & (1 << 6));
            let memberIsStatic = !!(cacheFlags & (1 << 8));
            for (const mod of member?.modifiers ?? []) {
                if (mod?.kind === SyntaxKind.OverrideKeyword) memberHasOverride = true;
                if (mod?.kind === SyntaxKind.AbstractKeyword) memberHasAbstract = true;
                if (mod?.kind === SyntaxKind.StaticKeyword) memberIsStatic = true;
            }
            // Stock speculative path: no parent → hasSyntacticModifier only (covered above).
            const memberHasName = !!(member?.name);
            try {
                return project.checker.getMemberOverrideModifierStatus(
                    tsgoClass,
                    rpcSym,
                    memberHasOverride,
                    memberHasAbstract,
                    memberIsStatic,
                    memberHasName,
                ) ?? 0;
            }
            catch { return 0; }
        },
        getSymbolOfExpando(node: any, allowDeclaration: boolean): any {
            if (!node) return undefined;
            const sf = node.getSourceFile?.();
            if (!sf?.fileName) return undefined;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = node.getStart(sf);
                end = node.getEnd(sf);
            }
            catch { return undefined; }
            if (typeof start !== "number") return undefined;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
            if (!tsgoNode) return undefined;
            try {
                return refineNavSymbol(project.checker.getSymbolOfExpando(tsgoNode, !!allowDeclaration));
            }
            catch { return undefined; }
        },
        getSymbolWalker(_accept?: (symbol: any) => boolean): any {
            // Narrow bypass: collectVisitedTypeParameters returns only TypeParameter
            // types (consumer filters isTypeParameter). visitedSymbols unused.
            return {
                walkType: (type: any) => {
                    if (!type) return { visitedTypes: [], visitedSymbols: [] };
                    ensureProject();
                    try {
                        const visited = project.checker.collectVisitedTypeParameters(type) ?? [];
                        for (const t of visited) fixupType(t);
                        return { visitedTypes: visited, visitedSymbols: [] };
                    }
                    catch {
                        return { visitedTypes: [], visitedSymbols: [] };
                    }
                },
                walkSymbol: () => ({ visitedTypes: [], visitedSymbols: [] }),
            };
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

        // ── Diagnostics ──
        // Stock TypeChecker.getDiagnostics(sourceFile) runs semantic check for
        // that file. addMissingAwait (isMissingAwaitError) needs relatedInfo
        // code 1308 on the span — previously stubbed to [] and short-circuited.
        // Delegate to the same Go semantic(+syntactic) pipeline Program uses.
        // Deviation: sourceFile undefined → [] (stock = whole program); consumers
        // of this path (addMissingAwait) always pass a SourceFile.
        getSuggestionDiagnostics(): readonly any[] { return []; },
        getGlobalDiagnostics(): readonly any[] { return []; },
        getDiagnostics(sourceFile?: any, _cancellationToken?: any): readonly any[] {
            if (!sourceFile?.fileName) return [];
            ensureProject();
            if (!project?.program) return [];
            const fileArg = toTsgoFileName(sourceFile.fileName);
            const getSf = (fn: string) => {
                const host = toHostFileName(fn);
                if (
                    host === sourceFile.fileName
                    || fn === sourceFile.fileName
                    || fn === fileArg
                    || host === toHostFileName(sourceFile.fileName)
                ) {
                    return sourceFile;
                }
                // Related info may point at other files; return a minimal
                // skeleton so convertTsgoDiagnostic doesn't NPE on .file.
                return createSkeletonSourceFile(host, "", options.target ?? 99, inferScriptKind(host));
            };
            return [
                ...mapTsgoDiagnostics(project.program.getSyntacticDiagnostics?.(fileArg), getSf),
                ...mapTsgoDiagnostics(project.program.getSemanticDiagnostics?.(fileArg), getSf),
            ];
        },
        getAmbientModules(): readonly any[] {
            ensureProject();
            // Language-service auto-import also calls getAmbientModules while
            // populating exportInfoMap, where binder-only symbols are not
            // sufficient (aliases need the merged export table). The light
            // batch is reserved for non-projectService compiler/builder walks.
            const batch = isProjectServiceProgram
                ? getAmbientModuleExportBatch()
                : getAmbientModuleBatch();
            return (batch?.modules ?? []).filter((m: any) => !m.moduleFileName).map((m: any) => m.moduleSymbol);
        },
        tryFindAmbientModule(moduleName: string): any {
            if (!moduleName) return undefined;
            const key = moduleName.replace(/^"|"$/g, "");
            ensureProject();
            if (ambientModuleByNameCache.has(key)) {
                return ambientModuleByNameCache.get(key) ?? undefined;
            }
            try {
                const batch = getAmbientModuleExportBatch();
                for (const mod of batch?.modules ?? []) {
                    if (mod.moduleFileName) continue;
                    const name = mod.moduleName?.replace(/^"|"$/g, "");
                    if (name === key) {
                        ambientModuleByNameCache.set(key, mod.moduleSymbol);
                        return mod.moduleSymbol;
                    }
                }
            }
            catch { /* empty */ }
            ambientModuleByNameCache.set(key, null);
            return undefined;
        },

        // ── Stubs ──
        getSymbolsInScope(location: any, meaning: number): any[] {
            if (!location) return [];
            const sf = location.getSourceFile?.();
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
            let tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, location.kind, end);
            if (!tsgoNode) {
                // Scope anchor can be a token tsgo's index doesn't cover (EOF,
                // synthetic nodes). SourceFile scope still includes globals.
                tsgoNode = getTsgoSourceFile(sf.fileName);
            }
            if (tsgoNode) {
                const raw = project.checker.getSymbolsInScope(tsgoNode, meaning >>> 0) ?? [];
                hydrateScopeSymbolParents(raw);
                let result = raw.map(refineNavSymbol);
                // Host-bound overlays and Soft-P′ soft-bound open files: prefer
                // host binder locals so completion sortText uses === sourceFile.
                if (isHostParsedSourceFile(sf)) {
                    result = mergeHostLocalScopeSymbols(result, location, meaning).map(sym =>
                        refinedSymBySym.has(sym) ? sym : refineNavSymbol(sym),
                    );
                }
                // Stock never puts module-default / re-export aliases into scope;
                // filtering them restores the `default` keyword completion slot.
                result = result.filter((sym: any) => !isStolenDefaultKeywordScopeSymbol(sym));
                if (process.env.TNB_SCOPE_TRACE === "1") {
                    try {
                        require("node:fs").appendFileSync(
                            "/tmp/tnb-scope-trace.log",
                            `[scope] ${symCacheFileName(sf.fileName)}:${start} hostBound=${!!sf.__tnbHostBound} syms=${result.length}\n`,
                        );
                    } catch { /* ignore */ }
                }
                symbolsInScopeCache.set(scopeKey, result);
                return result;
            }
            // Genuine host-only virtual files have no tsgo mirror; walk host
            // bindSourceFile locals/exports (no lib globals — tsgo unavailable).
            if (sf.__tnbHostBound) {
                return getHostSymbolsInScope(location, meaning).map(refineNavSymbol);
            }
            return [];
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
                        // Same as getSymbolAtLocation host-first: must canonicalize
                        // to host binder identity so findAllReferences search.includes
                        // matches getRootSymbols/refineNavSymbol results.
                        const refined = refineNavSymbol(rpcSym ?? sym);
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
        // Type-argument constraint for completions / stringCompletions / codefixes.
        getTypeArgumentConstraint(node: any): any {
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
            const t = project.checker.getTypeArgumentConstraint(tsgoNode);
            if (t) fixupType(t);
            return t;
        },
        // Import/export clause completions — module exports + export= properties.
        getExportsAndPropertiesOfModule(moduleSymbol: any): readonly any[] {
            if (!moduleSymbol) return [];
            ensureProject();
            const rpcSym = resolveRpcSymbol(moduleSymbol) ?? (isTsgoBridgeSymbol(moduleSymbol) ? moduleSymbol : undefined);
            if (!rpcSym) return [];
            return project.checker.getExportsAndPropertiesOfModule(rpcSym) ?? [];
        },
        // JSX intrinsic tag name completions (`<di`).
        getJsxIntrinsicTagNamesAt(location: any): readonly any[] {
            if (!location) return [];
            const sf = location.getSourceFile?.();
            if (!sf?.fileName) return [];
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = location.getStart(sf);
                end = location.getEnd(sf);
            } catch { return []; }
            if (typeof start !== "number") return [];
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, location.kind, end);
            if (!tsgoNode) return [];
            return project.checker.getJsxIntrinsicTagNamesAt(tsgoNode) ?? [];
        },
        // Object-literal completion filtering for private/protected members.
        isPropertyAccessible(node: any, isSuper: boolean, isWrite: boolean, containingType: any, property: any): boolean {
            if (!node || !containingType || !property) return false;
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
            if (!rpcSym) return true;
            try {
                return !!project.checker.isPropertyAccessible(tsgoNode, !!isSuper, !!isWrite, containingType, rpcSym);
            } catch { return true; }
        },
        // Auto-import / FQN chain: undefined when no accessible chain (not []).
        getAccessibleSymbolChain(
            symbol: any,
            enclosingDeclaration: any,
            meaning: number,
            useOnlyExternalAliasing: boolean,
        ): readonly any[] | undefined {
            if (!symbol) return undefined;
            ensureProject();
            const rpcSym = resolveRpcSymbol(symbol) ?? (isTsgoBridgeSymbol(symbol) ? symbol : undefined);
            if (!rpcSym) return undefined;
            let tsgoEnclosing: any;
            if (enclosingDeclaration) {
                const sf = enclosingDeclaration.getSourceFile?.();
                if (sf?.fileName) {
                    let start: number | undefined;
                    let end: number | undefined;
                    try {
                        start = enclosingDeclaration.getStart(sf);
                        end = enclosingDeclaration.getEnd(sf);
                    } catch { /* ignore */ }
                    if (typeof start === "number") {
                        tsgoEnclosing = findTsgoNodeAtPosition(sf.fileName, start, enclosingDeclaration.kind, end);
                    }
                }
            }
            return project.checker.getAccessibleSymbolChain(rpcSym, tsgoEnclosing, meaning >>> 0, !!useOnlyExternalAliasing);
        },
        // Call-argument contextual type (object-literal member completions).
        getContextualTypeForArgumentAtIndex(callTarget: any, argIndex: number): any {
            if (!callTarget) return undefined;
            const sf = callTarget.getSourceFile?.();
            if (!sf?.fileName) return undefined;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = callTarget.getStart(sf);
                end = callTarget.getEnd(sf);
            } catch { return undefined; }
            if (typeof start !== "number") return undefined;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, callTarget.kind, end);
            if (!tsgoNode) return undefined;
            const t = project.checker.getContextualTypeForArgumentAtIndex(tsgoNode, argIndex);
            if (t) fixupType(t);
            return t;
        },
        // JSX attribute value contextual type. Go has no contextFlags; LS omits flags.
        getContextualTypeForJsxAttribute(attribute: any, _contextFlags?: number): any {
            if (!attribute) return undefined;
            const sf = attribute.getSourceFile?.();
            if (!sf?.fileName) return undefined;
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = attribute.getStart(sf);
                end = attribute.getEnd(sf);
            } catch { return undefined; }
            if (typeof start !== "number") return undefined;
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, attribute.kind, end);
            if (!tsgoNode) return undefined;
            const t = project.checker.getContextualTypeForJsxAttribute(tsgoNode);
            if (t) fixupType(t);
            return t;
        },
        // Property-access validity (distinct from isValidPropertyAccessForCompletions).
        isValidPropertyAccess(node: any, propertyName: string): boolean {
            if (!node || typeof propertyName !== "string") return false;
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
            try {
                return !!project.checker.isValidPropertyAccess(tsgoNode, propertyName);
            } catch { return true; }
        },
        // String-literal argument completions — candidate signatures.
        getCandidateSignaturesForStringLiteralCompletions(call: any, editingArgument: any): readonly any[] {
            if (!call || !editingArgument) return [];
            const sf = call.getSourceFile?.();
            if (!sf?.fileName) return [];
            let callStart: number | undefined;
            let callEnd: number | undefined;
            let argStart: number | undefined;
            let argEnd: number | undefined;
            try {
                callStart = call.getStart(sf);
                callEnd = call.getEnd(sf);
                const argSf = editingArgument.getSourceFile?.() ?? sf;
                argStart = editingArgument.getStart(argSf);
                argEnd = editingArgument.getEnd(argSf);
            } catch { return []; }
            if (typeof callStart !== "number" || typeof argStart !== "number") return [];
            ensureProject();
            const tsgoCall = findTsgoNodeAtPosition(sf.fileName, callStart, call.kind, callEnd);
            const argSf = editingArgument.getSourceFile?.() ?? sf;
            const tsgoArg = findTsgoNodeAtPosition(argSf.fileName, argStart, editingArgument.kind, argEnd);
            if (!tsgoCall || !tsgoArg) return [];
            return project.checker.getCandidateSignaturesForStringLiteralCompletions(tsgoCall, tsgoArg) ?? [];
        },
        // Parameter-property dual symbols (references / codefixes).
        getSymbolsOfParameterPropertyDeclaration(parameter: any, parameterName: string): readonly any[] {
            if (!parameter || typeof parameterName !== "string") return [];
            const sf = parameter.getSourceFile?.();
            if (!sf?.fileName) return [];
            let start: number | undefined;
            let end: number | undefined;
            try {
                start = parameter.getStart(sf);
                end = parameter.getEnd(sf);
            } catch { return []; }
            if (typeof start !== "number") return [];
            ensureProject();
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, parameter.kind, end);
            if (!tsgoNode) return [];
            return project.checker.getSymbolsOfParameterPropertyDeclaration(tsgoNode, parameterName) ?? [];
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
            // Stock: getImmediateRootSymbols returns undefined for non-Transient
            // (Alias included) → [symbol] by identity. Transient (mapped/union
            // synthetic) walks. Bridge: FFI only when flags need tsgo-side walk —
            // Transient always, Alias always (aliased/root resolution).
            // Non-Transient|Alias: skip FFI; still Soft-P′+S′ via refineNavSymbol
            // (bare ensureExportedSymbolModuleParent alone dropped Soft-P′).
            const flags = (symbol.flags ?? 0) as number;
            if (!(flags & (SymbolFlags.Transient | SymbolFlags.Alias))) {
                return [refineNavSymbol(symbol)];
            }
            let roots: readonly any[] | undefined;
            try {
                roots = rpc().getRootSymbols(symbol);
            } catch { /* unresolvable → own root */ }
            return (roots?.length ? [...roots] : [symbol]).map(refineNavSymbol);
        },
        // Stock: getMergedSymbol(symbol.exportSymbol || symbol). Bridge symbols
        // carry exportSymbol as a lazy id resolved via Symbol.getExportSymbol();
        // host-bound symbols expose exportSymbol directly.
        getExportSymbolOfSymbol(symbol: any): any {
            if (!symbol) return symbol;
            if (typeof symbol.getExportSymbol === "function") {
                try {
                    return refineNavSymbol(symbol.getExportSymbol());
                } catch { /* fall through to exportSymbol field */ }
            }
            const exportSym = symbol.exportSymbol;
            return refineNavSymbol(exportSym && exportSym !== symbol ? exportSym : symbol);
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
        // Emit resolver — the lint path doesn't emit; return a minimal
        // stub if code reads properties off it.
        getEmitResolver: () => ({ getExternalModuleIndicator: () => false }),
        resolveName(name: string, location: any, meaning: number, excludeGlobals?: boolean): any {
            ensureProject();
            let tsgoLocation: any = undefined;
            if (location && typeof location.getStart === "function") {
                const sf = location.kind === SyntaxKind.SourceFile
                    ? location
                    : location.getSourceFile?.();
                if (sf?.fileName) {
                    // SourceFile scopes must map to the tsgo SourceFile root — a
                    // positional deepest-node hit at 0 can land inside the first
                    // statement and make resolveName see nested locals (extract
                    // free-var falsely treats parameters as in global scope).
                    if (location.kind === SyntaxKind.SourceFile) {
                        tsgoLocation = getTsgoSourceFile(sf.fileName) ?? undefined;
                    }
                    else {
                        tsgoLocation = findTsgoNodeAtPosition(
                            sf.fileName,
                            location.getStart(sf),
                            location.kind,
                            location.getEnd(sf),
                        );
                    }
                }
            }
            if (tsgoLocation) {
                try {
                    const sym = project.checker.resolveName(name, meaning >>> 0, tsgoLocation, excludeGlobals);
                    if (sym) {
                        const refined = refineNavSymbol(sym);
                        if (_traceSymEnabled) {
                            traceSym(
                                `resolveName name=${JSON.stringify(name)} meaning=${meaning >>> 0} `
                                + `locKind=${traceSymKind(location?.kind)} tsgoKind=${traceSymKind(tsgoLocation?.kind)} `
                                + `→ ${traceSymSymbol(refined)}`,
                            );
                        }
                        return refined;
                    }
                } catch {
                    // fall through to host-bound AST
                }
            }
            // Host lexical resolve (file/block scopes) — mirrors stock when the
            // Go location map is missing or returns nothing visible.
            const hostSym = location?.getSourceFile?.()?.__tnbHostBound
                ? resolveEntityNameOnHostBoundAst(String(name), location, meaning >>> 0)
                : resolveNameOnHostBoundAst(name, location);
            const hostResolved = refineNavSymbol(hostSym ?? undefined);
            if (_traceSymEnabled) {
                traceSym(
                    `resolveName name=${JSON.stringify(name)} meaning=${meaning >>> 0} `
                    + `locKind=${traceSymKind(location?.kind)} tsgoKind=${traceSymKind(tsgoLocation?.kind)} `
                    + `→ ${traceSymSymbol(hostResolved)} (host-fallback)`,
                );
            }
            return hostResolved;
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
                traceThrow("TypeChecker", prop);
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
    getTypeOfPropertyOfType: "adapter",
    getIndexInfoOfType: "adapter",
    getIndexInfosOfType: "adapter",
    getIndexInfosOfIndexSymbol: "adapter",
    getSignaturesOfType: "adapter",
    getIndexTypeOfType: "adapter",
    getIndexType: "tsgo",
    getBaseTypes: "adapter",
    getBaseTypeOfLiteralType: "tsgo",
    getWidenedType: "adapter",
    getWidenedLiteralType: "adapter",
    getPromisedTypeOfPromise: "adapter",
    getAwaitedType: "adapter",
    isEmptyAnonymousObjectType: "adapter",
    getReturnTypeOfSignature: "adapter",
    getParameterType: "tsgo",
    getParameterIdentifierInfoAtPosition: "adapter",
    getNullableType: "adapter",
    getNonNullableType: "adapter",
    getNonOptionalType: "adapter",
    isNullableType: "adapter",
    getTypeArguments: "adapter",
    typeToTypeNode: "adapter",
    typePredicateToTypePredicateNode: "adapter",
    signatureToSignatureDeclaration: "adapter",
    indexInfoToIndexSignatureDeclaration: "adapter",
    symbolToEntityName: "adapter",
    symbolToExpression: "adapter",
    symbolToNode: "adapter",
    symbolToTypeParameterDeclarations: "adapter",
    symbolToParameterDeclaration: "adapter",
    typeParameterToDeclaration: "adapter",
    getSymbolsInScope: "adapter",
    getSymbolAtLocation: "adapter",
    getIndexInfosAtLocation: "adapter",
    getSymbolsOfParameterPropertyDeclaration: "adapter",
    getShorthandAssignmentValueSymbol: "adapter",
    getExportSpecifierLocalTargetSymbol: "adapter",
    getExportSymbolOfSymbol: "adapter",
    getPropertySymbolOfDestructuringAssignment: "adapter",
    getTypeOfAssignmentPattern: "throw",
    getTypeAtLocation: "adapter",
    getTypeFromTypeNode: "adapter",
    signatureToString: "adapter",
    typeToString: "adapter",
    symbolToString: "adapter",
    typePredicateToString: "adapter",
    writeSignature: "adapter",
    writeType: "adapter",
    writeSymbol: "adapter",
    writeTypePredicate: "adapter",
    getFullyQualifiedName: "adapter",
    getAugmentedPropertiesOfType: "adapter",
    getRootSymbols: "adapter",
    getSymbolOfExpando: "adapter",
    getContextualType: "adapter",
    getContextualTypeForObjectLiteralElement: "adapter",
    getContextualTypeForArgumentAtIndex: "adapter",
    getContextualTypeForJsxAttribute: "adapter",
    isContextSensitive: "tsgo",
    getTypeOfPropertyOfContextualType: "adapter",
    getResolvedSignature: "adapter",
    getResolvedSignatureForSignatureHelp: "adapter",
    getCandidateSignaturesForStringLiteralCompletions: "adapter",
    getExpandedParameters: "adapter",
    hasEffectiveRestParameter: "adapter",
    containsArgumentsReference: "adapter",
    getSignatureFromDeclaration: "adapter",
    isImplementationOfOverload: "adapter",
    isUndefinedSymbol: "adapter",
    isArgumentsSymbol: "adapter",
    isUnknownSymbol: "adapter",
    getMergedSymbol: "adapter",
    symbolIsValue: "adapter",
    getConstantValue: "adapter",
    isValidPropertyAccess: "adapter",
    isValidPropertyAccessForCompletions: "adapter",
    getAliasedSymbol: "adapter",
    getImmediateAliasedSymbol: "adapter",
    getExportsOfModule: "adapter",
    getExportsAndPropertiesOfModule: "adapter",
    forEachExportAndPropertyOfModule: "adapter",
    getJsxIntrinsicTagNamesAt: "adapter",
    isOptionalParameter: "adapter",
    getAmbientModules: "adapter",
    tryGetMemberInModuleExports: "adapter",
    tryGetMemberInModuleExportsAndProperties: "adapter",
    getApparentType: "tsgo",
    getSuggestedSymbolForNonexistentProperty: "adapter",
    getSuggestedSymbolForNonexistentJSXAttribute: "adapter",
    getSuggestedSymbolForNonexistentSymbol: "adapter",
    getSuggestedSymbolForNonexistentModule: "adapter",
    getSuggestedSymbolForNonexistentClassMember: "adapter",
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
    createArrayType: "adapter",
    getElementTypeOfArrayType: "adapter",
    createPromiseType: "adapter",
    getPromiseType: "adapter",
    getPromiseLikeType: "adapter",
    getAnyAsyncIterableType: "adapter",
    isTypeAssignableTo: "adapter",
    createAnonymousType: "adapter",
    createSignature: "adapter",
    createSymbol: "adapter",
    createIndexInfo: "adapter",
    isSymbolAccessible: "adapter",
    tryFindAmbientModule: "adapter",
    getSymbolWalker: "adapter",
    getDiagnostics: "adapter",
    getGlobalDiagnostics: "adapter",
    getEmitResolver: "adapter",
    requiresAddingImplicitUndefined: "adapter",
    getNodeCount: "adapter",
    getIdentifierCount: "adapter",
    getSymbolCount: "adapter",
    getTypeCount: "adapter",
    getInstantiationCount: "adapter",
    getRelationCacheSizes: "adapter",
    getRecursionIdentity: "throw",
    getUnmatchedProperties: "adapter",
    isArrayType: "tsgo",
    isTupleType: "tsgo",
    isArrayLikeType: "adapter",
    isTypeInvalidDueToUnionDiscriminant: "adapter",
    getExactOptionalProperties: "adapter",
    getAllPossiblePropertiesOfTypes: "adapter",
    resolveName: "adapter",
    getJsxNamespace: "adapter",
    getJsxFragmentFactory: "adapter",
    getAccessibleSymbolChain: "adapter",
    getTypePredicateOfSignature: "tsgo",
    resolveExternalModuleName: "adapter",
    resolveExternalModuleSymbol: "adapter",
    tryGetThisTypeAt: "adapter",
    getTypeArgumentConstraint: "adapter",
    getSuggestionDiagnostics: "adapter",
    runWithCancellationToken: "adapter",
    getLocalTypeParametersOfClassOrInterfaceOrTypeAlias: "adapter",
    isDeclarationVisible: "adapter",
    isPropertyAccessible: "adapter",
    getTypeOnlyAliasDeclaration: "adapter",
    getMemberOverrideModifierStatus: "adapter",
    isTypeParameterPossiblyReferenced: "throw",
    typeHasCallOrConstructSignatures: "adapter",
    getSymbolFlags: "adapter",
    fillMissingTypeArguments: "adapter",
    getTypeArgumentsForResolvedSignature: "throw",
    isLibType: "adapter",
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
    getResolvedModuleFromModuleSpecifier: "adapter",
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
    structureIsReused: "adapter",
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
