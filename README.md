# typescript-native-bridge

A `typescript`-shaped drop-in backed by the **typescript-go in-process NAPI
bridge**. Alias it as `typescript` and a consumer (tsslint, vue-tsc, …) switches
its `ts.createProgram` / `require('typescript')` onto tsgo **with no code
changes** — no IPC child process, no module-hijacking.

```jsonc
// consumer package.json
"devDependencies": {
  "typescript": "npm:typescript-native-bridge"
}
```

```ts
import * as ts from "typescript";            // → this package
const program = ts.createProgram(rootNames, options);  // tsgo, in-process
const checker = program.getTypeChecker();
const t = checker.getTypeAtLocation(node);   // microseconds, not 100s of µs
```

## How it works

```
┌────────────────────────────────────────────────────────────────┐
│  consumer process                                              │
│                                                                │
│  require('typescript') ──alias──►  typescript-native-bridge   │
│                                      │  facade: real ts base + │
│                                      │   tsgo /ast enums/guards│
│                                      │   + NAPI createProgram  │
│                                      │                         │
│                                      ▼                         │
│                              Program/Checker wrappers           │
│                                      │  (ts-shaped over tsgo)  │
│                                      ▼                         │
│                              InProcessClient (koffi FFI)       │
│                                      │                         │
│  ┌───────────────────────────────────▼──────────────────────┐  │
│  │  bridge.dylib  (Go c-shared, built from the upstream      │  │
│  │   typescript-go submodule + patches/typescript-go/*.patch)│  │
│  │   BridgeCall / BridgeCallBinary → api.Session.HandleReq  │  │
│  │   (same dispatch as the IPC server — zero dup)           │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

- **Facade**: copies every own-property of real `typescript` (the gap surface —
  `skipTrivia`, `sys`, `parseJsonConfigFileContent`,
  `createSemanticDiagnosticsBuilderProgram`, …), then overlays tsgo's `/ast`
  (`SyntaxKind`, `NodeFlags`, all `is*` guards, visitor, scanner, factory) and
  `/api/sync` enums (`SymbolFlags`, `TypeFlags`, …). `is*` predicates are
  null-tolerant (tsgo's crash on `undefined`; rule code walks `node.parent`
  chains that hit `undefined`).
- **`createProgram(rootNames, options)`**: starts a bridge session and maps to
  tsgo's tsconfig-driven model — `options.configFilePath` → `openProject`;
  otherwise `openFiles: rootNames` (inferred project). Returns a `ts.Program`
  wrapper over tsgo's `project.program` with `getSourceFile` / `getSourceFiles`
  / `getRootFileNames` / `getCompilerOptions` / `getTypeChecker` / the
  diagnostic methods. Unknown properties Proxy through to the underlying tsgo
  program, so any method tsgo already exposes just works.
- **`TypeChecker`**: wraps tsgo's `project.checker`. Explicit delegation for the
  common `ts.TypeChecker` methods (`getTypeAtLocation`, `getSymbolAtLocation`,
  `getTypeOfSymbol`, `typeToString`, `getContextualType`, `getNonNullableType`,
  `isTypeAssignableTo`, the intrinsic-type getters, …); the rest Proxy through.
- **No module-hijacking**: the npm alias makes `require('typescript')` resolve
  to this package naturally. The package keeps its OWN private `typescript` dep
  (nested under `node_modules/typescript/node_modules/typescript` in a real
  install), so its internal `require('typescript')` gets real ts for the
  base/gap surface — no self-loop.

## Status / scope

This is a **proof-of-concept package** proving the drop-in usage model:
- ✅ Facade surface (enums/guards/walkers/factory) — identical to the surface
  already proven in tsslint's `poc-tsgo` harness.
- ✅ `createProgram` → tsgo program, in-process via the NAPI bridge.
- ✅ `Program` / `TypeChecker` wrappers with the methods a lint pipeline
  exercises (`getSourceFile`, `getSemanticDiagnostics`, `getTypeAtLocation`,
  `getSymbolAtLocation`, `typeToString`, …).
- ✅ Alias contract validated: a consumer `require('typescript')` + rule-style
  AST walk + checker queries produces the **same finding (same range)** as
  real `typescript`.

**Not yet done (intentional, deferred):**
- Full `ts.Type` / `ts.Symbol` / `ts.Signature` wrapper objects with
  finalizer-backed identity (currently the tsgo objects are returned largely
  as-is, which is fine for reads but doesn't yet mirror `objectRegistry`
  lifetime semantics).
- `createLanguageService` / `BuilderProgram` rerouting through tsgo (tsslint's
  mainline uses a LanguageService for the Strada path; the alias alone doesn't
  reroute it — that needs the mainline integration step).
- Prebuilt `.node`/`.dylib`/`.so`/`.dll` distribution (currently loads a local
  `bridge.dylib` via koffi).

## Repo layout

This repo carries the JS facade plus an **upstream `typescript-go` submodule** and a
**patch set** that adds the cgo bridge on top of it (no fork repo — same pattern
as [auvred/golar](https://github.com/auvred/golar)):

```
typescript-native-bridge/
  src/                         JS facade + napi-client (koffi FFI)
  test/                        smoke + alias tests (self-contained fixtures)
  tools/                       patch-tsgo.js, save-tsgo-patches.js
  patches/typescript-go/       0001-Add-cgo-bridge.patch  (the delta over upstream)
  typescript-go/               submodule → microsoft/typescript-go (pinned commit)
```

The submodule points at **upstream** `microsoft/typescript-go`, pinned to a specific
commit. `patches/typescript-go/*.patch` is the additive delta (the `poc-napi/` cgo
bridge) applied on top of that clean upstream checkout. Bumping tsgo = move the
submodule to a new upstream commit + re-apply/refresh the patches.

## Build & run (dev)

```bash
# 1. clone with the submodule, install JS deps
git clone --recurse-submodules <this-repo>
cd typescript-native-bridge
npm install

# 2. apply the patch set to the submodule + build the Go shared library
npm run build:bridge
#   = node tools/patch-tsgo.js
#   + (cd typescript-go/poc-napi && go build -buildmode=c-shared -o bridge.dylib bridge.go)

# 3. tests (self-contained temp fixtures; no external paths)
npm test              # test/smoke.js
node test/alias.js    # require('typescript')-via-alias contract + Strada parity
```

Fresh clone shortcut: `npm run setup` runs `git submodule update --init` +
`patch-tsgo.js` in one go (then `npm run build:bridge` to compile).

The dylib resolves automatically from `typescript-go/poc-napi/bridge.<dylib|so|dll>`
(platform-aware). Override with `TSSLINT_TSGO_NAPI_LIB=<path>`.

## Editing the Go bridge (patch round-trip)

The bridge source lives at `typescript-go/poc-napi/bridge.go` *inside the submodule
checkout* (it must — `bridge.go` imports tsgo's `internal/api`, which is only
importable from within the tsgo module tree). Edit it there, then regenerate the
patch so the delta is preserved outside the submodule:

```bash
# edit typescript-go/poc-napi/bridge.go (and/or other files in the submodule)
npm run save-patches          # → regenerates patches/typescript-go/0001-Add-cgo-bridge.patch
npm run build:bridge          # rebuild the dylib
```

`patch-tsgo.js` is idempotent (skips already-applied patches), so re-running
`npm run setup` after a fresh `git submodule update` re-materializes the bridge.

## Files

- `src/index.js` — the `typescript`-shaped facade + `createProgram` +
  `Program`/`TypeChecker` wrappers (the package entry point).
- `src/napi-client.js` — `InProcessClient` + `MiniSourceFileCache` +
  `createInProcessAPI` (koffi → bridge.dylib).
- `src/tsgo-load.js` — resolves `@typescript/native-preview` subpaths.
- `src/index.d.ts` — static types (`typeof typescript` + the NAPI `createProgram`
  overload) so aliased consumers keep type-checking unchanged.
- `test/smoke.js` — standalone createProgram smoke test (self-contained temp fixture).
- `test/alias.js` — alias-mechanism + Strada-parity validation (self-contained).
- `tools/patch-tsgo.js` — applies `patches/typescript-go/*.patch` to the submodule.
- `tools/save-tsgo-patches.js` — regenerates the patch set from the submodule's
  working-tree diff (the patch round-trip).
- `patches/typescript-go/0001-Add-cgo-bridge.patch` — the additive cgo bridge
  delta over upstream tsgo.
- `typescript-go/` — upstream `microsoft/typescript-go` submodule (pinned commit).
