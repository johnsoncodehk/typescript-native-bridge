# typescript-native-bridge (TNB)

> **Status:** Experimental. Published on npm as [`typescript-native-bridge`](https://www.npmjs.com/package/typescript-native-bridge).

**A faster `typescript` you can drop into any project** (measure on your repo; no fixed speedup guarantee).

Swap the `typescript` package for this fork and keep using `tsc`, `vue-tsc`, ESLint, and your
editor as before. Type-checking runs on **tsgo** (Microsoft's Go TypeScript compiler) instead
of JavaScript. You do **not** need to learn tsgo, change imports, or add per-tool config.

---

## Why TNB exists

TNB is a **drop-in `typescript` replacement** — not a separate `tsgo` CLI, not a new
LSP. One `typescript` override accelerates every tool that calls `getTypeChecker()` through
the standard Compiler API.

### Three problems one override fixes

**1. `vue-tsc` cannot use standalone `tsgo`**

`vue-tsc` is built on the `typescript` programmatic API + Volar hooks (`extraFileExtensions`,
virtual `getSourceFile` for `.vue`, `createProgram` wrapping). Standalone `tsgo` / `tsgo
LSP` does not speak that protocol — you cannot speed up `vue-tsc` by swapping the CLI to
`tsgo`. TNB keeps `vue-tsc` unchanged and routes `createProgram` → `createTsgoProgram`,
feeding Volar virtual content to Go via in-process overlays.

**2. ESLint + typescript-eslint type-aware rules are checker-bound**

`@typescript-eslint/parser` imports `typescript` and calls `createProgram` /
`getTypeChecker()` for type-aware rules. The bottleneck is the JS checker, not ESLint's
AST walk. TNB makes the parser pick up the fork automatically — no eslint config changes,
no separate `tsgo` lint pass.

**3. Editors need `tsserver` + Language Service Plugins (not tsgo LSP)**

Volar (`@vue/typescript-plugin`) runs as a **tsserver LS Plugin**. Microsoft's tsgo LSP
preview does not support that plugin model — migrating the editor means losing `.vue`
integration. TNB keeps **stock `tsserver` + plugin host**, swapping only the checker
backend to Go in-process.

### What this means in practice

| Tool | Still uses | Checker engine |
|---|---|---|
| `vue-tsc` / `tsc` | `typescript` API (`_tsc.js`) | tsgo |
| `tsserver` / VS Code | `typescript` + LS Plugins | tsgo |
| `@typescript-eslint/parser` | `typescript` API | tsgo |

Compare with `@typescript/native-preview`: separate `tsgo` binary, change scripts, editor
uses experimental tsgo LSP — **does not** cover the three rows above with one override.

---

## 10-minute checklist

Use this if you just want to try TNB on an existing project:

- [ ] Add a `typescript` override (see below)
- [ ] Run `pnpm install` / `npm install`
- [ ] Run your usual typecheck (`vue-tsc`, `tsc`, or `nuxi typecheck`)
- [ ] Confirm the **TNB ACTIVE** banner appears on stderr (first run per process)
- [ ] If no banner → see [Troubleshooting](#troubleshooting)

---

## Quick start

### pnpm (monorepos)

Put the override in **`pnpm-workspace.yaml`** at the repo root:

```yaml
# pnpm-workspace.yaml
overrides:
  typescript: npm:typescript-native-bridge@<version>
```

```bash
pnpm install
pnpm exec vue-tsc -b --noEmit    # or your project's typecheck script
```

If packages use `catalog:typescript`, update the **catalog entry** as well (see
[Nuxt / Vue / monorepo notes](#nuxt--vue--monorepo-notes)).

### npm

```jsonc
// package.json
{
  "overrides": {
    "typescript": "npm:typescript-native-bridge@<version>"
  }
}
```

### yarn

```jsonc
// package.json
{
  "resolutions": {
    "typescript": "npm:typescript-native-bridge@<version>"
  }
}
```

### Local path (developing TNB or pinning a git checkout)

```yaml
# pnpm-workspace.yaml
overrides:
  typescript: link:../typescript-native-bridge
```

Build the fork first (`npm run setup` in the TNB repo). See [Developing TNB](#developing-tnb-contributors).

After any override change: **reinstall dependencies**. The override applies repo-wide —
`vue-tsc`, `@typescript-eslint/parser`, and other transitive `typescript` users all pick
up the fork.

---

## How to tell it's working

On the **first** type-check in a process, TNB prints this banner to **stderr**:

```
┌─────────────────────────────────────────────────────────┐
│  ✅  TNB ACTIVE — `typescript` is the tsgo-backed fork  │
└─────────────────────────────────────────────────────────┘
```

**No banner = stock `typescript` is still loaded.** See [Troubleshooting](#troubleshooting).

Quick sanity check:

```bash
node -e "console.log(require.resolve('typescript'))"
# should point at typescript-native-bridge, not node_modules/typescript@5.x
```

---

## What you get

| | Stock `typescript` | TNB |
|---|---|---|
| Import | `import * as ts from "typescript"` | Same |
| CLI | `tsc`, `vue-tsc`, `nuxi typecheck` | Same commands |
| Per-tool config | — | None |
| Checker engine | JavaScript | Go (tsgo), in-process |

```
your tool  →  typescript (fork)  →  tsgo (Go)
              same public API         type-checking
                    └── in-process bridge (no child process, no IPC)
```

**API compatibility:** Existing `tsc` / `vue-tsc` / ESLint workflows work without code
changes. The checker is implemented by tsgo internally; tools that depend on deep
TypeScript internals or custom emit paths should be validated separately.

---

## Nuxt / Vue / monorepo notes

### pnpm catalog + overrides

If your monorepo uses a **catalog** and any package depends on `typescript` via
`catalog:`, update the catalog entry **as well as** `overrides:` — otherwise those
packages may still resolve stock TypeScript even when root `overrides` is set:

```yaml
# pnpm-workspace.yaml
catalog:
  typescript: link:../typescript-native-bridge
overrides:
  typescript: link:../typescript-native-bridge
```

> **Monorepo tip:** Prefer workspace `overrides` only. A root `pnpm add -D typescript@link:...`
> alone often does **not** replace `vue-tsc`'s transitive `typescript`.

### Nuxt projects

Typical flow:

```bash
pnpm exec nuxi prepare          # generate .nuxt types first
pnpm exec nuxi typecheck        # or your package.json "typecheck" script
```

### Vue / Volar / SFC

**Supported**

- `import App from './App.vue'` resolves to the `.vue` file itself
- Volar **virtual TypeScript** (content injected via `getSourceFile` when the file
  isn't on disk) via overlay
- `.vue`, `.svelte`, `.astro`, `.mdx`, etc. through the standard `extraFileExtensions`
  contract — no hard-coded `.vue` special case
- `allowArbitraryExtensions` inferred `true` in tsgo when host extra extensions are
  present and tsconfig leaves the option unset (explicit `false` opts out)

**Not supported**

- Custom `resolveModuleNames` / `resolveModuleNameLiterals` that remap an import to a
  **different physical file** (bridge is synchronous JS→Go; tsgo cannot call back into JS
  resolvers)
- Explicit `allowArbitraryExtensions: false` in tsconfig → normal `TS6263` (opt-out)

### CLI vs editor

| Path | Bundle | Used by |
|---|---|---|
| `lib/_tsc.js` | CLI | `tsc`, `vue-tsc -b` |
| `lib/typescript.js` | Language service | `tsserver`, VS Code workspace TS |

Both should show the banner when type-checking runs. In VS Code: **TypeScript: Select
TypeScript Version → Use Workspace Version**. Volar/Vue - Official should use the
workspace `typescript` as well.

---

## CI verification

```bash
# 1. Confirm resolved package
node -e "console.log(require.resolve('typescript'))"

# 2. Typecheck + require banner (adjust command to your project)
pnpm exec vue-tsc -b --noEmit 2>&1 | tee /tmp/tsc.log
grep -F 'TNB ACTIVE' /tmp/tsc.log || { echo 'TNB not active'; exit 1; }
```

**Linux CI:** The loader supports `bridge.so` / `bridge.dll`, but this repo may
only ship `bridge.dylib` until you build or publish per-platform binaries. Run
`npm run build:bridge` on the target OS, or ensure your package artifact includes
`native/bridge.*` for the runner (see [Platform support](#platform-support)).

Debug slow runs: `TSGO_PROFILE=1` prints a `[tsgo-profile]` timing summary to stderr on process exit (not a `.cpuprofile` file).

---

## Troubleshooting

### No banner appears

| Check | Action |
|---|---|
| Override at workspace **root** | Monorepo: `pnpm-workspace.yaml`, not a leaf package |
| pnpm 11 | Move `package.json` → `pnpm.overrides` to `pnpm-workspace.yaml` → `overrides:` (pnpm 11 no longer reads the `pnpm` field — silently ignored) |
| `catalog:` pin | Update catalog **and** overrides (see above) |
| Stale install | `pnpm install` again; clear CI cache if needed |
| Wrong resolution | `node -e "console.log(require.resolve('typescript'))"` |

### CLI works, editor doesn't (or vice versa)

Point the editor to **workspace** TypeScript (see [CLI vs editor](#cli-vs-editor)). CLI
and ESLint must resolve the same `node_modules/typescript` path.

### Type errors differ from stock TypeScript

TNB is experimental; tsgo parity with JS TypeScript is not 100%. Pin a version, diff
results, and report gaps. This is expected during early adoption.

### Missing native bridge

Error mentioning `bridge.dylib` / `bridge.so` / `bridge.dll` → run `npm run setup` in
this repo or ensure published artifacts include your platform.

---

## Platform support

| OS | Native library | Notes |
|---|---|---|
| macOS | `native/bridge.dylib` | Primary dev target; may be the only prebuilt binary in a dev clone |
| Linux | `native/bridge.so` | Build with `npm run build:bridge` on Linux for CI |
| Windows | `native/bridge.dll` | Supported by loader; build on Windows |

End users of a **published** package need prebuilt binaries per platform. Contributors
build locally with Go + a C toolchain (`npm run build:bridge`).

---

## Uninstall / rollback

Remove the `typescript` override from `pnpm-workspace.yaml` / `package.json`, reinstall,
and confirm:

```bash
pnpm install
node -e "console.log(require.resolve('typescript'))"   # should be stock typescript@5.x
```

No source changes in your app are required to roll back.

---

## FAQ

**Do I need to change my code?**  
No.

**Do I configure `vue-tsc` or ESLint separately?**  
No. They import `typescript`; one override covers them.

**Is this the same as `@typescript/native-preview`?**  
No. TNB replaces the full `typescript` package with an in-process Go bridge and Volar/SFC
integration. `@typescript/native-preview` ships the separate `tsgo` CLI (and preview JS
API) alongside stock `typescript` — you change scripts to call `tsgo`, not `tsc`.

**How much faster is it?**  
Depends on project size and shape; large `vue-tsc -b` workloads are the main target.
Measure on your repo with and without the override.

---

## Developing TNB (contributors)

> End users can skip this section. Consuming a **prebuilt** clone (with `lib/` +
> `native/bridge.*` already present) does not require Go. Building TNB from source
> in this repo requires Go, submodules, and `npm run setup`.

### First-time setup

```bash
git clone --recurse-submodules <repo>
cd typescript-native-bridge
npm run setup    # submodules + vendor JS + native bridge + lib/
```

### All scripts

| Script | Purpose |
|---|---|
| `setup` | Full first-time build (everything below) |
| `build:lib` | **Daily:** overlay → compile → LKG (~6s) |
| `build:ts` | Cold build (+ `npm install` in typescript submodule) |
| `build:js` | Compile `typescript-go` native-preview vendor (needed for bridge API types) |
| `build:bridge` | Rebuild Go `native/bridge.{dylib,so,dll}` |
| `patch:ts` | Apply `patches/typescript/` to submodule |
| `patch:tsgo` | Apply `patches/typescript-go/` to submodule |
| `save-ts-patches` | Save typescript submodule changes → `patches/typescript/` |
| `save-patches` | Save typescript-go submodule changes → `patches/typescript-go/` |
| `check:lib-sync` | Verify overlay / submodule / `lib/` are aligned |
| `check:enums` | Validate TS↔Go enum remapping tables |

### Two patch trees, three artifact families

```
patches/typescript/overlay/     ← TypeScript-side changes (edit here)
patches/typescript-go/overlay/  ← Go bridge changes (edit here)
        ↓ patch + build
lib/          JS bundles (typescript.js + _tsc.js)
native/       platform bridge binary
vendor/       native-preview JS (from build:js)
```

**TypeScript overlay workflow**

```
patches/typescript/overlay/
        ↓  npm run patch:ts   (also run by build:lib)
typescript/ submodule          ← do not edit by hand
        ↓  npm run build:lib
lib/typescript.js              ← tsserver
lib/_tsc.js                    ← tsc, vue-tsc
```

Never hand-edit `lib/*.js` or `typescript/src/`. Always rebuild both bundles via
`build:lib`. Run `npm run check:lib-sync` before committing.

**Go / bridge workflow**

```
patches/typescript-go/overlay/
        ↓  npm run patch:tsgo
typescript-go/ submodule
        ↓  npm run build:bridge
native/bridge.*
```

After editing either submodule working tree: `save-ts-patches` or `save-patches` before commit.

**Changing enums between TS and Go:** run `npm run check:enums`.

---

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This package is a derivative work of [Microsoft TypeScript](https://github.com/microsoft/TypeScript)
and [microsoft/typescript-go](https://github.com/microsoft/typescript-go).
