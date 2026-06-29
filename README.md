# typescript-native-bridge

A **drop-in `typescript`** whose type checking runs **in-process on tsgo** (the Go
port of TypeScript) — no IPC child process, no module hijacking. To adopt it,
override `typescript` in your project to point at this fork; every tool that
resolves `typescript` (`tsc`, `vue-tsc`, `@typescript-eslint`, `tsslint`, your
editor's workspace version, …) then runs on the Go engine. There is **no API to
call and no per-tool config**.

```jsonc
// package.json — pnpm
{
  "pnpm": {
    "overrides": {
      "typescript": "npm:typescript-native-bridge@<version>"
    }
  }
}
```

```jsonc
// package.json — npm                              // package.json — yarn
{ "overrides": {                                   { "resolutions": {
    "typescript":                                      "typescript":
      "npm:typescript-native-bridge@<version>" } }       "npm:typescript-native-bridge@<version>" } }
```

Reinstall after editing so the override takes effect — it's repo-wide, so
transitive `typescript` consumers switch over too.

## ✅ Verify it's active

When the fork is in use it **always** prints a banner to stderr on first run:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅  TNB ACTIVE — `typescript` is the tsgo-backed fork
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**No banner means you're still on stock `typescript`** — the override didn't take
effect. This silently fails more often than not: pnpm 11 ignores `package.json`
`pnpm.overrides` (use `pnpm-workspace.yaml`), monorepos override at the **root**,
and a `catalog:` can shadow it.

## How it works

Normal `typescript` parses and type-checks in JavaScript. This fork keeps the
**exact same JS API**, but does the actual work in the Go engine (`tsgo`) running
**in the same process**:

```
your tool ──► typescript (this fork) ──► tsgo engine (Go)
              same JS API as always       does the real work
                       └────── direct in-process call ──────┘
```

```ts
import * as ts from "typescript";                       // → the bridged fork
const program = ts.createProgram(rootNames, options);   // tsgo, in-process
const checker = program.getTypeChecker();
const t = checker.getTypeAtLocation(node);              // resolved by tsgo (Go)
```

- You use `ts.createProgram(...)`, `getTypeChecker()`, etc. exactly as before.
- Parsing, module resolution, and type checking actually run in Go.
- Calls cross into Go through a direct in-process bridge — **no child process, no
  IPC, no monkey-patching** of `typescript`.

## SFC / `extraFileExtensions` support (Volar family)

`vue-tsc` and the wider Volar family (`.vue`, `.svelte`, `.astro`, `.mdx`,
`ts-macro`, …) work on the fork. The support is **general, keyed on the standard
`extraFileExtensions` host contract — there is no per-extension (`.vue`)
hardcoding**:

- The tsgo module resolver resolves a specifier whose extension is a
  host-registered extra extension (e.g. `import App from './App.vue'`) **to the
  file itself**, instead of only looking for a `./App.d.vue.ts` declaration.
- When extra extensions are registered and `allowArbitraryExtensions` is **unset**
  in tsconfig, it is inferred `true` (so the resolved file isn't rejected). This
  mirrors what Volar sets at runtime, which the on-disk tsconfig lacks.

### Boundaries

These are deliberate limits of the in-process, synchronous bridge — worth knowing
before relying on the fork for exotic setups:

1. **Resolve-to-self only.** An extra-extension specifier resolves to the file at
   the *same* resolved path (the universal SFC pattern). A host that uses a custom
   `resolveModuleNameLiterals` / `resolveModuleNames` to remap an extension to a
   *different* file is **not** honored: the bridge is synchronous (JS→Go only, no
   Go→JS callback), so tsgo never consults JS host module-resolution hooks. It
   resolves natively in Go and is fed host *content* via overlays, not host
   *resolutions*.
2. **`allowArbitraryExtensions` is inferred from the presence of extras** (unless
   tsconfig sets it explicitly). An explicit `allowArbitraryExtensions: false` is
   respected (opt-out), and yields the faithful `TS6263` diagnostic. In stock
   TypeScript these two settings are independent; the fork couples them as a
   convenience for SFC tooling.
