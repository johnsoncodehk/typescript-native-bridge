// Host↔tsgo lib path helpers. Under noembed, tsgo reads packageRoot/lib from disk
// (TNB_LIB_PATH); toTsgoFileName is identity. bundled:/// helpers remain defensive.

/* eslint-disable @typescript-eslint/no-require-imports */

const BUNDLED_LIB_PREFIX = "bundled:///libs/";

export function getTnbPackageRoot(): string {
    const path = require("path") as typeof import("path");
    return path.resolve(__dirname, "..");
}

export function isBundledLibPath(fileName: string): boolean {
    return fileName.startsWith(BUNDLED_LIB_PREFIX);
}

export function bundledLibPathToHostPath(bundledPath: string): string {
    const path = require("path") as typeof import("path");
    const libFile = bundledPath.slice(BUNDLED_LIB_PREFIX.length);
    return path.join(getTnbPackageRoot(), "lib", libFile);
}

export function toHostFileName(fileName: string): string {
    return isBundledLibPath(fileName) ? bundledLibPathToHostPath(fileName) : fileName;
}

/** Normalize host file paths — tsserver may use cwd-relative paths for project files. */
export function resolveHostFileName(fileName: string, host?: { getCurrentDirectory?: () => string }): string {
    const mapped = toHostFileName(fileName);
    const path = require("path") as typeof import("path");
    const normalized = mapped.replace(/\\/g, "/");
    if (path.isAbsolute(normalized)) {
        return path.normalize(normalized);
    }
    const cwd = host?.getCurrentDirectory?.() ?? process.cwd();
    return path.normalize(path.resolve(cwd, normalized));
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
        _libDirPrefixLower = (path.join(getTnbPackageRoot(), "lib") + path.sep).toLowerCase();
    }
    return _libDirPrefixLower;
}

export function isHostLibFile(fileName: string): boolean {
    if (isBundledLibPath(fileName)) return true;
    if (!/lib\.[^/\\]+\.d\.ts$/i.test(fileName)) return false;
    let candidate = fileName;
    if (candidate.includes("\\") || candidate.includes("./")) {
        const path = require("path") as typeof import("path");
        candidate = path.normalize(candidate);
    }
    const prefix = getLibDirPrefixLower();
    return candidate.length > prefix.length && candidate.slice(0, prefix.length).toLowerCase() === prefix;
}
