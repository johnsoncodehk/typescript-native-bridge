// Host↔tsgo lib path helpers. Under noembed, tsgo reads packageRoot/lib from disk
// (TNB_LIB_PATH); toTsgoFileName is identity. bundled:/// helpers remain defensive.

/* eslint-disable @typescript-eslint/no-require-imports */

const BUNDLED_LIB_PREFIX = "bundled:///libs/";

// require("path") per call measured hot (resolveHostFileName runs per corpus
// file per watch generation) — share one lookup.
let _nodePath: typeof import("path") | undefined;
function nodePath(): typeof import("path") {
    return _nodePath ??= require("path");
}

export function getTnbPackageRoot(): string {
    return nodePath().resolve(__dirname, "..");
}

export function isBundledLibPath(fileName: string): boolean {
    return fileName.startsWith(BUNDLED_LIB_PREFIX);
}

export function bundledLibPathToHostPath(bundledPath: string): string {
    const libFile = bundledPath.slice(BUNDLED_LIB_PREFIX.length);
    // Forward-slash host form (see resolveHostFileName) — path.join would
    // emit backslashes on Windows.
    return nodePath().join(getTnbPackageRoot(), "lib", libFile).replace(/\\/g, "/");
}

export function toHostFileName(fileName: string): string {
    return isBundledLibPath(fileName) ? bundledLibPathToHostPath(fileName) : fileName;
}

/** Normalize host file paths — tsserver may use cwd-relative paths for project files. */
export function resolveHostFileName(fileName: string, host?: { getCurrentDirectory?: () => string }): string {
    const mapped = toHostFileName(fileName);
    const path = nodePath();
    // Stock toPath form: absolute, forward-slash (stock normalizePath never
    // emits backslashes; case folding lives in getCanonicalFileName /
    // canonicalSourceFilePath). path.normalize would emit backslashes on
    // Windows, breaking canonicalSourceFilePath's forward-slash key contract
    // (BuilderState fileInfos keyed from Go's forward-slash names then misses
    // every resolvedPath — win32 tsc -b updateShapeSignature crash).
    const normalized = mapped.replace(/\\/g, "/");
    if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
        return path.posix.normalize(normalized);
    }
    const cwd = (host?.getCurrentDirectory?.() ?? process.cwd()).replace(/\\/g, "/");
    return path.posix.normalize(path.posix.resolve(cwd, normalized));
}

/** Identity under noembed — tsgo reads packageRoot/lib (or TNB_LIB_PATH) from disk. */
export function toTsgoFileName(fileName: string): string {
    return fileName;
}

// Hot path: called per declaration during scope-symbol refinement. The libDir
// prefix is constant per process; compare case-insensitively because tsgo
// canonicalizes paths to lower case on case-insensitive file systems, and a
// case-sensitive prefix test silently disabled lib-file detection (and with it
// cross-snapshot retention of lib RemoteSourceFiles) for such paths.
let _libDirPrefixLower: string | undefined;
function getLibDirPrefixLower(): string {
    if (_libDirPrefixLower === undefined) {
        const path = require("path") as typeof import("path");
        // Forward-slash form — candidates arrive in stock/Go forward-slash
        // form; path.join + sep would emit backslashes on Windows.
        _libDirPrefixLower = (path.join(getTnbPackageRoot(), "lib") + "/").replace(/\\/g, "/").toLowerCase();
    }
    return _libDirPrefixLower;
}

export function isHostLibFile(fileName: string): boolean {
    if (isBundledLibPath(fileName)) return true;
    if (!/lib\.[^/\\]+\.d\.ts$/i.test(fileName)) return false;
    const candidate = fileName.replace(/\\/g, "/");
    const prefix = getLibDirPrefixLower();
    return candidate.length > prefix.length && candidate.slice(0, prefix.length).toLowerCase() === prefix;
}
