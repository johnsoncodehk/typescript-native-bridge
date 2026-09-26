// NAPI transport to the in-process tsgo session: the JSON and V8-arena
// clients, the decoded-source-file cache and RPC accounting. It knows the
// wire, not what the payloads mean — that is the checker adapter
// (tsgoChecker.ts).

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

import { isBundledLibPath, isHostLibFile } from "./tsgoLibPaths.js";
import { tnbBridgeProcessState } from "./tsgoProcessState.js";

// ── RPC / invalidation trace (default OFF; TNB_TRACE_RPC=1) ──
// Writes ENTER/EXIT + EVENT lines to TNB_TRACE_RPC_FILE (default /tmp/tnb-rpc.log).
// Zero overhead when unset: the flag is snapshotted once at module load.
let _rpcTraceSeq = 0;
export const rpcTraceEnabled: boolean = process.env.TNB_TRACE_RPC === "1";
const _rpcTraceLog: string = rpcTraceEnabled
    ? (process.env.TNB_TRACE_RPC_FILE || "/tmp/tnb-rpc.log")
    : "";
const _rpcTraceEnterTs = new Map<number, number>();
function rpcTraceEnter(method: string, binary: boolean, session: number): number {
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
function rpcTraceExit(id: number, method: string): void {
    if (!_rpcTraceLog || id === 0) return;
    const now = Date.now();
    const t0 = _rpcTraceEnterTs.get(id);
    _rpcTraceEnterTs.delete(id);
    const ms = t0 != null ? now - t0 : -1;
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(_rpcTraceLog, `${now} EXIT ${id} ${method} ms=${ms}\n`);
}
/** Event channel for cache invalidation / structure reuse (same env gate). */
export function rpcTraceEvent(kind: string, detail: string): void {
    if (!_rpcTraceLog) return;
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(_rpcTraceLog, `${Date.now()} EVENT ${kind} ${detail}\n`);
}

// ── RPC profile (TSGO_PROFILE=1) ──
export const rpcProfile: { count: number; ms: number; byMethod: Map<string, { count: number; ms: number }> } = {
    count: 0,
    ms: 0,
    byMethod: new Map<string, { count: number; ms: number }>(),
};
function profRpc(method: string, ms: number): void {
    if (process.env.TSGO_PROFILE !== "1") return;
    rpcProfile.count++;
    rpcProfile.ms += ms;
    let b = rpcProfile.byMethod.get(method);
    if (!b) { b = { count: 0, ms: 0 }; rpcProfile.byMethod.set(method, b); }
    b.count++;
    b.ms += ms;
}

// ── getSourceFile RPC regression guard ──
// The things worth guarding at runtime: (a) the getSourceFile RPC count — the
// light-stub path exists to avoid eagerly materializing tsgo-backed SFs for
// every program file, so a regression there shows up as an RPC spike; and
// (b) the total RPC count as a liveness signal — build mode (batched
// diagnostics) legitimately pays ZERO getSourceFile RPCs, so only the total
// proves the tsgo-backed path actually ran. CI checks both against a baseline
// (tools/check-sourcefile-guard.mjs).

export const guardStats: { totalRpcCount: number; getSourceFileRpcCount: number } = tnbBridgeProcessState().guardStats ??= {
    totalRpcCount: 0,
    getSourceFileRpcCount: 0,
};

function noteRpc(method: string): void {
    guardStats.totalRpcCount++;
    if (method === "getSourceFile") {
        guardStats.getSourceFileRpcCount++;
    }
    scheduleGuardStatsFlush();
}

function maybeWriteGuardStatsFile(): void {
    const out = process.env.TNB_GUARD_STATS_FILE;
    if (!out) return;
    // Per-pid output: the workload process (e.g. a spawned vue-tsc CLI) and the
    // test runner are different processes that share this env var; the guard
    // tool sums every `${out}.<pid>` file. Last-writer-wins on a single file
    // would zero out the counts (runner outlives the workload and has none).
    try {
        const fs = require("fs") as typeof import("fs");
        fs.writeFileSync(`${out}.${process.pid}`, JSON.stringify({
            totalRpcCount: guardStats.totalRpcCount,
            getSourceFileRpcCount: guardStats.getSourceFileRpcCount,
        }));
    }
    catch { /* best-effort */ }
}

let guardStatsFlushScheduled = false;
// Snapshotted once at module load: noteRpc runs per RPC and process.env
// lookups are dictionary reads (issue #11 perf).
const guardStatsEnabled = !!process.env.TNB_GUARD_STATS_FILE;
function scheduleGuardStatsFlush(): void {
    if (!guardStatsEnabled || guardStatsFlushScheduled) return;
    guardStatsFlushScheduled = true;
    setImmediate(() => {
        guardStatsFlushScheduled = false;
        maybeWriteGuardStatsFile();
    });
}

if (guardStatsEnabled) {
    process.on("exit", maybeWriteGuardStatsFile);
    process.on("beforeExit", maybeWriteGuardStatsFile);
}

export class BridgeClient {
    private handle: number;
    private handleBigInt: bigint;
    private arena: ArenaClient | undefined;

    constructor(cwd: string, private readonly fns: any) {
        this.handle = this.fns.BridgeNewSession(cwd);
        this.handleBigInt = BigInt(this.handle);
    }

    apiRequest(method: string, params: any): any {
        // Arena-capable hot query classes ride the binary transport (part 3);
        // everything else keeps the JSON path.
        if (ARENA_METHODS.has(method)) {
            this.arena ??= new ArenaClient(this.handle, this.fns);
            return this.arena.apiRequest(method, params);
        }
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        noteRpc(method);
        const paramsJson = params == null ? null : JSON.stringify(params);
        const traceId = rpcTraceEnter(method, false, this.handle);
        const r = this.fns.BridgeCall(this.handleBigInt, method, paramsJson);
        rpcTraceExit(traceId, method);
        // Envelope-free: scalars (null/bool) arrive as JS values; a string is
        // the raw result JSON (objects/arrays/string results) to parse.
        const result = typeof r === "string" ? JSON.parse(r) : r;
        if (process.env.TSGO_PROFILE === "1") profRpc(method, Date.now() - t0);
        return result;
    }

    apiRequestBinary(method: string, params: any): Uint8Array | undefined {
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        noteRpc(method);
        const paramsJson = params == null ? null : JSON.stringify(params);
        const traceId = rpcTraceEnter(method, true, this.handle);
        // NAPI addon returns the blob as a V8-allocated Buffer (one memcpy
        // out of the pinned Go slice — the irreducible sandbox crossing;
        // external buffers are not sandbox-legal on Electron), or null for
        // empty results.
        const buf = this.fns.BridgeCallBinary(this.handleBigInt, method, paramsJson);
        rpcTraceExit(traceId, method);
        if (process.env.TSGO_PROFILE === "1") profRpc(method, Date.now() - t0);
        return buf ?? undefined;
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
        try { this.fns.BridgeDisposeSession(BigInt(this.handle)); } catch { /* best-effort */ }
    }
}

// ── V8-arena binary transport (part 3) ─────────────────────────────────
// One session-scoped, V8-allocated buffer: requests are fixed-shape records
// at offset 0, responses are header + records + packed strings at
// arenaRespOffset. Only the measured hot scalar/record query classes ride it
// (the table below mirrors the Go dispatcher's); document payloads keep the
// JSON path. Arena memory is V8-owned — sandbox-legal by construction.
const ARENA_SIZE = 4 * 1024 * 1024;
const ARENA_RESP_OFFSET = 1 << 20;
const ARENA_KIND_NULL = 0;
const ARENA_KIND_RECORD = 1;
const ARENA_KIND_ERROR = 4;

type ArenaMethodKind = "node" | "type" | "typeKind" | "typeStr" | "symbol" | "symbolNode" | "filePos" | "filePosHover" | "signature" | "contextual" | "contextualArg" | "intrinsic" | "typeName" | "literalStr" | "literalNum" | "symbolChain" | "twoHandles" | "thisAt" | "symbolArray" | "completions" | "filePosReason" | "filePosRename";
type ArenaResultKind = "type" | "types" | "symbol" | "symbols" | "signature" | "signatures" | "string" | "bool" | "quickinfo" | "referencedSymbols" | "definitionAndBoundSpan" | "jsdocTags" | "expandedParams" | "ambientModules" | "completionInfo" | "signatureHelpItems" | "renameInfo" | "renameLocations";
// Method → [request shape, result shape] (must mirror arena_dispatch.go and
// the Go handlers' return types exactly).
const ARENA_METHODS: ReadonlyMap<string, [ArenaMethodKind, ArenaResultKind]> = new Map([
    ["getTypeAtLocation", ["node", "type"]],
    ["getSymbolAtLocation", ["node", "symbol"]],
    ["getResolvedSignature", ["node", "signature"]],
    ["getContextualType", ["contextual", "type"]],
    ["getContextualTypeForArgumentAtIndex", ["contextualArg", "type"]],
    ["getApparentType", ["type", "type"]],
    ["getBaseTypeOfLiteralType", ["type", "type"]],
    ["getNonNullableType", ["type", "type"]],
    ["getTypeArguments", ["type", "types"]],
    ["getBaseTypes", ["type", "types"]],
    ["getPropertiesOfType", ["type", "symbols"]],
    ["getSymbolOfType", ["type", "symbol"]],
    ["getTypesOfType", ["type", "types"]],
    ["getFreshTypeOfType", ["type", "type"]],
    ["getRegularTypeOfType", ["type", "type"]],
    ["getTargetOfType", ["type", "type"]],
    ["getThisTypeOfType", ["type", "type"]],
    ["getObjectTypeOfType", ["type", "type"]],
    ["getCheckTypeOfType", ["type", "type"]],
    ["getExtendsTypeOfType", ["type", "type"]],
    ["getBaseTypeOfType", ["type", "type"]],
    ["getTypeParametersOfType", ["type", "types"]],
    ["getOuterTypeParametersOfType", ["type", "types"]],
    ["getLocalTypeParametersOfType", ["type", "types"]],
    ["getAliasTypeArgumentsOfType", ["type", "types"]],
    ["isArrayType", ["type", "bool"]],
    ["typeToString", ["typeStr", "string"]],
    ["getSignaturesOfType", ["typeKind", "signatures"]],
    ["getTypeOfSymbolAtLocation", ["symbolNode", "type"]],
    ["getTypeOfSymbol", ["symbol", "type"]],
    ["getDeclaredTypeOfSymbol", ["symbol", "type"]],
    ["getSymbolAtPosition", ["filePos", "symbol"]],
    ["getReturnTypeOfSignature", ["signature", "type"]],
    ["getParametersOfSignature", ["signature", "symbols"]],
    ["quickinfo", ["filePosHover", "quickinfo"]],
    ["references", ["filePos", "referencedSymbols"]],
    ["definitionAndBoundSpan", ["filePos", "definitionAndBoundSpan"]],
    // issue #12 candidate 2: record-shaped query classes.
    ["getAliasedSymbol", ["symbol", "symbol"]],
    ["getImmediateAliasedSymbol", ["symbol", "symbol"]],
    ["getRootSymbols", ["symbol", "symbols"]],
    ["getExportsOfModule", ["symbol", "symbols"]],
    ["getExportsAndPropertiesOfModule", ["symbol", "symbols"]],
    ["getExportsOfSymbol", ["symbol", "symbols"]],
    ["getMembersOfSymbol", ["symbol", "symbols"]],
    ["getParentOfSymbol", ["symbol", "symbol"]],
    ["getExportSymbolOfSymbol", ["symbol", "symbol"]],
    ["getGlobalExportsOfSymbol", ["symbol", "symbols"]],
    ["getDocumentationComment", ["symbol", "string"]],
    ["resolveExternalModuleSymbol", ["symbol", "symbol"]],
    ["symbolIsValue", ["symbol", "bool"]],
    ["getLocalTypeParametersOfClassOrInterfaceOrTypeAlias", ["symbol", "types"]],
    ["getJsDocTags", ["symbol", "jsdocTags"]],
    ["collectVisitedTypeParameters", ["type", "types"]],
    ["createArrayType", ["type", "type"]],
    ["createPromiseType", ["type", "type"]],
    ["getAugmentedPropertiesOfType", ["type", "symbols"]],
    ["getAwaitedType", ["type", "type"]],
    ["getBaseConstraintOfType", ["type", "type"]],
    ["getConstraintOfTypeParameter", ["type", "type"]],
    ["getDefaultFromTypeParameter", ["type", "type"]],
    ["getElementTypeOfArrayType", ["type", "type"]],
    ["getExactOptionalProperties", ["type", "symbols"]],
    ["getIndexedAccessIndexType", ["type", "type"]],
    ["getPromisedTypeOfPromise", ["type", "type"]],
    ["getWidenedLiteralType", ["type", "type"]],
    ["isEmptyAnonymousObjectType", ["type", "bool"]],
    ["isLibType", ["type", "bool"]],
    ["isNullableType", ["type", "bool"]],
    ["isTupleType", ["type", "bool"]],
    ["typeHasCallOrConstructSignatures", ["type", "bool"]],
    ["getConstraintOfType", ["type", "type"]],
    ["getFalseTypeOfConditionalType", ["type", "type"]],
    ["getTrueTypeOfConditionalType", ["type", "type"]],
    ["getAliasSymbolOfType", ["type", "symbol"]],
    ["getAnyType", ["intrinsic", "type"]],
    ["getBigIntType", ["intrinsic", "type"]],
    ["getBooleanType", ["intrinsic", "type"]],
    ["getESSymbolType", ["intrinsic", "type"]],
    ["getErrorType", ["intrinsic", "type"]],
    ["getNeverType", ["intrinsic", "type"]],
    ["getNonPrimitiveType", ["intrinsic", "type"]],
    ["getNullType", ["intrinsic", "type"]],
    ["getNumberType", ["intrinsic", "type"]],
    ["getOptionalType", ["intrinsic", "type"]],
    ["getPromiseLikeType", ["intrinsic", "type"]],
    ["getPromiseType", ["intrinsic", "type"]],
    ["getStringType", ["intrinsic", "type"]],
    ["getUndefinedType", ["intrinsic", "type"]],
    ["getUnknownType", ["intrinsic", "type"]],
    ["getVoidType", ["intrinsic", "type"]],
    ["getAnyAsyncIterableType", ["intrinsic", "type"]],
    ["containsArgumentsReference", ["node", "bool"]],
    ["getContextualTypeForJsxAttribute", ["node", "type"]],
    ["getTypeArgumentConstraint", ["node", "type"]],
    ["getTypeOfAssignmentPattern", ["node", "type"]],
    ["isDeclarationVisible", ["node", "bool"]],
    ["isImplementationOfOverload", ["node", "bool"]],
    ["isOptionalParameter", ["node", "bool"]],
    ["requiresAddingImplicitUndefined", ["node", "bool"]],
    ["getJsxFragmentFactory", ["node", "string"]],
    ["getJsxIntrinsicTagNamesAt", ["node", "symbols"]],
    ["getPropertySymbolOfDestructuringAssignment", ["node", "symbol"]],
    ["getSignatureFromDeclaration", ["node", "signature"]],
    ["getExportSpecifierLocalTargetSymbol", ["node", "symbol"]],
    ["resolveExternalModuleName", ["node", "symbol"]],
    ["getRestTypeOfSignature", ["signature", "type"]],
    ["getTypeArgumentsForResolvedSignature", ["signature", "types"]],
    ["getTargetOfSignature", ["signature", "symbol"]],
    ["getThisParameterOfSignature", ["signature", "symbol"]],
    ["getTypeParametersOfSignature", ["signature", "types"]],
    ["hasEffectiveRestParameter", ["signature", "bool"]],
    ["getExpandedParameters", ["signature", "expandedParams"]],
    ["getPropertyOfType", ["typeName", "symbol"]],
    ["getTypeOfPropertyOfType", ["typeName", "type"]],
    ["getTypeOfPropertyOfContextualType", ["typeName", "type"]],
    ["getStringLiteralType", ["literalStr", "type"]],
    ["getBigIntLiteralType", ["literalStr", "type"]],
    ["getNumberLiteralType", ["literalNum", "type"]],
    ["getTypeAtPosition", ["filePos", "type"]],
    ["getModuleSymbolForSourceFile", ["filePos", "symbol"]],
    ["getAccessibleSymbolChain", ["symbolChain", "symbols"]],
    ["getCandidateSignaturesForStringLiteralCompletions", ["twoHandles", "signatures"]],
    ["tryGetThisTypeAt", ["thisAt", "type"]],
    ["getSymbolsDeclarations", ["symbolArray", "symbols"]],
    ["getParentsOfSymbols", ["symbolArray", "symbols"]],
    ["getAmbientModules", ["intrinsic", "ambientModules"]],
    ["getCompletionsAtPosition", ["completions", "completionInfo"]],
    ["signatureHelp", ["filePosReason", "signatureHelpItems"]],
    ["getRenameInfo", ["filePosRename", "renameInfo"]],
    ["getEditsForRename", ["filePosRename", "renameLocations"]],
]);

class ArenaClient {
    private readonly buf: Buffer;
    private readonly view: DataView;
    private readonly dec = new TextDecoder();
    private readonly strTab: string[] = [""]; // id 0 = absent

    constructor(private readonly handle: number, private readonly fns: any) {
        this.buf = Buffer.alloc(ARENA_SIZE);
        this.fns.BridgeSetArena(handle, this.buf);
        this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    }

    apiRequest(method: string, params: any): any {
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        noteRpc(method);
        const traceId = rpcTraceEnter(method, true, this.handle);
        const r = this.request(method, params);
        rpcTraceExit(traceId, method);
        if (process.env.TSGO_PROFILE === "1") profRpc(method, Date.now() - t0);
        return r;
    }

    private request(method: string, params: any): any {
        const v = this.view;
        const b = this.buf;
        let writeOff = 256; // strings live after the fixed head
        const putStr = (s: string, off: number): void => {
            const n = b.write(s, writeOff, "utf8");
            v.setUint32(off, writeOff, true);
            v.setUint32(off + 4, n, true);
            writeOff += n;
        };
        // head: snapshot u64 @0, project str @8
        v.setBigUint64(0, BigInt(params.snapshot ?? 0), true);
        putStr(String(params.project ?? ""), 8);
        const putHandle = (handle: string | undefined, off: number): void => {
            if (handle == null) {
                // Absent-handle sentinel (index 0, kind 0, empty path — decodes
                // to "0.0." on the Go side; dispatchers map it to no node).
                v.setUint32(off, 0, true);
                v.setUint32(off + 4, 0, true);
                v.setUint32(off + 8, 0, true);
                v.setUint32(off + 12, 0, true);
                return;
            }
            // "index.kind.path" — split at the first two dots.
            const d1 = handle.indexOf(".");
            const d2 = handle.indexOf(".", d1 + 1);
            v.setUint32(off, Number(handle.slice(0, d1)), true);
            v.setUint32(off + 4, Number(handle.slice(d1 + 1, d2)), true);
            putStr(handle.slice(d2 + 1), off + 8);
        };
        const typeId = params.type ?? params.objectId ?? 0;
        // Registry-level fetches (fetchSymbol/fetchSymbols — getExportsOfSymbol,
        // getMembersOfSymbol, …) key the same handle as `objectId`; checker
        // methods send `symbol`.
        const symbolId = params.symbol ?? params.objectId ?? 0;
        switch (ARENA_METHODS.get(method)![0]) {
            case "node":
                putHandle(params.location, 16);
                break;
            case "contextual":
                putHandle(params.location, 16);
                v.setInt32(32, params.contextFlags ?? 0, true);
                break;
            case "contextualArg":
                putHandle(params.location, 16);
                v.setInt32(32, params.argIndex ?? 0, true);
                break;
            case "type":
                v.setUint32(16, typeId >>> 0, true);
                break;
            case "typeKind":
                v.setUint32(16, typeId >>> 0, true);
                v.setInt32(20, params.kind ?? 0, true);
                break;
            case "typeStr":
                v.setUint32(16, typeId >>> 0, true);
                v.setInt32(20, params.flags ?? 0, true);
                if (params.location != null) putHandle(params.location, 24);
                else { v.setUint32(24, 0, true); v.setUint32(28, 0, true); v.setUint32(32, 0, true); v.setUint32(36, 0, true); }
                break;
            case "symbol":
                v.setBigUint64(16, BigInt(symbolId), true);
                break;
            case "symbolNode":
                v.setBigUint64(16, BigInt(symbolId), true);
                putHandle(params.location, 24);
                break;
            case "filePos":
                putStr(String(params.file ?? ""), 16);
                v.setUint32(24, params.position >>> 0, true);
                break;
            case "filePosHover":
                putStr(String(params.file ?? ""), 16);
                v.setUint32(24, params.position >>> 0, true);
                v.setInt32(28, params.maximumHoverLength ?? 0, true);
                v.setInt32(32, params.verbosityLevel ?? -1, true);
                break;
            case "intrinsic":
                break;
            case "typeName":
                v.setUint32(16, typeId >>> 0, true);
                putStr(String(params.name ?? ""), 20);
                break;
            case "literalStr":
                putStr(String(params.value ?? ""), 16);
                break;
            case "literalNum":
                v.setFloat64(16, Number(params.value ?? 0), true);
                break;
            case "symbolChain":
                v.setBigUint64(16, BigInt(symbolId), true);
                putHandle(params.enclosingDeclaration, 24);
                v.setUint32(40, params.meaning >>> 0, true);
                v.setUint32(44, params.useOnlyExternalAliasing ? 1 : 0, true);
                break;
            case "twoHandles":
                putHandle(params.call, 16);
                putHandle(params.editingArgument, 32);
                break;
            case "thisAt":
                putHandle(params.location, 16);
                v.setUint32(32, params.includeGlobalThis ? 1 : 0, true);
                if (params.container != null) putHandle(String(params.container), 36);
                else { v.setUint32(36, 0, true); v.setUint32(40, 0, true); v.setUint32(44, 0, true); v.setUint32(48, 0, true); }
                break;
            case "symbolArray": {
                const ids = params.symbols ?? [];
                v.setUint32(20, ids.length, true);
                if (ids.length) {
                    v.setUint32(16, writeOff, true);
                    for (const id of ids) {
                        v.setBigUint64(writeOff, BigInt(id), true);
                        writeOff += 8;
                    }
                } else {
                    v.setUint32(16, 0, true);
                }
                break;
            }
            case "filePosReason": {
                putStr(String(params.file ?? ""), 16);
                v.setUint32(24, params.position >>> 0, true);
                if (params.triggerReason != null) putStr(String(params.triggerReason), 28);
                else { v.setUint32(28, 0, true); v.setUint32(32, 0, true); }
                break;
            }
            case "filePosRename": {
                putStr(String(params.file ?? ""), 16);
                v.setUint32(24, params.position >>> 0, true);
                const tri2 = (b: any) => b === true ? 1 : b === false ? 2 : 0;
                if (method === "getEditsForRename") {
                    // Go contract: findInStrings u8 @28, findInComments u8 @29, providePrefixSuffix tri byte @30.
                    v.setUint8(28, params.findInStrings ? 1 : 0);
                    v.setUint8(29, params.findInComments ? 1 : 0);
                    v.setUint8(30, tri2(params.providePrefixAndSuffixTextForRename));
                }
                else {
                    // Go contract: allowRenameOfImportPath tri byte @28, providePrefixSuffix tri byte @29.
                    v.setUint8(28, tri2(params.allowRenameOfImportPath));
                    v.setUint8(29, tri2(params.providePrefixAndSuffixTextForRename));
                }
                break;
            }
            case "completions": {
                putStr(String(params.file ?? ""), 16);
                v.setUint32(24, params.position >>> 0, true);
                if (params.triggerCharacter != null) putStr(String(params.triggerCharacter), 28);
                else { v.setUint32(28, 0, true); v.setUint32(32, 0, true); }
                v.setUint32(36, params.includeSymbol ? 1 : 0, true);
                const tri = (b: any) => b === true ? 1 : b === false ? 2 : 0;
                const prefs = params.preferences ?? {};
                v.setUint8(40, tri(prefs.includeCompletionsForModuleExports));
                v.setUint8(41, tri(prefs.includeCompletionsForImportStatements));
                v.setUint8(42, tri(prefs.includeAutomaticOptionalChainCompletions));
                v.setUint8(43, tri(prefs.includeCompletionsWithClassMemberSnippets));
                v.setUint8(44, tri(prefs.includeCompletionsWithObjectLiteralMethodSnippets));
                break;
            }
            case "signature":
                v.setBigUint64(16, BigInt(params.signature ?? params.objectId ?? 0), true);
                break;
            default:
                throw new Error(`arena: method not arena-capable: ${method}`);
        }
        const escape = this.fns.BridgeCallArena(this.handle, method);
        // Oversize responses that don't fit the arena cross out-of-band as the
        // JSON doc the JSON transport would have produced.
        if (typeof escape === "string") return JSON.parse(escape);
        return this.response(method);
    }

    private response(method: string): any {
        const v = this.view;
        const kind = v.getUint8(ARENA_RESP_OFFSET);
        const newStrOff = v.getUint32(ARENA_RESP_OFFSET + 8, true); // absolute arena offset
        const newStrLen = v.getUint32(ARENA_RESP_OFFSET + 12, true);
        // Sync the string table: [count u32][(len u32)(bytes)…], ids implicit.
        if (newStrLen > 0) {
            const count = v.getUint32(newStrOff, true);
            let p = newStrOff + 4;
            for (let i = 0; i < count; i++) {
                const n = v.getUint32(p, true);
                this.strTab.push(this.dec.decode(this.buf.subarray(p + 4, p + 4 + n)));
                p += 4 + n;
            }
        }
        switch (kind) {
            case ARENA_KIND_NULL:
                return null;
            case ARENA_KIND_ERROR: {
                const o = v.getUint32(ARENA_RESP_OFFSET + 16, true);
                const n = v.getUint32(ARENA_RESP_OFFSET + 20, true);
                throw new Error(this.dec.decode(this.buf.subarray(o, o + n)));
            }
            case ARENA_KIND_RECORD:
                break;
            default:
                throw new Error(`arena: bad response kind ${kind} for ${method}`);
        }
        const resKind = ARENA_METHODS.get(method)![1];
        // Scalar payloads have no count slot — they start at +16.
        if (resKind === "string") {
            const o = v.getUint32(ARENA_RESP_OFFSET + 16, true);
            const n = v.getUint32(ARENA_RESP_OFFSET + 20, true);
            return this.dec.decode(this.buf.subarray(o, o + n));
        }
        if (resKind === "bool") return v.getUint8(ARENA_RESP_OFFSET + 16) !== 0;
        // expandedParams is a scalar-shaped payload: (ptr,count) of inner u64
        // runs at +16, no record-count slot.
        if (resKind === "expandedParams") return this.readExpandedParams(ARENA_RESP_OFFSET + 16);
        const reader = this.arenaReaders[resKind];
        if (!reader) throw new Error(`arena: no reader for result kind ${resKind} (${method})`);
        const count = v.getUint32(ARENA_RESP_OFFSET + 16, true);
        let off = ARENA_RESP_OFFSET + 20;
        const out: any[] = [];
        for (let i = 0; i < count; i++) {
            out.push(reader.read(off));
            off += reader.stride;
        }
        return reader.singular ? out[0] : out;
    }

    // Record readers per result kind (strides must mirror arena.go and the
    // triage-arena-parity witness decoder — three mirror points, Go consts are
    // the single source of truth). Bound once
    // per session so the hot decode loop allocates nothing per call.
    private readonly arenaReaders: Record<string, { read: (off: number) => any; stride: number; singular: boolean }> = {
        type: { read: o => this.readType(o), stride: 156, singular: true },
        types: { read: o => this.readType(o), stride: 156, singular: false },
        symbol: { read: o => this.readSymbol(o), stride: 72, singular: true },
        symbols: { read: o => this.readSymbol(o), stride: 72, singular: false },
        signature: { read: o => this.readSignature(o), stride: 64, singular: true },
        signatures: { read: o => this.readSignature(o), stride: 64, singular: false },
        quickinfo: { read: o => this.readQuickinfo(o), stride: 48, singular: true },
        referencedSymbols: { read: o => this.readReferencedSymbol(o), stride: 56, singular: false },
        definitionAndBoundSpan: { read: o => this.readDefinitionAndBoundSpan(o), stride: 16, singular: true },
        jsdocTags: { read: o => this.readJsDocTag(o), stride: 8, singular: false },
        ambientModules: { read: o => this.readAmbientModules(o), stride: 8, singular: true },
        completionInfo: { read: o => this.readCompletions(o), stride: 32, singular: true },
        signatureHelpItems: { read: o => this.readSignatureHelpItems(o), stride: 28, singular: true },
        renameInfo: { read: o => this.readRenameInfo(o), stride: 36, singular: true },
        renameLocations: { read: o => this.readRenameLocation(o), stride: 32, singular: false },
    };

    // (ptr,count) pair of {text strId, kind strId} records; count 0 = absent.
    private readDisplayParts(off: number): any[] | undefined {
        const count = this.view.getUint32(off + 4, true);
        if (count === 0) return undefined;
        let p = this.view.getUint32(off, true);
        const out = new Array(count);
        for (let i = 0; i < count; i++) {
            out[i] = { text: this.str(this.view.getUint32(p, true)) ?? "", kind: this.str(this.view.getUint32(p + 4, true)) ?? "" };
            p += 8;
        }
        return out;
    }

    private readQuickinfo(off: number): any {
        const v = this.view;
        const str = (id: number) => this.str(id) ?? "";
        const d: any = {
            kind: str(v.getUint32(off, true)),
            kindModifiers: str(v.getUint32(off + 4, true)),
            start: v.getUint32(off + 8, true),
            length: v.getUint32(off + 12, true),
            displayString: str(v.getUint32(off + 16, true)),
        };
        const documentation = this.readDisplayParts(off + 20);
        if (documentation) d.documentation = documentation;
        const tagCount = v.getUint32(off + 32, true);
        if (tagCount) {
            let p = v.getUint32(off + 28, true);
            const tags = new Array(tagCount);
            for (let i = 0; i < tagCount; i++) {
                const tag: any = { name: str(v.getUint32(p, true)) };
                const text = this.readDisplayParts(p + 4);
                if (text) tag.text = text;
                tags[i] = tag;
                p += 12;
            }
            d.tags = tags;
        }
        const flags = v.getUint8(off + 36);
        if (flags & 1) d.canIncreaseVerbosityLevel = (flags & 2) !== 0;
        const displayParts = this.readDisplayParts(off + 40);
        if (displayParts) d.displayParts = displayParts;
        return d;
    }

    private readDefinitionInfo(off: number): any {
        const v = this.view;
        const str = (id: number) => this.str(id) ?? "";
        const d: any = {
            fileName: str(v.getUint32(off, true)),
            start: v.getUint32(off + 4, true),
            length: v.getUint32(off + 8, true),
        };
        const f1 = v.getUint8(off + 44);
        const f2 = v.getUint8(off + 45);
        if (f1 & 1) {
            d.contextStart = v.getUint32(off + 12, true);
            d.contextLength = v.getUint32(off + 16, true);
        }
        d.kind = str(v.getUint32(off + 20, true));
        d.name = str(v.getUint32(off + 24, true));
        if (f1 & 2) d.containerKind = str(v.getUint32(off + 28, true));
        if (f1 & 4) d.containerName = str(v.getUint32(off + 32, true));
        const parts = this.readDisplayParts(off + 36);
        if (parts) d.displayParts = parts;
        if (f1 & 8) d.unverified = (f2 & 1) !== 0;
        if (f1 & 16) d.isLocal = (f2 & 2) !== 0;
        if (f1 & 32) d.isAmbient = (f2 & 4) !== 0;
        if (f1 & 64) d.failedAliasResolution = (f2 & 8) !== 0;
        return d;
    }

    private readReferenceEntry(off: number): any {
        const v = this.view;
        const flags = v.getUint8(off + 20);
        const d: any = {
            fileName: this.str(v.getUint32(off, true)) ?? "",
            start: v.getUint32(off + 4, true),
            length: v.getUint32(off + 8, true),
        };
        if (flags & 1) {
            d.contextStart = v.getUint32(off + 12, true);
            d.contextLength = v.getUint32(off + 16, true);
        }
        d.isWriteAccess = (flags & 2) !== 0;
        if (flags & 4) d.isDefinition = (flags & 8) !== 0;
        if (flags & 16) d.isInString = true;
        return d;
    }

    private readReferencedSymbol(off: number): any {
        const definition = this.readDefinitionInfo(off);
        const v = this.view;
        const count = v.getUint32(off + 52, true);
        const references = new Array(count);
        let p = v.getUint32(off + 48, true);
        for (let i = 0; i < count; i++) {
            references[i] = this.readReferenceEntry(p);
            p += 24;
        }
        return { definition, references };
    }

    private readDefinitionAndBoundSpan(off: number): any {
        const v = this.view;
        const count = v.getUint32(off + 12, true);
        const definitions = new Array(count);
        let p = v.getUint32(off + 8, true);
        for (let i = 0; i < count; i++) {
            definitions[i] = this.readDefinitionInfo(p);
            p += 48;
        }
        return { definitions, start: v.getUint32(off, true), length: v.getUint32(off + 4, true) };
    }

    private readJsDocTag(off: number): any {
        const v = this.view;
        const d: any = { name: this.str(v.getUint32(off, true)) ?? "" };
        const text = this.str(v.getUint32(off + 4, true));
        if (text !== undefined) d.text = text;
        return d;
    }

    // Outer (ptr,count) array of inner (ptr,count) u64 runs (getExpandedParameters).
    private readExpandedParams(off: number): any {
        const v = this.view;
        const count = v.getUint32(off + 4, true);
        const out = new Array(count);
        let p = v.getUint32(off, true);
        for (let i = 0; i < count; i++) {
            const n = v.getUint32(p + 8 * i + 4, true);
            const inner = new Array(n);
            let q = v.getUint32(p + 8 * i, true);
            for (let j = 0; j < n; j++) {
                inner[j] = Number(v.getBigUint64(q, true));
                q += 8;
            }
            out[i] = inner;
        }
        return out;
    }

    private readLightSymbol(off: number): any {
        const v = this.view;
        const id = Number(v.getBigUint64(off, true));
        if (id === 0) return null;
        const d: any = { id };
        const project = this.str(v.getUint32(off + 8, true));
        if (project !== undefined) d.project = project;
        d.name = this.str(v.getUint32(off + 12, true)) ?? "";
        d.flags = v.getUint32(off + 16, true);
        d.checkFlags = v.getUint32(off + 20, true);
        const parent = Number(v.getBigUint64(off + 24, true));
        if (parent !== 0) d.parent = parent;
        return d;
    }

    private readCompletionEntry(off: number): any {
        const v = this.view;
        const str = (id: number) => this.str(id);
        const strz = (id: number) => str(id) ?? "";
        const d: any = { name: strz(v.getUint32(off, true)) };
        const kind = v.getUint32(off + 60, true);
        if (kind !== 0) d.kind = kind;
        const elementKind = str(v.getUint32(off + 4, true));
        if (elementKind !== undefined) d.elementKind = elementKind;
        const kindModifiers = str(v.getUint32(off + 8, true));
        if (kindModifiers !== undefined) d.kindModifiers = kindModifiers;
        const sortText = str(v.getUint32(off + 12, true));
        if (sortText !== undefined) d.sortText = sortText;
        const insertText = str(v.getUint32(off + 16, true));
        if (insertText !== undefined) d.insertText = insertText;
        const filterText = str(v.getUint32(off + 20, true));
        if (filterText !== undefined) d.filterText = filterText;
        const detail = str(v.getUint32(off + 28, true));
        if (detail !== undefined) d.detail = detail;
        const flags = v.getUint8(off + 64);
        if (flags & 8) {
            const ld: any = {};
            const ldd = str(v.getUint32(off + 32, true));
            if (ldd !== undefined) ld.detail = ldd;
            const lds = str(v.getUint32(off + 36, true));
            if (lds !== undefined) ld.description = lds;
            d.labelDetails = ld;
        }
        if (flags & 16) d.symbol = this.readSymbol(v.getUint32(off + 56, true));
        const source = str(v.getUint32(off + 24, true));
        if (source !== undefined) d.source = source;
        if (flags & 1) d.hasAction = true;
        if (flags & 2) d.isRecommended = true;
        if (flags & 4) {
            d.replacementStart = v.getUint32(off + 40, true);
            d.replacementLength = v.getUint32(off + 44, true);
        }
        const cc = this.strArray(off + 48);
        if (cc) d.commitCharacters = cc;
        if (flags & 32) {
            const data: any = {};
            const exportName = str(v.getUint32(off + 72, true));
            if (exportName !== undefined) data.exportName = exportName;
            const fileName = str(v.getUint32(off + 76, true));
            if (fileName !== undefined) data.fileName = fileName;
            const moduleSpecifier = str(v.getUint32(off + 68, true));
            if (moduleSpecifier !== undefined) data.moduleSpecifier = moduleSpecifier;
            if (flags & 128) {
                const fixOff = v.getUint32(off + 88, true);
                const fixFlags = v.getUint32(fixOff + 32, true);
                const autoImport: any = {
                    importKind: v.getUint32(fixOff + 8, true),
                    addAsTypeOnly: v.getUint32(fixOff + 12, true),
                    importIndex: v.getUint32(fixOff + 16, true),
                };
                const kind = v.getUint32(fixOff + 0, true);
                if (kind) autoImport.kind = kind;
                const fixName = str(v.getUint32(fixOff + 4, true));
                if (fixName) autoImport.name = fixName;
                if (fixFlags & 1) autoImport.useRequire = true;
                if (moduleSpecifier) autoImport.moduleSpecifier = moduleSpecifier;
                const namespacePrefix = str(v.getUint32(fixOff + 20, true));
                if (namespacePrefix) autoImport.namespacePrefix = namespacePrefix;
                if (fixFlags & 2) {
                    autoImport.usagePosition = {
                        line: v.getUint32(fixOff + 24, true),
                        character: v.getUint32(fixOff + 28, true),
                    };
                }
                data.tnbCompletionData = { autoImport };
            }
            d.data = data;
        }
        if (flags & 64) d.isPackageJsonImport = true;
        const sourceDisplay = this.readDisplayParts(off + 80);
        if (sourceDisplay) d.sourceDisplay = sourceDisplay;
        return d;
    }

    private readCompletions(off: number): any {
        const v = this.view;
        const f1 = v.getUint8(off);
        const f2 = v.getUint8(off + 1);
        const d: any = {};
        if (f1 & 8) d.isIncomplete = true;
        const count = v.getUint32(off + 28, true);
        let p = v.getUint32(off + 24, true);
        const entries = new Array(count);
        for (let i = 0; i < count; i++) {
            entries[i] = this.readCompletionEntry(p);
            p += 96;
        }
        d.entries = entries;
        if (f2 & 1) d.flags = v.getUint32(off + 4, true);
        d.isGlobalCompletion = (f1 & 1) !== 0;
        d.isMemberCompletion = (f1 & 2) !== 0;
        d.isNewIdentifierLocation = (f1 & 4) !== 0;
        if (f2 & 2) {
            d.optionalSpanStart = v.getUint32(off + 8, true);
            d.optionalSpanLength = v.getUint32(off + 12, true);
        }
        const dcc = this.strArray(off + 16);
        if (dcc) d.defaultCommitCharacters = dcc;
        return d;
    }

    private readSignatureHelpItem(off: number): any {
        const v = this.view;
        const strz = (id: number) => this.str(id) ?? "";
        const d: any = {
            isVariadic: (v.getUint8(off + 48) & 1) !== 0,
            prefixDisplayParts: this.readDisplayParts(off) ?? [],
            suffixDisplayParts: this.readDisplayParts(off + 8) ?? [],
            separatorDisplayParts: this.readDisplayParts(off + 16) ?? [],
        };
        const pc = v.getUint32(off + 28, true);
        const params = new Array(pc);
        let p = v.getUint32(off + 24, true);
        for (let i = 0; i < pc; i++) {
            const flags = v.getUint8(p + 20);
            params[i] = {
                name: strz(v.getUint32(p, true)),
                documentation: this.readDisplayParts(p + 4) ?? [],
                displayParts: this.readDisplayParts(p + 12) ?? [],
                isOptional: (flags & 1) !== 0,
                isRest: (flags & 2) !== 0,
            };
            p += 24;
        }
        d.parameters = params;
        d.documentation = this.readDisplayParts(off + 32) ?? [];
        const tc = v.getUint32(off + 44, true);
        if (tc) {
            let t = v.getUint32(off + 40, true);
            d.tags = new Array(tc);
            for (let i = 0; i < tc; i++) {
                const tag: any = { name: strz(v.getUint32(t, true)) };
                const text = this.readDisplayParts(t + 4);
                if (text) tag.text = text;
                d.tags[i] = tag;
                t += 12;
            }
        }
        return d;
    }

    private readSignatureHelpItems(off: number): any {
        const v = this.view;
        const count = v.getUint32(off + 24, true);
        let p = v.getUint32(off + 20, true);
        const items = new Array(count);
        for (let i = 0; i < count; i++) {
            items[i] = this.readSignatureHelpItem(p);
            p += 52;
        }
        return {
            items,
            applicableSpan: { start: v.getUint32(off, true), length: v.getUint32(off + 4, true) },
            selectedItemIndex: v.getUint32(off + 8, true),
            argumentIndex: v.getUint32(off + 12, true),
            argumentCount: v.getUint32(off + 16, true),
        };
    }

    private readRenameInfo(off: number): any {
        const v = this.view;
        const str = (id: number) => this.str(id);
        const d: any = { canRename: (v.getUint8(off) & 1) !== 0 };
        const fileToRename = str(v.getUint32(off + 4, true));
        if (fileToRename !== undefined) d.fileToRename = fileToRename;
        const displayName = str(v.getUint32(off + 8, true));
        if (displayName !== undefined) d.displayName = displayName;
        const fullDisplayName = str(v.getUint32(off + 12, true));
        if (fullDisplayName !== undefined) d.fullDisplayName = fullDisplayName;
        const kind = str(v.getUint32(off + 16, true));
        if (kind !== undefined) d.kind = kind;
        if (v.getUint8(off) & 2) d.kindModifiers = str(v.getUint32(off + 20, true)) ?? "";
        const triggerSpanStart = v.getUint32(off + 24, true);
        const triggerSpanLength = v.getUint32(off + 28, true);
        if (d.canRename) d.triggerSpan = { start: triggerSpanStart, length: triggerSpanLength };
        const localizedErrorMessage = str(v.getUint32(off + 32, true));
        if (localizedErrorMessage !== undefined) d.localizedErrorMessage = localizedErrorMessage;
        return d;
    }

    private readRenameLocation(off: number): any {
        const v = this.view;
        const d: any = {
            fileName: this.str(v.getUint32(off, true)) ?? "",
            start: v.getUint32(off + 4, true),
            length: v.getUint32(off + 8, true),
        };
        const flags = v.getUint8(off + 28);
        if (flags & 1) {
            d.contextStart = v.getUint32(off + 12, true);
            d.contextLength = v.getUint32(off + 16, true);
        }
        const prefixText = this.str(v.getUint32(off + 20, true));
        if (prefixText !== undefined) d.prefixText = prefixText;
        const suffixText = this.str(v.getUint32(off + 24, true));
        if (suffixText !== undefined) d.suffixText = suffixText;
        return d;
    }

    // Single outer record {modules ptr, modules count} of 40-byte module records.
    private readAmbientModules(off: number): any {
        const v = this.view;
        const count = v.getUint32(off + 4, true);
        let p = v.getUint32(off, true);
        const modules = new Array(count);
        for (let i = 0; i < count; i++) {
            modules[i] = {
                moduleName: this.str(v.getUint32(p, true)) ?? "",
                moduleSymbol: this.readLightSymbol(p + 8),
            };
            p += 40;
        }
        return { modules };
    }

    private str(id: number): string | undefined {
        return id === 0 ? undefined : this.strTab[id];
    }

    private u32Array(off: number): number[] | undefined {
        const count = this.view.getUint32(off + 4, true);
        if (count === 0) return undefined;
        let p = this.view.getUint32(off, true);
        const out = new Array(count);
        for (let i = 0; i < count; i++) { out[i] = this.view.getUint32(p, true); p += 4; }
        return out;
    }

    private u64Array(off: number): number[] | undefined {
        const count = this.view.getUint32(off + 4, true);
        if (count === 0) return undefined;
        let p = this.view.getUint32(off, true);
        const out = new Array(count);
        for (let i = 0; i < count; i++) { out[i] = Number(this.view.getBigUint64(p, true)); p += 8; }
        return out;
    }

    private strArray(off: number): string[] | undefined {
        const count = this.view.getUint32(off + 4, true);
        if (count === 0) return undefined;
        let p = this.view.getUint32(off, true);
        const out = new Array(count);
        // Elements of a present array are never "absent": id 0 here is the
        // empty string (Go's intern maps "" to arenaAbsent) — e.g. the
        // leading/trailing texts of a `${x}` template literal type.
        for (let i = 0; i < count; i++) { out[i] = this.str(this.view.getUint32(p, true)) ?? ""; p += 4; }
        return out;
    }

    private u8Array(off: number): number[] | undefined {
        const count = this.view.getUint32(off + 4, true);
        if (count === 0) return undefined;
        const p = this.view.getUint32(off, true);
        const out = new Array(count);
        for (let i = 0; i < count; i++) out[i] = this.view.getUint8(p + i);
        return out;
    }

    private nodeHandleArray(off: number): (string | null)[] | undefined {
        const count = this.view.getUint32(off + 4, true);
        if (count === 0) return undefined;
        let p = this.view.getUint32(off, true);
        const out: (string | null)[] = new Array(count);
        // The "0.0." zero record is a sparse-array hole, not an absent array:
        // labeledElementDeclarations is full-length with holes at unlabeled
        // positions, and holes must stay positional.
        for (let i = 0; i < count; i++) { const h = this.readHandle(p); out[i] = h === "0.0." ? null : h; p += 16; }
        return out;
    }

    private u32z(off: number): number | undefined {
        const x = this.view.getUint32(off, true);
        return x === 0 ? undefined : x;
    }

    private u64z(off: number): number | undefined {
        const x = this.view.getBigUint64(off, true);
        return x === 0n ? undefined : Number(x);
    }

    private readType(off: number): any {
        const v = this.view;
        const data: any = {
            id: v.getUint32(off, true),
            flags: v.getUint32(off + 4, true),
            // go-json-experiment omitempty keeps scalar zero values (only
            // omitzero drops them), so these two cross unconditionally.
            objectFlags: v.getUint32(off + 8, true),
        };
        const set = (k: string, val: any) => { if (val !== undefined) data[k] = val; };
        set("target", this.u32z(off + 12));
        set("freshType", this.u32z(off + 16));
        set("regularType", this.u32z(off + 20));
        set("objectType", this.u32z(off + 24));
        set("indexType", this.u32z(off + 28));
        set("checkType", this.u32z(off + 32));
        set("extendsType", this.u32z(off + 36));
        set("baseType", this.u32z(off + 40));
        set("substConstraint", this.u32z(off + 44));
        set("symbol", this.u64z(off + 48));
        set("aliasSymbol", this.u64z(off + 56));
        const f2 = v.getUint8(off + 68);
        data.isThisType = (f2 & 1) !== 0;
        if (f2 & 2) data.fixedLength = v.getInt32(off + 64, true);
        if (f2 & 4) data.readonly = (f2 & 8) !== 0; // present bit + value bit
        const valueKind = v.getUint8(off + 69);
        // valueKind tags the slot as a present string, so the table-wide
        // "id 0 = absent" convention does not apply: id 0 here is the empty
        // string (Go's intern maps "" to arenaAbsent).
        if (valueKind === 1) data.value = this.str(v.getUint32(off + 72, true)) ?? "";
        else if (valueKind === 2) data.value = v.getFloat64(off + 80, true);
        else if (valueKind === 3) data.value = v.getUint8(off + 80) !== 0;
        else data.value = null;
        set("intrinsicName", this.str(v.getUint32(off + 88, true)));
        set("typeParameters", this.u32Array(off + 92));
        set("outerTypeParameters", this.u32Array(off + 100));
        set("localTypeParameters", this.u32Array(off + 108));
        set("aliasTypeArguments", this.u32Array(off + 116));
        set("texts", this.strArray(off + 124));
        set("elementFlags", this.u8Array(off + 132));
        set("labeledElementDeclarations", this.nodeHandleArray(off + 140));
        set("thisType", this.u32z(off + 148));
        set("escapedName", this.str(v.getUint32(off + 152, true)));
        return data;
    }

    private readHandle(off: number): string {
        const v = this.view;
        const index = v.getUint32(off, true);
        const kind = v.getUint32(off + 4, true);
        const path = this.str(v.getUint32(off + 8, true)) ?? "";
        return `${index}.${kind}.${path}`;
    }

    private readSymbol(off: number): any {
        const v = this.view;
        const id = Number(v.getBigUint64(off, true));
        // Zero slot in a symbols run = null element (getSymbolsDeclarations /
        // getParentsOfSymbols holes).
        if (id === 0) return null;
        const data: any = {
            id,
            name: this.str(v.getUint32(off + 12, true)) ?? "",
            flags: v.getUint32(off + 16, true),
            checkFlags: v.getUint32(off + 20, true),
        };
        const project = this.str(v.getUint32(off + 8, true));
        if (project !== undefined) data.project = project;
        const declCount = v.getUint32(off + 28, true);
        if (declCount > 0) {
            let p = v.getUint32(off + 24, true);
            const decls = new Array(declCount);
            for (let i = 0; i < declCount; i++) { decls[i] = this.readHandle(p); p += 16; }
            data.declarations = decls;
        }
        const vd = this.readHandle(off + 32);
        if (vd !== "0.0.") data.valueDeclaration = vd;
        const parent = this.u64z(off + 48);
        if (parent !== undefined) data.parent = parent;
        const exportSymbol = this.u64z(off + 56);
        if (exportSymbol !== undefined) data.exportSymbol = exportSymbol;
        // globalExports flag @64 (bit0 = HasGlobalExports) — written
        // unconditionally on the Go side and by go-json's omitempty for the
        // scalar zero (same as TypeResponse.isThisType), so mirror it
        // unconditionally here: both transports carry the field either way.
        data.hasGlobalExports = (v.getUint32(off + 64, true) & 1) !== 0;
        return data;
    }

    private readSignature(off: number): any {
        const v = this.view;
        const data: any = {
            id: Number(v.getBigUint64(off, true)),
            flags: v.getUint32(off + 8, true),
        };
        const decl = this.readHandle(off + 12);
        if (decl !== "0.0.") data.declaration = decl;
        const tp = this.u32Array(off + 28);
        if (tp !== undefined) data.typeParameters = tp;
        const params = this.u64Array(off + 36);
        if (params !== undefined) data.parameters = params;
        const thisP = this.u64z(off + 44);
        if (thisP !== undefined) data.thisParameter = thisP;
        const target = this.u64z(off + 52);
        if (target !== undefined) data.target = target;
        return data;
    }
}

export class MiniSourceFileCache {
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
    // Same reuse rule generalized to non-declaration files, but scoped per
    // project: projectId is the tsgo API's project handle (the config file
    // path, stable across a project's snapshot generations), and a source
    // file's parse options — unlike a .d.ts's constant zero options — depend
    // on the project's jsx/moduleDetection/module settings (they change the
    // encoded externalModuleIndicator), so a path-only entry could be served
    // to a project that would parse it differently. Within one project's
    // scope the stored key is authoritative: options are fixed for the
    // project's lifetime, and any mid-session drift (tsconfig edit, overlay
    // script-kind switch) re-parses the file Go-side, surfacing as a change
    // event that drops the entry (invalidateChangedPaths). This is the
    // fork-level analog of stock's tryReuseStructureFromOldProgram: watch-mode
    // lint rebuilds the thin program per linted file, and without it every
    // generation re-decodes the whole corpus and retains its own wire blobs
    // until the V8 heap OOMs (issue #11).
    private stableSrcByPath = new Map<string, Map<any, { key: any; hash: any; file: any }>>();

    private static isStableDeclarationPath(p: string): boolean {
        // noembed: lib paths are real packageRoot/lib/*.d.ts (no bundled://).
        return p.endsWith(".d.ts") && (p.includes("/node_modules/") || p.includes("bundled://") || isBundledLibPath(p) || isHostLibFile(p));
    }


    getRetained(p: string, snapshotId: any, projectId: any): any {
        let byProj = this.bySnap.get(snapshotId);
        let byPath = byProj?.get(projectId);
        const retained = byPath?.get(p);
        if (retained) return retained;
        // Serve a cross-generation entry without the getSourceFile RPC.
        // Safe because (a) identical content + identical parse options
        // produce an identical encoded blob, so the decoded RemoteSourceFile
        // is valid in any snapshot of the project the entry is scoped to;
        // (b) content changes surface as snapshot change events, which drop
        // the entry (invalidateChangedPaths). Go itself only re-reads a disk
        // file when such an event arrives, so trusting the entry matches what
        // the RPC would return byte-for-byte. Declaration files come from the
        // project-global cache (GetExternalModuleIndicatorOptions returns the
        // zero options for declaration file names, so every project produces
        // the same blob for the same content); all other files require an
        // entry recorded under this project (see stableSrcByPath).
        const stable = MiniSourceFileCache.isStableDeclarationPath(p)
            ? this.stableByPath.get(p)
            : this.stableSrcByPath.get(p)?.get(projectId);
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
                this.stableSrcByPath.delete(p);
                changedN++;
                if (sample.length < 6) sample.push(`C:${p}`);
            }
            for (const p of c?.deletedFiles ?? []) {
                this.stableByPath.delete(p);
                this.stableSrcByPath.delete(p);
                deletedN++;
                if (sample.length < 6) sample.push(`D:${p}`);
            }
        }
        if (changedN || deletedN) {
            rpcTraceEvent("MiniSourceFileCache.invalidate", `changed=${changedN} deleted=${deletedN} sample=${sample.join(",")}`);
        }
    }
    set(p: string, file: any, key: any, hash: any, snapshotId: any, projectId: any): any {
        if (hash != null) {
            if (MiniSourceFileCache.isStableDeclarationPath(p)) {
                const stable = this.stableByPath.get(p);
                if (stable && stable.key === key && stable.hash === hash) {
                    file = stable.file;
                } else {
                    this.stableByPath.set(p, { key, hash, file });
                }
            } else {
                let byScope = this.stableSrcByPath.get(p);
                if (!byScope) { byScope = new Map(); this.stableSrcByPath.set(p, byScope); }
                const scoped = byScope.get(projectId);
                if (scoped && scoped.key === key && scoped.hash === hash) {
                    file = scoped.file;
                } else {
                    // Cross-project dedup: another project's entry with the
                    // same content hash + parse-options key decoded the same
                    // blob — adopt its object so WeakMap-keyed indexes hit
                    // across projects and memory stays single-copy.
                    for (const e of byScope.values()) {
                        if (e.key === key && e.hash === hash) { file = e.file; break; }
                    }
                    byScope.set(projectId, { key, hash, file });
                }
            }
        }
        let byProj = this.bySnap.get(snapshotId);
        if (!byProj) { byProj = new Map(); this.bySnap.set(snapshotId, byProj); }
        let byPath = byProj.get(projectId);
        if (!byPath) { byPath = new Map(); byProj.set(projectId, byPath); }
        if (!byPath.has(p)) { byPath.set(p, file); this.paths.add(p); }
        return byPath.get(p);
    }
    retainForSnapshot(): void {}
    /**
     * Drop every file decoded for a disposed snapshot. Called by the vendored
     * client (Snapshot.dispose) and by the overlay's generation tracking —
     * LS generations flip per program rebuild, and without this the cache
     * holds every generation's decoded RemoteSourceFiles forever (issue #6).
     * Evicted paths simply re-fetch on demand via the getSourceFile RPC.
     */
    releaseSnapshot(snapshotId: any): void {
        const byProj = this.bySnap.get(snapshotId);
        if (!byProj) return;
        this.bySnap.delete(snapshotId);
        // Purge paths no longer present in any live snapshot so has() only
        // reports live entries; stable entries re-enter via getRetained.
        if (this.bySnap.size === 0) { this.paths.clear(); return; }
        const live = new Set<string>();
        for (const proj of this.bySnap.values()) {
            for (const byPath of proj.values()) {
                for (const p of byPath.keys()) live.add(p);
            }
        }
        this.paths = live;
    }
    clear(): void { this.bySnap.clear(); this.paths.clear(); this.stableByPath.clear(); this.stableSrcByPath.clear(); }
    has(p: string): boolean { return this.paths.has(p); }
    /**
     * Idle eviction of decoded-node populations on cross-generation shells
     * (issue #11 residue): the wire blob stays cached (re-decode materializes
     * per file on demand); only the lazily decoded RemoteNode objects are
     * dropped. Node identity survives: ids are `index.kind.path` strings and
     * the root (index 1, the file itself) is re-primed. Promoted (hot) files
     * keep their population — their promoted WeakMap index references it, so
     * dropping it there would reclaim nothing.
     */
    dropDecodedAstExcept(promotedPaths: ReadonlySet<string>): void {
        const drop = (p: string, entry: { file: any } | undefined): void => {
            const file = entry?.file;
            if (!file || promotedPaths.has(p)) return;
            const nodes = file.nodes;
            if (!Array.isArray(nodes) || nodes.length <= 2) return;
            file.nodes = Array(nodes.length);
            file.nodes[1] = file;
        };
        for (const [p, e] of this.stableByPath) drop(p, e);
        for (const [p, byScope] of this.stableSrcByPath) {
            for (const e of byScope.values()) drop(p, e);
        }
    }
}
