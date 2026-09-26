// Process-global bridge state. lib/typescript.js and lib/_tsc.js each bundle
// their own copy of the tsgo modules; everything the two copies must share
// (the NAPI addon, the session, per-process caches) hangs off one globalThis
// slot.

const TNB_BRIDGE_STATE_KEY = Symbol.for("typescript-native-bridge.bridgeState");

export type TnbBridgeProcessState = {
    bridgeAddon?: any;
    sync?: any;
    bridgeFns?: any;
    client?: any;
    api?: any;
    sourceFileCache?: any;
    useCaseSensitive?: boolean;
    version?: string;
    debugAnnounced?: boolean;
    /** Process-global RPC counters for the sourcefile guard. Both bundle
     * copies register an exit hook that writes `${out}.<pid>`, and the last
     * writer wins — a per-copy counter would let the non-counting copy
     * clobber the totals with its own zeros. */
    guardStats?: { totalRpcCount: number; getSourceFileRpcCount: number };
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
    /** Registry getOrCreateType/getOrCreateSymbol are wrapped exactly once per
     * process — the wrap converts raw nested wire handles to lazy accessors,
     * and a second wrap would bury the first one's memoized reads. */
    wireShapeWrapApplied?: boolean;
    /** NodeHandle class stashed from the sync API (not exported) so
     * convertTypeWireShape can materialize declaration handles carried on
     * type records (labeledElementDeclarations, issue #52). */
    NodeHandleCtor?: any;
    /** NodeHandle.prototype hooks are installed exactly once per process —
     * the prototype is shared across lib/typescript.js and lib/_tsc.js bundles. */
    nodeHandlePatched?: boolean;
    /** Bundle Type/Symbol/Signature prototype hooks are installed exactly
     * once per process, never once per program generation: a hook closure
     * defined inside a generation's createTsgoChecker scope pins that whole
     * generation island (V8 keeps a closure's entire defining context
     * alive), and a re-install that wraps the previous hook chains one
     * island per generation. The hooks live at module scope and route to
     * the live checker through project.__tnbTypeChecker. */
    typeProtoPatched?: boolean;
    symbolProtoPatched?: boolean;
    signatureProtoPatched?: boolean;
    /** RemoteNode.prototype getChildren for LS token walks (findAllReferences/rename). */
    remoteNodeTraversalPatched?: boolean;
    /** SignalExit bypass listeners installed exactly once per process. */
    signalExitBypassInstalled?: boolean;
    /** Host text last pushed to the (process-wide) tsgo session per file. */
    syncedOverlayContentByFile?: Map<string, string>;
    /** Delta-push count per file the bridge session has applied. */
    syncedOverlayVersionByFile?: Map<string, number>;
    /** Host edit deltas (ScriptInfo.editContent) awaiting the next overlay sync. */
    pendingOverlayEditsByFile?: Map<string, { start: number; deleteLength: number; insertText: string }[]>;
    /** Files an external-change signal fired on since the last overlay
     * collect (see _pendingExternalChangePaths) — the collect drains this into
     * updateSnapshot fileChanges.changed / overlay pushes (issue #49). */
    pendingExternalChangePaths?: Set<string>;
    /** Disk stamp per file Go serves from disk, for direct createProgram
     * programs (see _diskStampByFile). */
    diskStampByFile?: Map<string, string>;
    /** Solution-build (tsc -b / vue-tsc -b) active-project tracker. The build
     * orchestrator finishes each project completely before the next program is
     * created, so the previously opened tsgo project can be closed when the
     * next one opens — keeping the tsgo session's open project/file set O(1)
     * instead of O(#projects built so far). */
    buildModeRef?: { active?: TnbActiveBuildProject };
};

/** One solution-build project currently open in the tsgo session. */
export type TnbActiveBuildProject = {
    configFilePath: string;
    /** Files opened (with or without content) in tsgo for this project. */
    openedFiles: Set<string>;
    /** Snapshots created while this project was active — released on close. */
    snapshots: any[];
};

export function tnbBridgeProcessState(): TnbBridgeProcessState {
    const g = globalThis as any;
    if (!g[TNB_BRIDGE_STATE_KEY]) g[TNB_BRIDGE_STATE_KEY] = {};
    return g[TNB_BRIDGE_STATE_KEY];
}
