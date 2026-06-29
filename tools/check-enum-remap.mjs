#!/usr/bin/env node
// CI guard for the tsgo↔fork enum-remap boundary.
//
// tsgo and the fork ("TNB") assign DIFFERENT numeric values to several enums.
// Any raw tsgo enum value handed to JS consumers (typescript-estree /
// @typescript-eslint rules) without remapping is silently wrong. The overlay
// (patches/typescript/overlay/src/compiler/tsgoChecker.ts) translates the
// diverging-and-exposed enums at the boundary. This script makes that contract
// machine-checkable so a future submodule bump that introduces a NEW divergence
// or a NEW exposed enum field turns the build red instead of relying on linting
// volar/vue by luck.
//
//   Part A — divergence report: diff fork types.ts vs tsgo native-preview enums
//            BY MEMBER NAME and print IDENTICAL / DIVERGES per enum.
//   Part B — coverage assertion: walk an in-repo REGISTRY of enum-typed values
//            exposed to consumers; FAIL (non-zero exit) when a diverging field
//            is neither remapped (and wired) nor validly exempt, when an
//            "identical"-exempt enum starts diverging, or when a new
//            SyntaxKind-scalar node getter appears that isn't in the registry.
//
// Zero dependencies, deterministic, non-interactive.  Run: npm run check:enums

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const FORK_TYPES = path.join(repoRoot, "typescript", "src", "compiler", "types.ts");
const TSGO_ENUM_DIR = path.join(repoRoot, "typescript-go", "_packages", "native-preview", "src", "enums");
const OVERLAY = path.join(repoRoot, "patches", "typescript", "overlay", "src", "compiler", "tsgoChecker.ts");
const NODE_GEN = path.join(repoRoot, "typescript-go", "_packages", "native-preview", "src", "api", "node", "node.generated.ts");
const NODE_INFRA = path.join(repoRoot, "typescript-go", "_packages", "native-preview", "src", "api", "node", "node.infrastructure.ts");

// ── Enum source parser ───────────────────────────────────────────────────────
// Both fork (`const enum X { ... }`) and tsgo (`enum X { ... }`) members are
// auto-increment / numeric-literal / bit-shift / bit-or expressions referencing
// prior members. Evaluate each initializer in a scope holding the members seen
// so far. (Trusted, in-repo source.)

function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Slice the text between the matching braces of `enum NAME { ... }`. */
function extractEnumBody(src, name) {
    const re = new RegExp(`\\benum\\s+${name}\\s*\\{`);
    const m = re.exec(src);
    if (!m) return undefined;
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) break;
    }
    return src.slice(start, i);
}

function evalEnumExpr(expr, members) {
    const names = [...members.keys()];
    const vals = [...members.values()];
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(...names, `"use strict"; return (${expr});`);
        const v = fn(...vals);
        return typeof v === "number" && Number.isFinite(v) ? v : NaN;
    } catch {
        return NaN;
    }
}

/** Parse a single enum from TS source → Map<memberName, number> (forward only). */
function parseEnum(src, name) {
    const body = extractEnumBody(src, name);
    if (body === undefined) return undefined;
    const members = new Map();
    let prev = -1;
    for (const part of stripComments(body).split(",")) {
        const entry = part.trim();
        if (!entry) continue;
        const eq = entry.indexOf("=");
        if (eq === -1) {
            if (!/^[A-Za-z_$][\w$]*$/.test(entry)) continue;
            prev += 1;
            members.set(entry, prev);
        } else {
            const mn = entry.slice(0, eq).trim();
            if (!/^[A-Za-z_$][\w$]*$/.test(mn)) continue;
            const val = evalEnumExpr(entry.slice(eq + 1).trim(), members);
            members.set(mn, val);
            prev = val;
        }
    }
    return members;
}

// ── Enums to diff (Part A). tsgoFile === null → tsgo has no generated enum. ──
const ENUMS = [
    ["SyntaxKind", "syntaxKind.enum.ts"],
    ["NodeFlags", "nodeFlags.enum.ts"],
    ["ModifierFlags", "modifierFlags.enum.ts"],
    ["TokenFlags", "tokenFlags.enum.ts"],
    ["SymbolFlags", "symbolFlags.enum.ts"],
    ["TypeFlags", "typeFlags.enum.ts"],
    ["ObjectFlags", "objectFlags.enum.ts"],
    ["SignatureFlags", "signatureFlags.enum.ts"],
    ["ElementFlags", "elementFlags.enum.ts"],
    ["ScriptKind", "scriptKind.enum.ts"],
    ["FlowFlags", null],
];

const forkSrc = fs.readFileSync(FORK_TYPES, "utf8");
const tsgoSrcCache = new Map();
function readTsgoEnumFile(file) {
    if (!tsgoSrcCache.has(file)) {
        const p = path.join(TSGO_ENUM_DIR, file);
        tsgoSrcCache.set(file, fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined);
    }
    return tsgoSrcCache.get(file);
}

const isPow2 = v => typeof v === "number" && v !== 0 && (v & (v - 1)) === 0;

/**
 * Compare two enums by member name. Returns
 *   { status, shared, diffs, singleBitDiffs }  where status ∈
 *   IDENTICAL | DIVERGES | FORK_ONLY | TSGO_ONLY | MISSING.
 *
 * Only members present in BOTH with a different value count as divergences.
 * `singleBitDiffs` is the subset whose value is a single bit (power of two) in
 * either source — i.e. the flags actually read by consumers as `flags & X`.
 * Composite / alias masks (e.g. TypeFlags.Intrinsic, SymbolFlags.*Excludes) can
 * differ without breaking the boundary as long as the single bits align, so the
 * "identical"-exemption is keyed on `singleBitDiffs`, not `diffs`.
 */
function diffEnum(enumName, tsgoFile) {
    const fork = parseEnum(forkSrc, enumName);
    const tsgoSrc = tsgoFile ? readTsgoEnumFile(tsgoFile) : undefined;
    const tsgo = tsgoSrc ? parseEnum(tsgoSrc, enumName) : undefined;
    if (!fork && !tsgo) return { status: "MISSING", diffs: [], singleBitDiffs: [] };
    if (!tsgo) return { status: "FORK_ONLY", diffs: [], singleBitDiffs: [] };
    if (!fork) return { status: "TSGO_ONLY", diffs: [], singleBitDiffs: [] };
    const diffs = [];
    const singleBitDiffs = [];
    let shared = 0;
    for (const [name, forkVal] of fork) {
        if (!tsgo.has(name)) continue;
        shared++;
        const tsgoVal = tsgo.get(name);
        if (tsgoVal !== forkVal) {
            const d = { name, fork: forkVal, tsgo: tsgoVal };
            diffs.push(d);
            // A real single-bit flag is a power of two in BOTH sources. This
            // excludes aggregate masks that happen to equal a power of two in
            // one source (e.g. tsgo SymbolFlags.All === 1<<29) and composite
            // masks (TypeFlags.Intrinsic, *Excludes), which are not the
            // `flags & X` bits consumers read.
            if (isPow2(forkVal) && isPow2(tsgoVal)) singleBitDiffs.push(d);
        }
    }
    return { status: diffs.length ? "DIVERGES" : "IDENTICAL", shared, diffs, singleBitDiffs };
}

const report = new Map();
for (const [name, file] of ENUMS) report.set(name, diffEnum(name, file));

// ── Part B: registry of enum-typed values exposed to JS consumers ────────────
// status: "remapped"  → must be wired in the overlay when its enum DIVERGES.
//         "exempt"     → not remapped. identical:true means the exemption is
//                        only valid while the enum stays IDENTICAL (guard fails
//                        if it starts diverging). identical:false is an
//                        unconditional exemption (field not read by consumers,
//                        private, or no tsgo enum to diff) — document why.
//
// ADD NEW EXPOSED ENUM FIELDS HERE. The node-schema auto-discovery below only
// catches SyntaxKind-scalar getters; flags fields on Type/Symbol/Signature and
// any non-SyntaxKind scalar must be added by hand.
const REGISTRY = [
    // SyntaxKind-scalar node getters (decoded straight off the tsgo blob; see
    // node.generated.ts / node.infrastructure.ts). All remapped via
    // patchKindGetter — a no-op for identical values, correct for divergent.
    { field: "node.kind", enum: "SyntaxKind", status: "remapped", wire: 'patchKindGetter("kind")' },
    { field: "node.token", enum: "SyntaxKind", status: "remapped", wire: 'patchKindGetter("token")' },
    { field: "node.operator", enum: "SyntaxKind", status: "remapped", wire: 'patchKindGetter("operator")' },
    { field: "node.keywordToken", enum: "SyntaxKind", status: "remapped", wire: 'patchKindGetter("keywordToken")' },
    { field: "node.keyword", enum: "SyntaxKind", status: "remapped", wire: 'patchKindGetter("keyword")' },
    { field: "node.phaseModifier", enum: "SyntaxKind", status: "remapped", wire: 'patchKindGetter("phaseModifier")' },
    // Flags exposed on Node.
    { field: "node.flags", enum: "NodeFlags", status: "remapped", wire: "patchFlagsGetter(" },
    {
        field: "node.modifierFlags", enum: "ModifierFlags", status: "exempt", identical: true,
        reason: "computed from modifierToFlag(mod._rawKind); ModifierFlags is identical so no remap is needed",
    },
    // Flags exposed on Type.
    { field: "type.objectFlags", enum: "ObjectFlags", status: "remapped", wire: "remapObjectFlags(" },
    {
        field: "type.flags", enum: "TypeFlags", status: "exempt", identical: true,
        reason: "TypeFlags single bits are identical across both enums",
    },
    // Flags exposed on Symbol.
    {
        field: "symbol.flags", enum: "SymbolFlags", status: "exempt", identical: true,
        reason: "SymbolFlags single bits are identical across both enums",
    },
    {
        field: "symbol.checkFlags", enum: "CheckFlags", status: "exempt", identical: false,
        reason: "tsgo exposes raw checkFlags but generates no CheckFlags enum to diff; consumer-read bits audited identical (645a122). LIMITATION: not auto-verifiable.",
    },
    // Flags exposed on Signature.
    {
        field: "signature.flags", enum: "SignatureFlags", status: "exempt", identical: false,
        reason: "Signature.flags is private in native-preview and never reaches consumers (no estree/rule reads it)",
    },
];

// A wire token counts as present only on a live (non-comment) line, so a
// commented-out / deleted remap (`// patchKindGetter("token");`) does NOT
// satisfy the check. Strip each line's `//` comment, then `/* … */` blocks,
// before matching.
const overlayLines = fs.readFileSync(OVERLAY, "utf8").split("\n");
function isWired(wire) {
    for (const line of overlayLines) {
        const code = stripComments(line.replace(/\/\/.*$/, ""));
        if (code.includes(wire)) return true;
    }
    return false;
}

// ── Best-effort auto-discovery of SyntaxKind-scalar node getters ─────────────
// Driving "what scalar fields exist" off the actual decoder schema means a new
// getter introduced by a submodule bump is caught by construction. We scan for
// `get <name>(): SyntaxKind` (excluding _-prefixed internal raw getters) in the
// native-preview node decoder files.
function discoverSyntaxKindGetters() {
    const found = new Set();
    for (const f of [NODE_GEN, NODE_INFRA]) {
        if (!fs.existsSync(f)) continue;
        const src = fs.readFileSync(f, "utf8");
        const re = /\bget\s+([A-Za-z][\w$]*)\s*\(\s*\)\s*:\s*SyntaxKind\b/g;
        let m;
        while ((m = re.exec(src)) !== null) found.add(m[1]);
    }
    return found;
}

// ── Run Part B assertions ────────────────────────────────────────────────────
const failures = [];

for (const entry of REGISTRY) {
    const div = report.get(entry.enum);
    const status = div?.status;

    if (entry.status === "remapped") {
        const wired = entry.wire ? isWired(entry.wire) : false;
        if (status === "DIVERGES" && !wired) {
            failures.push(
                `${entry.field} (${entry.enum}) DIVERGES and is marked "remapped", but no remap is wired ` +
                `in the overlay (expected to find \`${entry.wire}\`).`,
            );
        } else if (!entry.wire) {
            failures.push(`${entry.field}: "remapped" registry entries must declare a \`wire\` token.`);
        }
        // status IDENTICAL + wired is fine (remap is a harmless no-op).
    } else if (entry.status === "exempt") {
        // "identical" exemptions are about the SINGLE BITS consumers read
        // (`flags & X`); composite/alias mask differences don't break it.
        if (entry.identical && div && div.singleBitDiffs.length) {
            failures.push(
                `${entry.field} (${entry.enum}) is exempt on the grounds that the enum's single bits are ` +
                `IDENTICAL, but a single-bit member now DIVERGES: ` +
                `${div.singleBitDiffs.map(d => `${d.name}(fork=${d.fork}/tsgo=${d.tsgo})`).join(", ")}. ` +
                `Remap it at the boundary or update the registry.`,
            );
        }
    }
}

// Auto-discovery: every SyntaxKind-scalar getter must be registered.
const registeredScalarGetters = new Set(
    REGISTRY.filter(e => e.enum === "SyntaxKind" && e.field.startsWith("node."))
        .map(e => e.field.slice("node.".length)),
);
const discovered = discoverSyntaxKindGetters();
for (const g of discovered) {
    if (!registeredScalarGetters.has(g)) {
        failures.push(
            `node decoder exposes a SyntaxKind-scalar getter \`${g}\` that is not in the coverage registry. ` +
            `Add { field: "node.${g}", enum: "SyntaxKind", status: "remapped", wire: 'patchKindGetter("${g}")' } ` +
            `(and wire patchKindGetter("${g}") in the overlay) or mark it exempt with a reason.`,
        );
    }
}

// ── Output ───────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);

console.log("Enum divergence report (fork types.ts vs tsgo native-preview, by member name)");
console.log("─".repeat(78));
console.log(`${pad("ENUM", 18)} ${pad("STATUS", 11)} DETAIL`);
console.log("─".repeat(78));
for (const [name, file] of ENUMS) {
    const r = report.get(name);
    let detail = "";
    if (r.status === "DIVERGES") {
        const src = r.singleBitDiffs.length ? r.singleBitDiffs : r.diffs;
        const shown = src.slice(0, 5).map(d => `${d.name}(${d.fork}≠${d.tsgo})`).join(", ");
        const head = r.singleBitDiffs.length
            ? `${r.diffs.length} differ, ${r.singleBitDiffs.length} single-bit`
            : `${r.diffs.length} differ, 0 single-bit (composite/alias only — single bits identical)`;
        detail = `${head}: ${shown}${src.length > 5 ? ", …" : ""}`;
    } else if (r.status === "IDENTICAL") {
        detail = `${r.shared} shared member(s) match`;
    } else if (r.status === "FORK_ONLY") {
        detail = "no tsgo generated enum (fork-only)";
    } else if (r.status === "TSGO_ONLY") {
        detail = "present in tsgo only";
    } else if (r.status === "MISSING") {
        detail = "not found in either source";
    }
    console.log(`${pad(name, 18)} ${pad(r.status, 11)} ${detail}`);
}
console.log("─".repeat(78));
console.log();

console.log("Exposed-enum coverage registry (Part B)");
console.log("─".repeat(78));
console.log(`${pad("FIELD", 22)} ${pad("ENUM", 16)} ${pad("ENUM-STATUS", 12)} REGISTRY`);
console.log("─".repeat(78));
for (const entry of REGISTRY) {
    const div = report.get(entry.enum);
    const enumStatus = div ? div.status : "UNKNOWN";
    let reg;
    if (entry.status === "remapped") {
        reg = isWired(entry.wire) ? "remapped ✓ (wired)" : "remapped ✗ (NOT wired)";
    } else {
        reg = `exempt — ${entry.reason}`;
    }
    console.log(`${pad(entry.field, 22)} ${pad(entry.enum, 16)} ${pad(enumStatus, 12)} ${reg}`);
}
console.log("─".repeat(78));
console.log(
    `Auto-discovered SyntaxKind-scalar getters in node decoder: ` +
    `${[...discovered].sort().join(", ") || "(none)"}`,
);
console.log();

if (failures.length) {
    console.error(`FAIL: ${failures.length} enum-remap coverage problem(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
}

console.log("PASS: every divergent, consumer-exposed enum field is remapped or validly exempt.");
