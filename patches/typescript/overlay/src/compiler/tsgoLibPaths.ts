// Map tsgo bundled lib paths (bundled:///libs/lib.es5.d.ts) to the fork's
// on-disk lib/ tree so tsserver ScriptInfo keys match real files.

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

export function hostPathToBundledLibPath(fileName: string): string | undefined {
    if (isBundledLibPath(fileName)) return fileName;
    const path = require("path") as typeof import("path");
    const libDir = path.join(getTnbPackageRoot(), "lib");
    const normalized = path.normalize(fileName);
    if (!normalized.startsWith(libDir + path.sep) && normalized !== libDir) return undefined;
    const rel = path.relative(libDir, normalized).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return undefined;
    return BUNDLED_LIB_PREFIX + rel;
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

export function toTsgoFileName(fileName: string): string {
    return hostPathToBundledLibPath(fileName) ?? fileName;
}

export function isHostLibFile(fileName: string): boolean {
    if (isBundledLibPath(fileName)) return true;
    const path = require("path") as typeof import("path");
    const libDir = path.join(getTnbPackageRoot(), "lib");
    const normalized = path.normalize(fileName);
    return normalized.startsWith(libDir + path.sep) && /lib\.[^/]+\.d\.ts$/i.test(normalized);
}
