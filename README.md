# typescript-native-bridge

Build host for a **tsgo-backed TypeScript fork**. This repo pins upstream
`microsoft/TypeScript` and `microsoft/typescript-go` as submodules and
materializes a small patch set on top of each. The built fork
(`typescript/lib/typescript.js`) is a drop-in `typescript` whose **type checker
runs in-process on tsgo** via a cgo NAPI bridge — no IPC child process, no
module-hijacking.

```ts
import * as ts from "typescript";            // → the built fork
const program = ts.createProgram(rootNames, options);  // tsgo, in-process
const checker = program.getTypeChecker();
const t = checker.getTypeAtLocation(node);   // resolved by tsgo (Go), via FFI
```

## How it works

```
┌───────────────────────────────────────────────────────────────────┐
│  consumer process                                                  │
│                                                                    │
│  require('typescript')  ─►  typescript/lib/typescript.js (the fork)│
│                               │  upstream TypeScript +             │
│                               │  tsgoChecker overlay:              │
│                               │   createProgram → createTsgoProgram│
│                               │   getTypeChecker → tsgo adapter    │
│                               ▼                                    │
│                       koffi FFI  ─►  bridge.dylib (cgo)            │
│                               │   BridgeCall / BridgeCallBinary    │
│                               ▼                                    │
│                       typescript-go internal/api (Go, in-process)  │
└───────────────────────────────────────────────────────────────────┘
```

- **`typescript/`** — submodule pinned to upstream `microsoft/TypeScript`. The
  patch set adds a `tsgoChecker` overlay (`src/compiler/tsgoChecker.ts`,
  `tsgoBackedSourceFile.ts`) plus three small in-place hooks
  (`program.ts` / `parser.ts` / `_namespaces/ts.ts`) so that, when a tsconfig is
  present, `createProgram` returns a thin tsgo-backed program (single parse, AST
  from tsgo) and the checker delegates to tsgo over the bridge.
- **`typescript-go/`** — submodule pinned to upstream `microsoft/typescript-go`.
  The patch set adds the cgo bridge (`bridge/`) — a `c-shared` library exposing
  `BridgeCall` / `BridgeCallBinary` over `internal/api`, the same dispatch the
  IPC server uses — plus a few in-place edits to the API layer (e.g. raw-kind
  accessors, host-content overlay support).
- **The dylib is resolved deterministically** from
  `typescript-go/bridge/bridge.<dylib|so|dll>` — no environment variable.

## Repo layout

Each submodule's customization is a **two-part delta** (handled by
`tools/patch-common.js`, shared by both) — same pattern as
[auvred/golar](https://github.com/auvred/golar), no fork repos:

```
typescript-native-bridge/
  tools/                       patch-common.js + patch-{tsgo,typescript}.js
                               save-{tsgo,typescript}-patches.js
  patches/
    typescript-go/             delta over upstream typescript-go
      overlay/bridge/...       net-new files (the cgo bridge) — copied in
      0001-bridge-inplace.patch  in-place edits to existing tsgo files
    typescript/                delta over upstream TypeScript
      overlay/src/compiler/... net-new files (tsgoChecker.ts, …) — copied in
      0001-tsgo-hooks.patch    in-place hooks (program/parser/_namespaces)
  typescript-go/               submodule → microsoft/typescript-go (pinned)
  typescript/                  submodule → microsoft/TypeScript (pinned, shallow)
```

### The two-part delta convention

- **`overlay/`** — a path tree mirroring the submodule root, holding **net-new
  files**. These never conflict on upstream rebase, so they're kept as plain
  files (not baked into a patch). Applied by copying into the submodule.
- **`*.patch`** — **in-place edits** to existing upstream files. Applied with
  `git apply` (idempotent: already-applied patches are skipped).

Bumping a submodule = move it to a new upstream commit + re-apply/refresh its
delta. Only the in-place patches can conflict, and they're small (tsgo: 14
files / ~320 lines; TypeScript: 3 files / 53 lines).

## Build (dev)

```bash
git clone --recurse-submodules <this-repo>
cd typescript-native-bridge
npm install

# one-shot: init submodules + apply both deltas + build tsgo JS + dylib + fork
npm run setup
```

`npm run setup` runs `git submodule update --init` + `patch-tsgo.js` +
`patch-typescript.js` + `build:js` (tsgo native-preview) + `build:bridge`
(the dylib) + `build:ts` (the TypeScript fork: `npm install` + `build:compiler`
+ LKG).

## Scripts

| script | purpose |
|---|---|
| `setup` | init both submodules + apply both deltas + build everything |
| `patch:tsgo` / `patch:ts` | apply one submodule's delta (overlay + patch) |
| `save-patches` / `save-ts-patches` | regenerate one submodule's delta from its working tree |
| `build:js` | build tsgo's `@typescript/native-preview` JS |
| `build:bridge` | patch tsgo + build JS + compile `bridge.dylib` |
| `build:ts` | apply TS delta + `npm install` + `build:compiler` + LKG |

## Editing a delta (patch round-trip)

The bridge source lives at `typescript-go/bridge/bridge.go` *inside the
submodule checkout* (it must — `bridge.go` imports tsgo's `internal/api`, only
importable from within the tsgo module tree). Edit files inside a submodule,
then regenerate its delta so it's versioned here:

```bash
# edit files inside typescript-go/ (and/or typescript/)
npm run save-patches          # → regenerates patches/typescript-go/{overlay,*.patch}
npm run save-ts-patches       # → regenerates patches/typescript/{overlay,*.patch}
npm run build:bridge          # rebuild the dylib
```

The patch tools are idempotent (skip already-applied patches / up-to-date
overlays), so re-running `npm run setup` after a fresh `git submodule update`
re-materializes everything.
