// tsgo-backed SourceFile — tsgo RemoteSourceFile AST with real/skeleton file metadata.
// manager consume the standard ts.SourceFile shape unchanged.

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
    NodeFlags,
    type Path,
    ScriptKind,
    ScriptTarget,
    type SourceFile,
    SyntaxKind,
} from "./types.js";
import { type CreateSourceFileOptions } from "./parser.js";
import { factory } from "./factory/nodeFactory.js";
import {
    computeLineStarts,
    computeLineAndCharacterOfPosition,
    computePositionOfLineAndCharacter,
} from "./scanner.js";
import { normalizePath } from "./path.js";

/** @internal */
export function inferScriptKind(fileName: string): ScriptKind {
    if (fileName.endsWith(".tsx")) return ScriptKind.TSX;
    if (fileName.endsWith(".jsx")) return ScriptKind.JSX;
    if (fileName.endsWith(".js")) return ScriptKind.JS;
    if (fileName.endsWith(".json")) return ScriptKind.JSON;
    return ScriptKind.TS;
}

const _backedCache = new Map<string, any>();
const _lineStartsCache = new Map<string, readonly number[]>();
let _tsgoProjectGetter: (() => any) | undefined;

function installLazyLineHelpers(target: any, getText: () => string, cacheKey?: string): void {
    if (typeof target.getLineStarts === "function") return;
    const ensureLineStarts = (): readonly number[] => {
        if (cacheKey) {
            const cached = _lineStartsCache.get(cacheKey);
            if (cached) return cached;
        }
        const ls = computeLineStarts(getText());
        if (cacheKey) _lineStartsCache.set(cacheKey, ls);
        return ls;
    };
    target.getLineStarts = () => ensureLineStarts();
    target.getLineAndCharacterOfPosition = (pos: number) =>
        computeLineAndCharacterOfPosition(ensureLineStarts(), pos);
    target.getPositionOfLineAndCharacter = (line: number, ch: number) =>
        computePositionOfLineAndCharacter(ensureLineStarts(), line, ch);
    if (!target.lineMap) {
        Object.defineProperty(target, "lineMap", {
            configurable: true,
            get() { return ensureLineStarts(); },
        });
    }
}

export function installTsgoBackedSourceFileLoader(getProject: () => any): void {
    _tsgoProjectGetter = getProject;
    // Clear cache across project switches: RemoteSourceFile node handles are
    // tied to a specific tsgo snapshot. Reusing them across projects causes
    // "handle could not be resolved" errors. The per-program sfCache in
    // createTsgoProgram handles intra-project caching.
    _backedCache.clear();
    _lineStartsCache.clear();
}

/** Minimal SourceFile shell (text + line map only) — skips the real TS parse; tsgo supplies the AST. */
export function createSkeletonSourceFile(
    fileName: string,
    text: string,
    languageVersionOrOptions: ScriptTarget | CreateSourceFileOptions,
    scriptKind?: ScriptKind,
): SourceFile {
    const opts = typeof languageVersionOrOptions === "object"
        ? languageVersionOrOptions
        : ({ languageVersion: languageVersionOrOptions } as CreateSourceFileOptions);
    const eof = factory.createToken(SyntaxKind.EndOfFileToken);
    const sf = factory.createSourceFile([], eof, NodeFlags.None) as SourceFile;
    const anySf = sf as any;
    anySf.fileName = fileName;
    anySf.originalFileName = fileName;
    const normalized = normalizePath(fileName) as Path;
    anySf.path = normalized;
    anySf.resolvedPath = normalized;
    anySf.text = text;
    anySf.languageVersion = opts.languageVersion ?? ScriptTarget.ESNext;
    anySf.languageVariant = (opts as any).languageVariant ?? 0;
    anySf.scriptKind = scriptKind ?? ScriptKind.TS;
    // Lazy line map — only computed when tokens/rules ask for line/col.
    installLazyLineHelpers(anySf, () => anySf.text as string, fileName);
    anySf.forEachChild = (cb: (n: any) => void) => {
        for (const s of sf.statements) cb(s);
        cb(sf.endOfFileToken);
    };
    // Empty directive/pragma defaults — real parser populates these, but
    // the skeleton skips parse. program.ts reads them during file processing.
    anySf.referencedFiles = [];
    anySf.typeReferenceDirectives = [];
    anySf.libReferenceDirectives = [];
    anySf.amdDependencies = [];
    anySf.pragmas = {};
    anySf.commentDirectives = [];
    anySf.checkJsDirective = undefined;
    anySf.hasNoDefaultLib = false;
    anySf.isDeclarationFile = false;
    anySf.parseDiagnostics = [];
    anySf.bindDiagnostics = [];
    anySf.nodeCount = 0;
    anySf.identifierCount = 0;
    anySf.symbolCount = 0;
    anySf.moduleAugmentations = [];
    anySf.imports = [];
    anySf.ambientModuleNames = [];
    return sf;
}

function patchLineHelpers(shell: any, realSf: any): void {
    if (typeof shell.getLineStarts === "function") return;
    if (typeof realSf.getLineStarts === "function") {
        const ls = realSf.getLineStarts();
        shell.getLineStarts = () => ls;
        shell.getLineAndCharacterOfPosition = (pos: number) => computeLineAndCharacterOfPosition(ls, pos);
        shell.getPositionOfLineAndCharacter = (line: number, ch: number) =>
            computePositionOfLineAndCharacter(ls, line, ch);
        return;
    }
    const fileName = realSf.fileName as string | undefined;
    installLazyLineHelpers(shell, () => (realSf.text ?? shell.text ?? "") as string, fileName);
}

export function getTsgoBackedSourceFile(realSf: any): any | undefined {
    if (!_tsgoProjectGetter) return undefined;
    const fileName = realSf.fileName;
    if (_backedCache.has(fileName)) return _backedCache.get(fileName);

    let project: any;
    try {
        project = _tsgoProjectGetter();
    } catch {
        return undefined;
    }
    if (!project) return undefined;

    let tsgoSf: any;
    try {
        tsgoSf = project.program.getSourceFile(fileName);
    } catch {
        return undefined;
    }
    if (!tsgoSf) return undefined;

    // RemoteSourceFile already quacks like ts.SourceFile (named child getters).
    const shell = tsgoSf;
    patchLineHelpers(shell, realSf);
    _backedCache.set(fileName, shell);
    return shell;
}

export function clearTsgoBackedSourceFileCache(): void {
    _backedCache.clear();
    _lineStartsCache.clear();
}
