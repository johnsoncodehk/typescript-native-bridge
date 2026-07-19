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
- [ ] **Editor:** set `typescript.tsdk` and switch to the workspace TypeScript version (see [Editor / tsserver](#editor--tsserver-tsdk))
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
  "devDependencies": {
    "typescript": "npm:typescript-native-bridge@<version>"
  },
  "overrides": {
    "typescript": "$typescript"
  }
}
```

Install with the alias **and** the `$typescript` override reference, as shown —
putting `npm:typescript-native-bridge@…` directly inside `overrides` is rejected or
mis-resolved by some npm versions (issue #8). `<version>` can be an exact version
(e.g. `^6.0.3-bridge.0.tsgo.7.0.2`) or the `latest` dist-tag.

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

### Editor / tsserver (tsdk)

CLI typecheck (`vue-tsc`, `tsc`) picks up TNB automatically after the override. **The IDE
does not** — VS Code / Cursor ship their own TypeScript and only use your fork when you
point **`typescript.tsdk`** at the workspace install and opt in to the workspace version.

After `pnpm install`, `node_modules/typescript` **is** TNB (same layout as stock
`typescript`: `lib/tsserver.js`, `lib/typescript.js`, …). The editor must load that
`tsserver`, not the built-in one.

**1. Add workspace settings** (commit `.vscode/settings.json` for the team):

```jsonc
// .vscode/settings.json — VS Code and Cursor
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true
}
```

Use a path relative to the **workspace folder** that contains `node_modules` (monorepo:
usually the repo root). With pnpm overrides this resolves to TNB's `lib/` even when the
physical path is a symlink.

**2. Switch to the workspace version (required once per machine / workspace)**

Command Palette → **`TypeScript: Select TypeScript Version`** → **Use Workspace Version**.

VS Code deliberately does not run workspace `tsserver` until you confirm (security). The
prompt appears on first open if `typescript.enablePromptUseWorkspaceTsdk` is set; otherwise
run the command manually.

**3. Verify**

- Status bar / **TypeScript: Select TypeScript Version** should show a path under
  `node_modules/typescript/lib`, not "VS Code's Version".
- Open a `.ts` file and trigger type-checking; **View → Output → TypeScript** may show
  **TNB ACTIVE** on first project load (same banner as CLI).
- Vue/Nuxt: keep `@vue/typescript-plugin` in `tsconfig` `compilerOptions.plugins` as today
  — it runs as a **tsserver LS Plugin** on this fork; no separate tsgo LSP.

| Path | Bundle | Used by |
|---|---|---|
| `lib/_tsc.js` | CLI | `tsc`, `vue-tsc -b` |
| `lib/tsserver.js` → `lib/typescript.js` | Language service | IDE, `tsserver`, LS Plugins |

### CLI vs editor (summary)

| | CLI | IDE |
|---|---|---|
| Needs override | Yes | Yes (same `node_modules/typescript`) |
| Extra config | No | **`typescript.tsdk` + Use Workspace Version** |
| Vue LS Plugin | via `vue-tsc` / program API | via forked `tsserver` + `@vue/typescript-plugin` |

---

## CI verification

```bash
# 1. Confirm resolved package
node -e "console.log(require.resolve('typescript'))"

# 2. Typecheck + require banner (adjust command to your project)
pnpm exec vue-tsc -b --noEmit 2>&1 | tee /tmp/tsc.log
grep -F 'TNB ACTIVE' /tmp/tsc.log || { echo 'TNB not active'; exit 1; }
```

**Linux CI:** nothing special — `npm install` automatically pulls the matching bridge
binary (`@typescript-native-bridge/linux-x64`) as an optional dependency (see
[Platform support](#platform-support)).

Debug slow runs: `TSGO_PROFILE=1` prints a `[tsgo-profile]` timing summary to stderr on process exit (not a `.cpuprofile` file).

---

## Known differences from stock TypeScript

The checker is tsgo, so behavior is not yet bit-for-bit identical to the JS checker:
across **37,409 replayed language-service probe units**, **1,231 (3.3%)** differ from
the pinned stock build — all triaged and attributed. The full breakdown (display
formatting, result ordering, cross-`.vue` reference residuals, intentional deviations)
is tracked in
[#2 — known differences](https://github.com/johnsoncodehk/typescript-native-bridge/issues/2).
Diagnostics parity (emitted errors) on a large real-world Vue monorepo is exact except
2 lines. If you hit a difference not listed in the tracker, please file an issue with a
minimal repro.

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

- **CLI OK, IDE not:** add [Editor / tsserver (tsdk)](#editor--tsserver-tsdk) settings and
  run **TypeScript: Select TypeScript Version → Use Workspace Version**. Override alone is
  not enough for the editor.
- **IDE OK, CLI not:** run `node -e "console.log(require.resolve('typescript'))"` — should
  point at TNB. Reinstall after changing overrides.
- CLI and IDE must both resolve the same `node_modules/typescript` (same override at
  monorepo root).

### Type errors differ from stock TypeScript

TNB is experimental; tsgo parity with JS TypeScript is not 100%. Check
[Known differences](#known-differences-from-stock-typescript) first — if yours is not
listed, pin a version, diff results, and report the gap.

### Missing native bridge

Error mentioning `bridge.dylib` / `bridge.so` / `bridge.dll` → run `npm run setup` in
this repo or ensure published artifacts include your platform.

---

## Platform support

The bridge binary ships as per-platform optional dependencies
(`@typescript-native-bridge/<os>-<arch>`, the esbuild / `@typescript/native-preview`
model). `npm install typescript-native-bridge` automatically installs only the
sub-package matching your machine — the main package itself is pure JS:

| Platform | Sub-package |
|---|---|
| macOS Apple Silicon | `@typescript-native-bridge/darwin-arm64` |
| macOS Intel | `@typescript-native-bridge/darwin-x64` |
| Linux x64 | `@typescript-native-bridge/linux-x64` |
| Linux arm64 | `@typescript-native-bridge/linux-arm64` |
| Linux arm (32-bit) | `@typescript-native-bridge/linux-arm` |
| Windows x64 | `@typescript-native-bridge/win32-x64` |
| Windows arm64 | `@typescript-native-bridge/win32-arm64` |

At runtime the loader resolves the bridge in order: the platform sub-package →
`<pkg>/native/bridge.*` (dev clone / `link:` install) → in-repo `go build` output.
On an unsupported platform the sub-package is silently skipped by npm and the loader
fails with a clear "unsupported platform or missing optional dependency" error —
build from source there (clone with submodules, then `npm run setup`; requires Go +
a C toolchain).

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
| `refresh` | Re-apply both patch trees and run `check:lib` |
| `save-ts-patches` | Save typescript submodule changes → `patches/typescript/` |
| `save-patches` | Save typescript-go submodule changes → `patches/typescript-go/` |
| `bump:version` | Bump `<stock>-bridge.N.tsgo.<tsgo>` — base change resets to `bridge.0`, else `bridge.N+1` (`--dry-run` to preview) |
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

`git status` will show `typescript` / `typescript-go` as modified after `patch:ts` /
`patch:tsgo` — that is expected (patches are applied to the submodule working tree, not
committed inside the submodule). Re-apply with `npm run refresh` after `git submodule update`.

**Changing enums between TS and Go:** run `npm run check:enums`.

### Release

Releases are published by CI (`.github/workflows/release.yml`): **push a tag and the
workflow builds the fork from source, runs the gates, publishes to npm with provenance,
and creates the GitHub Release.**

```sh
npm run bump:version            # <stock>-bridge.N.tsgo.<tsgo> — base bump resets to bridge.0
git commit -am "chore(release): $(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push --follow-tags
```

The tag name must be `v` + the exact `package.json` version — CI refuses to publish on
mismatch. The workflow has three jobs: `build-lib` (the platform-independent JS payload,
on `macos-latest`), `build-bridge` (a 7-leg matrix — native builds for darwin-arm64 /
darwin-x64 / linux-x64 / linux-arm64, cross-compiles from `ubuntu-latest` for linux-arm /
win32-x64 / win32-arm64), and `publish`, which assembles the seven
`@typescript-native-bridge/<os>-<arch>` sub-packages, publishes them, then publishes the
main package (all with provenance).

One-time npm setup:

1. Create the free npm org **`typescript-native-bridge`** (npmjs.com → Add Organization)
   — the seven platform sub-packages live under it.
2. Authentication, pick one:
   - **Trusted publishing (no token):** package settings → Trusted Publisher → GitHub
     Actions — org/user `johnsoncodehk`, repository `typescript-native-bridge`, workflow
     `release.yml`, environment empty, allowed action `publish` only. **Per package:**
     all 8 packages need this, and a package must exist on npm before its settings page
     does — squat the seven sub-packages with a `0.0.0` placeholder first (publish a
     one-file stub from each name).
   - **Token:** one granular access token covering all 8 packages, stored as the
     `NPM_TOKEN` Actions secret — simpler with 8 packages; the workflow uses it when
     present and falls back to OIDC otherwise.

Every version is semver-prerelease-shaped (`-bridge.N.tsgo.x.y.z`), so range installs
like `^6` never match; consumers install via the `latest` dist-tag (default) or an exact
version.

---

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This package is a derivative work of [Microsoft TypeScript](https://github.com/microsoft/TypeScript)
and [microsoft/typescript-go](https://github.com/microsoft/typescript-go).
