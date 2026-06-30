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
import { SyntaxKind } from "./types.js";
import { installTsgoBackedSourceFileLoader, inferScriptKind, createSkeletonSourceFile, getTsgoBackedSourceFile } from "./tsgoBackedSourceFile.js";
import { getTnbPackageRoot, isBundledLibPath, isHostLibFile, resolveHostFileName, toHostFileName, toTsgoFileName } from "./tsgoLibPaths.js";

// ── Module-level bridge deps (shared across all createTsgoChecker calls) ──
// koffi.struct() registers type names globally, so the struct definition must
// happen exactly once even when multiple Program instances each create a tsgo
// checker.
let _koffi: any;
let _sync: any;
let _bridgeFns: any;

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

function loadBridgeDeps(): void {
    if (_koffi) return;
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
    const lib = _koffi.load(resolvedBridge);
    _bridgeFns = {
        BridgeNewSession: lib.func("char *BridgeNewSession(char *cwd)"),
        BridgeCall: lib.func("char *BridgeCall(int64_t session, char *method, char *paramsJson)"),
        BridgeDisposeSession: lib.func("void BridgeDisposeSession(int64_t session)"),
        BridgeBinary: _koffi.struct("BridgeBinary", { data: "void *", len: "int64_t" }),
        BridgeCallBinary: lib.func("BridgeBinary BridgeCallBinary(int64_t session, char *method, char *paramsJson)"),
    };
}

// Module-level session pool — one koffi BridgeClient + tsgo API per process,
// shared across all Programs. Projects are cached per tsconfig path.
let _client: any;
let _api: any;
let _sourceFileCache: any;
const _projectCache = new Map<string, any>();

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
// Overlay-path cache: only files missing on disk are fed to tsgo as overlays
// (typically Volar virtual documents).
const _overlayDiskExistsCache = new Map<string, boolean>();
// tsgo's case-sensitivity flag — skeleton SFs must use the same path format
// (lowercased on case-insensitive FS) as tsgo RemoteSourceFiles, otherwise
// BuilderState's fileInfos keys (from getSourceFiles skeletons) won't match
// updateShapeSignature's lookup (from getSourceFile tsgo-backed SFs).
let _tsgoUseCaseSensitive = true;
// Refs set by ensureProject so NodeHandle prototype hooks can route to the
// currently-active project (scope manager reads `declaration.getSourceFile()`
// on tsgo NodeHandles, which need the project to resolve).
const _currentProjectRef: { project: any } = { project: undefined };
let _nodeHandlePatched = false;

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
/** Host script text — prefers getSourceFile (Volar virtual .vue TS) over readFile. */
function getHostScriptContent(host: any, fileName: string, options: any): { text: string; scriptKind: number } | undefined {
    const languageVersion = options.target ?? 99;
    let scriptKind = inferScriptKind(fileName);
    const sf = host?.getSourceFile?.(fileName, languageVersion);
    if (sf && typeof sf.text === "string") {
        if (typeof sf.scriptKind === "number") scriptKind = sf.scriptKind;
        return { text: sf.text, scriptKind };
    }
    const text = host?.readFile?.(fileName);
    if (typeof text === "string") return { text, scriptKind };
    return undefined;
}
/** Overlay when the host view differs from disk (virtual docs) or the file is absent on disk. */
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
/** Extra extensions for tsgo tsconfig parse when allowArbitraryExtensions is on (vue-tsc). */
function collectExtraFileExtensions(rootNames: readonly string[], options: any): any[] | undefined {
    if (!options?.allowArbitraryExtensions) return undefined;
    const builtin = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
    const exts = new Set<string>();
    for (const fn of rootNames) {
        if (typeof fn !== "string") continue;
        const dot = fn.lastIndexOf(".");
        if (dot < 0) continue;
        const ext = fn.slice(dot);
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
let _kindRemapApplied = false;

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
    if (_kindRemapApplied) return;
    _kindRemapApplied = true;
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

    // Host script text captured once at createProgram time (safe to call
    // host.getSourceFile here — program does not exist yet; Volar injects
    // virtual TS for .vue via getSourceFile). Reused by getOrCreateSourceFile
    // for skeleton text / diagnostic line maps without re-entering getSourceFile.
    const hostContentByFile = new Map<string, { text: string; scriptKind: number }>();
    /** Parsed host SourceFiles captured during createProgram (Volar virtual .vue TS). */
    const parsedHostSourceFiles = new Map<string, any>();

    // Collect host file content for tsgo overlays — makes the fork host the
    // single source of truth. Uses getSourceFile when present (vue-tsc / Volar
    // inject virtual TS for .vue); falls back to readFile. Only sends content
    // that differs from disk (or is missing on disk); unchanged on-disk .ts is
    // read by tsgo itself.
    const overlays: any[] = [];
    const trackedHostFiles = new Set<string>();
    {
        const names = new Set<string>();
        for (const fn of rootNames) {
            if (typeof fn === "string") names.add(fn);
        }
        const scriptNames = host?.getScriptFileNames?.();
        if (scriptNames) {
            for (const fn of scriptNames) {
                if (typeof fn === "string") names.add(fn);
            }
        }
        for (const fn of names) {
            trackedHostFiles.add(fn);
            const resolvedFn = resolveHostFileName(fn, host);
            const liveHostSf = host?.getSourceFile?.(fn, options.target ?? 99);
            if (liveHostSf?.statements?.length) {
                parsedHostSourceFiles.set(resolvedFn, liveHostSf);
            }
            if (!isOverlayCandidatePath(fn)) continue;
            const content = getHostScriptContent(host, fn, options);
            if (!content) continue;
            hostContentByFile.set(resolvedFn, content);
            if (!shouldSendHostOverlay(fn, content.text)) continue;
            overlays.push({ fileName: fn, content: content.text, scriptKind: content.scriptKind });
        }
    }
    _pendingOverlays = overlays.length > 0 ? overlays : undefined;
    _pendingExtraFileExtensions = collectExtraFileExtensions(rootNames, options);

    // Collect referenced project paths for tsgo to open alongside the main
    // project — tsgo needs all referenced tsconfigs to resolve imports
    // across project boundaries (the full TS createProgram does this via
    // projectReferences; the thin path uses tsgo's openProjects).
    if (projectReferences && projectReferences.length > 0) {
        _pendingReferencedProjects = projectReferences
            .map((ref: any) => resolveTsconfigPath(ref.path as string, host))
            .filter((p: string) => typeof p === "string" && p.length > 0);
    } else {
        _pendingReferencedProjects = undefined;
    }

    // Eagerly create the tsgo project (shared bridge client, kind remap, etc.)
    // by calling createTsgoChecker which sets up ensureProject + overlays.
    // We pass a minimal program-like object that createTsgoChecker can use
    // to get configFilePath + getSourceFiles (for overlay content collection).
    const thinProgramForChecker = {
        getCompilerOptions: () => options,
        getSourceFiles: () => [] as any[],
    };

    // tsserver/Volar open files incrementally (e.g. foo.vue before fixture.vue).
    // Always refresh the tsgo snapshot so overlays match the latest host content.
    _projectCache.delete(configFilePath);

    const checker = createTsgoChecker(thinProgramForChecker as any);

    // The tsgo project is now created (ensureProject ran inside createTsgoChecker).
    // Access it via the module-level cache.
    const project = _projectCache.get(configFilePath);

    // Build a thin Program object that delegates to the tsgo project.
    const getTsgoSourceFileNames = () => project?.program?.getSourceFileNames?.() ?? [];
    const getSourceFileNames = () => getTsgoSourceFileNames().map(toHostFileName);
    const tsgoGetSourceFile = (fileName: string) => project?.program?.getSourceFile?.(toTsgoFileName(fileName));

    // Helper: create a proper TS SourceFile shell (with path/resolvedPath/etc.)
    // from host content, then wrap it with the tsgo RemoteSourceFile AST via
    // getTsgoBackedSourceFile. BuilderProgram and other TS infrastructure
    // need path/resolvedPath/version on source files.
    const sfCache = new Map<string, any>();
    const getOrCreateSourceFile = (fileName: string): any => {
        const hostFileName = resolveHostFileName(fileName, host);
        if (sfCache.has(hostFileName)) return sfCache.get(hostFileName);

        const parsedHostSf = parsedHostSourceFiles.get(hostFileName);

        const hostContent = hostContentByFile.get(hostFileName);
        const text = hostContent?.text ?? host?.readFile?.(hostFileName) ?? "";
        const scriptKind = hostContent?.scriptKind ?? inferScriptKind(hostFileName);
        const sf = createSkeletonSourceFile(hostFileName, text, options.target ?? 99, scriptKind);
        const anySf = sf as any;
        anySf.version = "1";
        const backed = getTsgoBackedSourceFile(anySf);
        let result = backed ?? anySf;
        if (!backed && parsedHostSf?.statements?.length) {
            // tsgo has no RemoteSourceFile for this Volar virtual doc — use the
            // parsed host SF so rename/reference token scans don't hit empty skeletons.
            result = parsedHostSf;
        }
        if (result && !("version" in result)) {
            try { Object.defineProperty(result, "version", { value: "1", writable: true, configurable: true, enumerable: false }); } catch {}
        }
        if (result && result !== anySf) {
            try {
                if (result.resolvedPath === undefined) {
                    Object.defineProperty(result, "resolvedPath", { value: result.path, writable: true, configurable: true });
                }
                if (result.originalFileName === undefined) {
                    Object.defineProperty(result, "originalFileName", { value: hostFileName, writable: true, configurable: true });
                }
            } catch {}
        }
        sfCache.set(hostFileName, result);
        return result;
    };

    // Writable skeleton SourceFiles for diagnostics — Volar vue-tsc mutates
    // diagnostic.file.text during span remapping; tsgo RemoteSourceFile.text is read-only.
    const diagnosticSfCache = new Map<string, any>();
    const getDiagnosticSourceFile = (fileName: string): any => {
        if (diagnosticSfCache.has(fileName)) return diagnosticSfCache.get(fileName);
        const hostContent = hostContentByFile.get(fileName);
        const text = hostContent?.text ?? host?.readFile?.(fileName) ?? "";
        const scriptKind = hostContent?.scriptKind ?? inferScriptKind(fileName);
        const sf = createSkeletonSourceFile(fileName, text, options.target ?? 99, scriptKind);
        diagnosticSfCache.set(fileName, sf);
        return sf;
    };

    // Lightweight skeleton stub (no tsgo RPC) for getSourceFiles() —
    // BuilderProgram iterates all files for state creation but only needs
    // version + referencedFiles (metadata), not the AST. Returning the
    // skeleton avoids 1693 eager getSourceFile RPCs; only the ~700 files
    // the files actually linted pay the RPC via getSourceFile(fileName).
    const lightSfCache = new Map<string, any>();
    const getOrCreateLightSourceFile = (fileName: string): any => {
        const hostFileName = toHostFileName(fileName);
        if (lightSfCache.has(hostFileName)) return lightSfCache.get(hostFileName);
        // Metadata-only SourceFile stub: no host.readFile, no computeLineStarts,
        // no AST. BuilderProgram state creation only needs these fields to key
        // fileInfos and to ask for referenced/imported files (empty here).
        // tsserver getScriptInfos() requires ScriptInfo for every returned file;
        // default libs are not opened as ScriptInfo — exclude them here.
        const tsgoPath = hostFileName;
        const sf: any = {
            kind: SyntaxKind.SourceFile,
            fileName: hostFileName,
            path: tsgoPath,
            resolvedPath: tsgoPath,
            originalFileName: hostFileName,
            text: "",
            version: "1",
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
            endOfFileToken: { kind: SyntaxKind.EndOfFileToken, pos: 0, end: 0 },
            lineMap: [0],
            getLineStarts: () => [0],
            getLineAndCharacterOfPosition: () => ({ line: 0, character: 0 }),
            getPositionOfLineAndCharacter: () => 0,
            forEachChild: () => undefined,
        };
        lightSfCache.set(hostFileName, sf);
        return sf;
    };

    const tsgoFileArg = (fileName: string | undefined) => fileName ? toTsgoFileName(fileName) : fileName;

    const thinProgram: any = {
        getRootFileNames: () => rootNames as readonly string[],
        getCompilerOptions: () => options,
        getSourceFileNames,
        getSourceFile: (fileName: string) => getOrCreateSourceFile(fileName),
        // BuilderProgram mostly calls getSourceFileByPath while constructing
        // fileInfos / dependency state. It only needs source-file metadata
        // there, not the AST. Returning a light stub avoids eager
        // RemoteSourceFile materialisation for every program file.
        getSourceFileByPath: (path: any) => getOrCreateLightSourceFile(String(path)),
        getSourceFiles: () => {
            const names = getSourceFileNames();
            const result: any[] = [];
            for (const name of names) {
                if (isHostLibFile(name)) continue;
                const sf = getOrCreateLightSourceFile(name);
                if (sf) result.push(sf);
            }
            return result;
        },
        getTypeChecker: () => checker,
        getConfigFileParsingDiagnostics: () => configDiags,
        getOptionsDiagnostics: () => [],
        getSemanticDiagnostics: (sourceFile?: any) => {
            const raw = sourceFile?.fileName
                ? project?.program?.getSemanticDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSemanticDiagnostics?.();
            return mapTsgoDiagnostics(raw, getDiagnosticSourceFile);
        },
        getSyntacticDiagnostics: (sourceFile?: any) => {
            const raw = sourceFile?.fileName
                ? project?.program?.getSyntacticDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSyntacticDiagnostics?.();
            return mapTsgoDiagnostics(raw, getDiagnosticSourceFile);
        },
        getGlobalDiagnostics: () => mapTsgoDiagnostics(project?.program?.getGlobalDiagnostics?.(), getDiagnosticSourceFile),
        getSuggestionDiagnostics: (sourceFile?: any) => {
            const raw = sourceFile?.fileName
                ? project?.program?.getSuggestionDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSuggestionDiagnostics?.();
            return mapTsgoDiagnostics(raw, getDiagnosticSourceFile);
        },
        getDeclarationDiagnostics: (sourceFile?: any) => {
            const raw = sourceFile?.fileName
                ? project?.program?.getDeclarationDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getDeclarationDiagnostics?.();
            return mapTsgoDiagnostics(raw, getDiagnosticSourceFile);
        },
        getDiagnostics: () => [],
        getBindAndCheckDiagnostics: (sourceFile?: any) => {
            const synRaw = sourceFile?.fileName
                ? project?.program?.getSyntacticDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSyntacticDiagnostics?.();
            const semRaw = sourceFile?.fileName
                ? project?.program?.getSemanticDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSemanticDiagnostics?.();
            return [
                ...mapTsgoDiagnostics(synRaw, getDiagnosticSourceFile),
                ...mapTsgoDiagnostics(semRaw, getDiagnosticSourceFile),
            ];
        },
        getProgramDiagnostics: () => mapTsgoDiagnostics(project?.program?.getProgramDiagnostics?.(), getDiagnosticSourceFile),
        getMissingFilePaths: () => [],
        getFilesByNameMap: () => new Map(),
        getClassifiableNames: () => new Set(),
        getCommonSourceDirectory: () => "",
        getCurrentDirectory: () => host?.getCurrentDirectory?.() ?? process.cwd(),
        // Emit via tsgo: the Go emitter produces the output text, which we write
        // through the caller's writeFile (or the host's) so --noEmit, Volar output
        // redirection, and build-mode writeFile wrapping stay in the host's control.
        // emitBuildInfo returns a well-formed (skipped) result: the `tsc -b` /
        // `vue-tsc -b` solution builder reads `.emitSkipped` off it, and the Proxy's
        // no-op fallback would otherwise yield `undefined` and crash.
        emit: (targetSourceFile?: any, writeFile?: any, _ct?: any, emitOnlyDtsFiles?: boolean, _customTransformers?: any, forceDtsEmit?: boolean) => {
            // Respect --noEmit: never produce output during a type-check-only run.
            // tsgo parses options from the tsconfig on disk and may not see the CLI
            // flag, so gate here on the JS-side compiler options.
            if (options.noEmit && !forceDtsEmit) {
                return { emitSkipped: true, diagnostics: [], emittedFiles: [], sourceMaps: [] };
            }
            // DocumentIdentifier wire format is plain path string or { uri }, not { fileName }.
            const file = targetSourceFile?.fileName ? tsgoFileArg(targetSourceFile.fileName) : undefined;
            const emitOnly = forceDtsEmit ? 3 : (emitOnlyDtsFiles ? 2 : undefined);
            const res = project?.program?.emit?.({ file, emitOnly, forceDtsEmit: !!forceDtsEmit });
            const outputs = res?.outputFiles ?? [];
            const write = typeof writeFile === "function" ? writeFile : host?.writeFile?.bind(host);
            const emittedFiles: string[] = [];
            const sourceFiles = targetSourceFile ? [targetSourceFile] : undefined;
            for (const o of outputs) {
                if (write) write(o.fileName, o.text, !!o.writeByteOrderMark, undefined, sourceFiles);
                emittedFiles.push(o.fileName);
            }
            return {
                emitSkipped: res?.emitSkipped ?? false,
                diagnostics: mapTsgoDiagnostics(res?.diagnostics, getDiagnosticSourceFile),
                emittedFiles,
                sourceMaps: [],
            };
        },
        emitBuildInfo: () => ({ emitSkipped: true, diagnostics: [] }),
        isSourceFileFromExternalLibrary: () => false,
        isSourceFileDefaultLibrary: (sf: any) => {
            const fn = sf?.fileName ?? "";
            return fn.includes("/lib.") || fn.includes("/node_modules/");
        },
        getBuildInfo: () => undefined,
        getSourceFileFromReference: () => undefined,
        getFileIncludeReasons: () => new Map(),
        getModuleResolutionCache: () => undefined,
        redirectTargetsMap: new Map(),
        getGlobalTypingsCacheLocation: () => undefined,
        // BuilderProgram support
        structureIsChanged: () => false,
        getFilesWithInvalidatedResolutions: () => new Set(),
    };

    return new Proxy(thinProgram, {
        get(target: any, prop: string | symbol, receiver: any) {
            if (prop in target) return Reflect.get(target, prop, receiver);
            // Unknown methods: return no-op to avoid crashes
            if (typeof prop !== "string") return undefined;
            return typeof prop === "string" ? (..._args: any[]) => undefined : undefined;
        },
        has: (target: any, p) => p in target,
        ownKeys: () => Object.keys(thinProgram),
        getOwnPropertyDescriptor: (target: any, p) => Object.getOwnPropertyDescriptor(target, p),
    });
}

function installNodeHandleHooks(s: any): void {
    if (_nodeHandlePatched) return;
    // Patch kind remapping using a sample RemoteSourceFile from the project.
    // Done here (not at module load) because we need a tsgo instance to walk
    // the prototype chain — the classes aren't exported by the sync API.
    const NodeHandle = s.NodeHandle;
    if (!NodeHandle?.prototype) return;
    const proto = NodeHandle.prototype;
    _nodeHandlePatched = true;
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
}

/* @internal */
export function createTsgoChecker(program: any): any {
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

    // ── NAPI bridge client ───────────────────────────────────────────

    function toCStr(s: string): Buffer {
        return Buffer.from(s + "\0", "utf8");
    }

    function parseEnvelope(str: string | null): any {
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
            this.handle = Number(parseEnvelope(bridgeFns.BridgeNewSession(toCStr(cwd))));
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
            const str = bridgeFns.BridgeCall(
                this.handleBigInt, mc,
                paramsJson == null ? null : this.toCStrScratch(paramsJson),
            );
            const result = parseEnvelope(str);
            if (process.env.TSGO_PROFILE === "1") _profRpc(method, Date.now() - t0);
            return result;
        }

        apiRequestBinary(method: string, params: any): Uint8Array | undefined {
            const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
            const paramsJson = params == null ? null : JSON.stringify(params);
            let mc = this.methodCStr.get(method);
            if (!mc) { mc = toCStr(method); this.methodCStr.set(method, mc); }
            const res = bridgeFns.BridgeCallBinary(
                this.handleBigInt, mc,
                paramsJson == null ? null : this.toCStrScratch(paramsJson),
            );
            if (process.env.TSGO_PROFILE === "1") _profRpc(method, Date.now() - t0);
            const len = Number(res.len);
            if (len <= 0 || res.data == null) return undefined;
            // Decode straight into a Uint8Array (single copy out of the reused C
            // buffer). The default disposition materialises a len-element JS
            // Array of numbers and then needs a second Buffer.from copy — the
            // JS-Array boxing dominates for large AST blobs (full source text +
            // node table). "Typed" skips it (~3-4x faster decode on dify/web:
            // getSourceFile copy ~200ms -> ~55ms).
            return koffi.decode(res.data, koffi.array("uint8_t", len, "Typed")) as Uint8Array;
        }

        close(): void {
            try { bridgeFns.BridgeDisposeSession(BigInt(this.handle)); } catch { /* best-effort */ }
        }
    }

    // ── Mini source-file cache (nested-map port from napi-client.js) ──
    class MiniSourceFileCache {
        private bySnap = new Map<any, Map<any, Map<string, any>>>();
        private paths = new Set<string>();

        getRetained(p: string, snapshotId: any, projectId: any): any {
            const byProj = this.bySnap.get(snapshotId);
            if (!byProj) return undefined;
            const byPath = byProj.get(projectId);
            if (!byPath) return undefined;
            return byPath.get(p);
        }
        set(p: string, file: any, _key: any, _hash: any, snapshotId: any, projectId: any): any {
            let byProj = this.bySnap.get(snapshotId);
            if (!byProj) { byProj = new Map(); this.bySnap.set(snapshotId, byProj); }
            let byPath = byProj.get(projectId);
            if (!byPath) { byPath = new Map(); byProj.set(projectId, byPath); }
            if (!byPath.has(p)) { byPath.set(p, file); this.paths.add(p); }
            return byPath.get(p);
        }
        retainForSnapshot() {}
        releaseSnapshot() {}
        clear() { this.bySnap.clear(); this.paths.clear(); }
        has(p: string) { return this.paths.has(p); }
    }

    function ensureProject(): any {
        if (project) return project;

        // Return cached project for this tsconfig if already created.
        const cached = _projectCache.get(configFilePath!);
        if (cached) {
            project = cached;
            koffi = _koffi; sync = _sync; bridgeFns = _bridgeFns;
            _currentProjectRef.project = project;
            patchSymbolProto(sync);
            patchSignatureProto(sync);
            installNodeHandleHooks(sync);
            return project;
        }

        loadBridgeDeps();
        koffi = _koffi; sync = _sync; bridgeFns = _bridgeFns;
        if (process.env.TSGO_PROFILE === "1") _tsgoLoadStart = Date.now();

        // Create the shared bridge session + API once per process.
        if (!_client) {
            const cwd = process.cwd();
            _client = new BridgeClient(cwd);
            const init = _client.apiRequest("initialize", null) || {};
            if (!_tnbDebugAnnounced) {
                _tnbDebugAnnounced = true;
                const tty = !!(process.stderr as any).isTTY;
                const hi = tty ? "\u001b[1;42;30m" : ""; // bold, green bg, black text
                const bar = tty ? "\u001b[1;32m" : ""; // bold green
                const off = tty ? "\u001b[0m" : "";
                const line = "\u2501".repeat(56);
                process.stderr.write(
                    `\n${bar}${line}${off}\n`
                    + `${hi}  \u2705  TNB ACTIVE \u2014 \`typescript\` is the tsgo-backed fork  ${off}\n`
                    + `${bar}${line}${off}\n\n`,
                );
            }
            const useCaseSensitive = !!init.useCaseSensitiveFileNames;
            _tsgoUseCaseSensitive = useCaseSensitive;
            const toPath = (f: string) => useCaseSensitive ? f : f.toLowerCase();
            _sourceFileCache = new MiniSourceFileCache();

            _api = {
                updateSnapshot(params: any) {
                    const { openProject, openProjects, ...rest } = params || {};
                    const merged = openProject != null ? [openProject, ...(openProjects || [])] : openProjects;
                    const wireParams = { ...rest, ...(merged != null ? { openProjects: merged } : {}) };
                    const data = _client.apiRequest("updateSnapshot", wireParams);
                    const onDispose = () => {};
                    return new sync.Snapshot(data, _client, _sourceFileCache, toPath, onDispose);
                },
                close() {
                    try { _client.close(); } catch {}
                    _sourceFileCache.clear();
                },
            };
        }

        // Collect host file content to feed as tsgo overlays — makes the fork
        // host the single source of truth (avoids tsgo double disk read, and
        // enables Volar virtual TS content injection for .vue/.mdx). Only user
        // files are overlaid; lib/node_modules files are read from disk by tsgo
        // (unchanged content, avoids serializing megabytes of lib.d.ts).
        // _pendingOverlays is pre-collected from the host by createTsgoProgram
        // (only files missing on disk — typically Volar virtual documents).
        const openFilesWithContent: any[] = [];
        if (_pendingOverlays) {
            openFilesWithContent.push(..._pendingOverlays);
            _pendingOverlays = undefined;
        }

        const extraFileExtensions = _pendingExtraFileExtensions;
        _pendingExtraFileExtensions = undefined;

        const snapshot: any = _api.updateSnapshot({
            openProject: configFilePath!,
            ...(openFilesWithContent.length > 0 ? { openFilesWithContent } : {}),
            ...(extraFileExtensions ? { extraFileExtensions } : {}),
        });
        _pendingReferencedProjects = undefined;
        project = snapshot.getProject(configFilePath!);
        if (!project) {
            throw new Error(`tsgoChecker: project not found for ${configFilePath}`);
        }
        _projectCache.set(configFilePath!, project);
        _currentProjectRef.project = project;
        patchSymbolProto(sync);
        patchSignatureProto(sync);
        installNodeHandleHooks(sync);
        // Patch kind remapping using a sample source file from the tsgo project.
        const fileNames = project.program.getSourceFileNames?.() ?? [];
        if (fileNames.length > 0) {
            const sampleSf = project.program.getSourceFile(fileNames[0]);
            if (sampleSf) patchRemoteNodeKinds(sampleSf);
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
    // Files where prefetchResolvedReferences ran — skip expensive node-tree
    // fallback on cache miss; prefetch + getSymbolAtPosition is enough.
    const symPrefetchPopulated = new Set<string>();
    // Per-file index: start position → all tsgo nodes that start there.
    // Built once per file via a single AST walk, after which every
    // findTsgoNodeAtPosition call is an O(1) map lookup + a tiny kind/end
    // filter. This replaces the old per-query full AST walk that dominated
    // wall time (~8s → ~2s) — the hot path issues thousands of
    // getTypeAtLocation / getSymbolAtLocation queries per file.
    const nodeIndexCache = new Map<string, Map<number, any[]>>();

    function getTsgoSourceFile(fileName: string): any {
        const hostFileName = toHostFileName(fileName);
        if (tsgoSfCache.has(hostFileName)) return tsgoSfCache.get(hostFileName);
        const proj = ensureProject();
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
        if (symPrefetched.has(fileName)) return;
        // Batch-prefetch every identifier symbol in the file in one RPC. Skip
        // lib / node_modules files: the scope manager only queries user-file
        // identifiers, but BuilderState.getReferencedFiles walks ALL program
        // files (incl. lib.d.ts) calling getSymbolAtLocation on imports —
        // which would prefetch all 1158 files (440k refs) instead of the ~45
        // user files (34k refs). Gate to user files to keep ~1.2x
        // over-enumeration (well above break-even).
        if (fileName.includes("/node_modules/") || /\/lib\.[^/]*\.d\.ts$/.test(fileName)) {
            symPrefetched.add(fileName);
            return;
        }
        symPrefetched.add(fileName);
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        let byPos: Map<number, any>;
        if (typeof project.checker.prefetchResolvedReferences === "function") {
            byPos = project.checker.prefetchResolvedReferences(toTsgoFileName(fileName));
        } else {
            return;
        }
        let fileCache = symByPos.get(fileName);
        if (!fileCache) {
            fileCache = new Map();
            symByPos.set(fileName, fileCache);
        }
        for (const [pos, sym] of byPos) {
            fileCache.set(pos, sym);
        }
        symPrefetchPopulated.add(fileName);
        if (process.env.TSGO_PROFILE === "1") {
            _stats.symPrefetchFiles++;
            _stats.symPrefetchRefs += byPos.size;
            _stats.symPrefetchMs += Date.now() - t0;
        }
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
        let result: any = sf;
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
            }
        }
        fileCache.set(cacheKey, result);
        return result;
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
        if (!target.isClassOrInterface) target.isClassOrInterface = () => false;
        if (!target.isClass) target.isClass = () => false;
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
                    const types = this.getTypes ? this.getTypes() : undefined;
                    if (types) for (const c of types) fixupType(c);
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
                return getSignaturesCached(this, SK.Call);
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
                const proj = _currentProjectRef.project;
                if (!proj) return undefined;
                // Share the adapter's (type,name) cache so getProperty() and
                // checker.getPropertyOfType() dedupe across both call paths.
                let byName = propertyByNameCache.get(this);
                if (!byName) { byName = new Map<string, any>(); propertyByNameCache.set(this, byName); }
                if (byName.has(name)) return byName.get(name);
                const r = proj.checker.getPropertyOfType(this, name);
                byName.set(name, r);
                return r;
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
                return t;
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

    const memoGet = <K, V>(cache: Map<K, V>, key: K, compute: () => V): V => {
        if (cache.has(key)) return cache.get(key)!;
        const v = compute();
        cache.set(key, v);
        return v;
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

    // ── Node-based type computation (port from tsgo-backend.js) ──────
    // Handles assertion expressions, call expressions, and property access
    // specially — these are the cases where getTypeAtPosition diverges from
    // getTypeAtLocation(tsgoNode).
    function computeGetTypeAtLocation(tsgoNode: any): any {
        const k = tsgoNode.kind;
        // AsExpression / TypeAssertion / Satisfies — return the asserted type
        // from the type annotation, not the inner expression type.
        if ((k === SyntaxKind.AsExpression
            || k === SyntaxKind.TypeAssertionExpression
            || k === SyntaxKind.SatisfiesExpression)
            && tsgoNode.type) {
            const t = project.checker.getTypeFromTypeNode(tsgoNode.type);
            if (t) fixupType(t);
            return t;
        }
        // CallExpression / NewExpression — resolve signature → return type,
        // with fallbacks to getTypeAtLocation + getSignaturesOfType.
        if (k === SyntaxKind.CallExpression || k === SyntaxKind.NewExpression) {
            try {
                const sig = project.checker.getResolvedSignature(tsgoNode);
                if (sig) {
                    const t = project.checker.getReturnTypeOfSignature(sig);
                    if (t) { fixupType(t); return t; }
                }
            } catch { /* fall through */ }
            try {
                const funcType = project.checker.getTypeAtLocation(tsgoNode);
                if (funcType) {
                    fixupType(funcType);
                    const sigs = project.checker.getSignaturesOfType(funcType, sync.SignatureKind.Call);
                    if (sigs && sigs.length > 0) {
                        const t = project.checker.getReturnTypeOfSignature(sigs[0]);
                        if (t) { fixupType(t); return t; }
                    }
                }
            } catch { /* fall through */ }
        }
        // PropertyAccessExpression — use getTypeAtPosition at the node END (not
        // start) for correct resolution; the end lands on the property name so
        // the type resolves correctly.
        //
        // ElementAccessExpression deliberately falls through to the default
        // node-based getTypeAtLocation below: its END position is the `]`
        // token, where getTypeAtPosition resolves to `any` (or the wrong
        // contextual type), dropping the `| undefined` that
        // noUncheckedIndexedAccess adds to indexed element access. That made
        // `arr[i]!` non-null assertions look unnecessary (false-positive
        // no-unnecessary-type-assertion). getTypeAtLocation(node) resolves the
        // indexed-access element type (incl. `| undefined`) correctly.
        if (k === SyntaxKind.PropertyAccessExpression) {
            const sfPath = tsgoNode.getSourceFile?.()?.fileName;
            if (sfPath) {
                const t = project.checker.getTypeAtPosition(toTsgoFileName(sfPath), tsgoNode.end);
                if (t) { fixupType(t); return t; }
            }
        }
        // NonNullExpression — inner type with non-nullable wrapper.
        if (k === SyntaxKind.NonNullExpression) {
            const inner = tsgoNode.expression;
            if (inner) {
                const innerT = computeGetTypeAtLocation(inner);
                if (innerT) return project.checker.getNonNullableType(innerT);
            }
        }
        // Default — node-based getTypeAtLocation.
        const t = project.checker.getTypeAtLocation(tsgoNode);
        if (t) fixupType(t);
        return t;
    }

    // ── Build adapter object ─────────────────────────────────────────
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
            ensureFileSymbolsPrefetched(sf.fileName);
            const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
            const end = node.getEnd(sf);
            let fileCache = symByPos.get(sf.fileName);
            if (fileCache?.has(end)) {
                if (process.env.TSGO_PROFILE === "1") {
                    const d = Date.now() - t0;
                    _stats.getSymCount++;
                    _stats.getSymMs += d;
                    _stats.getSymHitCount++;
                }
                return fileCache.get(end);
            }
            if (!fileCache) {
                fileCache = new Map();
                symByPos.set(sf.fileName, fileCache);
            }
            let sym: any = project.checker.getSymbolAtPosition(toTsgoFileName(sf.fileName), end);
            if (!sym && !symPrefetchPopulated.has(sf.fileName)) {
                const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
                if (tsgoNode) {
                    sym = project.checker.getSymbolAtLocation(tsgoNode);
                }
            }
            fileCache.set(end, sym);
            if (process.env.TSGO_PROFILE === "1") {
                const d = Date.now() - t0;
                _stats.getSymCount++;
                _stats.getSymMs += d;
                _stats.getSymRpcCount++;
            }
            return sym;
        },
        getTypeOfSymbolAtLocation(symbol: any, location: any): any {
            ensureProject();
            const sf = location.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, location.getStart(sf), location.kind, location.getEnd(sf));
            if (!tsgoNode) return undefined;
            const t = project.checker.getTypeOfSymbolAtLocation(symbol, tsgoNode);
            if (t) fixupType(t);
            return t;
        },
        getContextualType(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            const t = project.checker.getContextualType(tsgoNode);
            if (t) fixupType(t);
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
        // Needed by computeGetTypeAtLocation for AsExpression handling.
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
                const t = project.checker.getTypeOfSymbol(symbol);
                if (t) fixupType(t);
                return t;
            });
        },
        getDeclaredTypeOfSymbol(symbol: any): any {
            if (!symbol) return undefined;
            ensureProject();
            const t = project.checker.getDeclaredTypeOfSymbol(symbol);
            if (t) fixupType(t);
            return t;
        },
        // Symbol-only queries the scope manager uses — see delegation in the
        // stubs section below (getShorthandAssignmentValueSymbol etc.).

        typeToString(type: any, _enclosing?: any, flags?: number): string {
            ensureProject();
            return project.checker.typeToString(type, undefined, flags);
        },
        getPropertiesOfType(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            return memoGet(propertiesCache, type, () => project.checker.getPropertiesOfType(type) ?? []);
        },
        getPropertyOfType(type: any, name: string): any {
            ensureProject();
            if (!type) return undefined;
            // Direct (type, name) → result cache. The first call for each
            // (type, name) pair pays the RPC; repeats are pure JS lookups.
            let byName = propertyByNameCache.get(type);
            if (!byName) {
                byName = new Map<string, any>();
                propertyByNameCache.set(type, byName);
            }
            if (byName.has(name)) return byName.get(name);
            const direct = project.checker.getPropertyOfType(type, name);
            byName.set(name, direct);
            return direct;
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

        // ── Diagnostics — empty for PoC ──
        getSuggestionDiagnostics(): readonly any[] { return []; },
        getGlobalDiagnostics(): readonly any[] { return []; },
        getDiagnostics(): readonly any[] { return []; },
        getAmbientModules(): readonly any[] { return []; },

        // ── Stubs ──
        getSymbolsInScope: () => [],
        getExportSpecifierLocalTargetSymbol(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            try {
                return project.checker.getExportSpecifierLocalTargetSymbol(tsgoNode);
            } catch { return undefined; }
        },
        getShorthandAssignmentValueSymbol(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            try {
                return project.checker.getShorthandAssignmentValueSymbol(tsgoNode);
            } catch { return undefined; }
        },
        getAliasedSymbol: () => undefined,
        getImmediateAliasedSymbol: () => undefined,
        // Merging is a TS-specific concern; tsgo symbols are already merged.
        getMergedSymbol: (s: any) => s,
        // Emit resolver — the lint path doesn't emit; return a minimal
        // stub if code reads properties off it.
        getEmitResolver: () => ({ getExternalModuleIndicator: () => false }),
        // resolveName needs scope walking; not available via tsgo position RPC.
        resolveName: () => undefined,

        // ── Counts (for getProgramDiagnostics etc.) ──
        getNodeCount: () => 0,
        getIdentifierCount: () => 0,
        getSymbolCount: () => 0,
        getTypeCount: () => 0,
        getInstantiationCount: () => 0,
        getRelationCacheSizes: () => ({ assignable: 0, identity: 0, subtype: 0, strictSubtype: 0 }),
    };

    // Proxy: unknown methods → lazily forward to tsgo checker if it has them,
    // else return a no-op that yields undefined / [] (feature-detect friendly;
    // many callers iterate the result, so returning a callable is safer than
    // undefined).
    // Eagerly create the tsgo project so program.getSourceFile() can return
    // tsgo-backed files before any checker method is invoked by rules.
    ensureProject();

    return new Proxy(adapter, {
        get(target: any, prop: string | symbol, receiver: any) {
            if (prop in target) return Reflect.get(target, prop, receiver);
            if (typeof prop !== "string") return undefined;
            ensureProject();
            if (typeof project.checker[prop] === "function") {
                return (...args: any[]) => project.checker[prop](...args);
            }
            // Unknown method — return a no-op so `checker.foo()` doesn't throw.
            // Most callers feature-detect or iterate; returning undefined from
            // the call covers both `if (x)` and `for (const i of x ?? [])`.
            return (..._args: any[]) => undefined;
        },
        has(target: any, p) { return p in target; },
    });
}
