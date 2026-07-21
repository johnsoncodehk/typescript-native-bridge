# typescript-native-bridge (TNB)

> Published on npm as [`typescript-native-bridge`](https://www.npmjs.com/package/typescript-native-bridge).

**A drop-in `typescript` replacement that type-checks on Go.** Swap the `typescript`
package for this fork and keep using `tsc`, `vue-tsc`, `svelte-check`, `astro-check`,
`glint`, ESLint, and your editor exactly as before — the checker runs on **tsgo**
(Microsoft's Go TypeScript compiler) in-process instead of JavaScript. No new CLI, no
new LSP, no per-tool config, no code changes.

---

## Why not just use TypeScript 7 (tsgo)?

`typescript@7` is Microsoft's Go-native rewrite — but it doesn't drop into the tools you
actually use:

- **`vue-tsc` / `astro-check` / `svelte-check` / `glint`** are built on the **classic**
  `typescript` programmatic API (`createProgram`, Volar hooks, custom hosts). v7's
  programmatic surface is the new tsgo API — not a drop-in replacement for the classic
  one, so those tools can't just move to it.
- **ESLint (typescript-eslint)** imports the classic `typescript` API and calls
  `getTypeChecker()` — same API mismatch.
- **Editors** run `tsserver` + Language Service Plugins (`@vue/typescript-plugin` for
  `.vue`) — tsgo's LSP doesn't support that plugin model.

TNB keeps the **classic package surface** and puts the v7 engine (tsgo 7.x) behind it
in-process — so one `typescript` override accelerates all of them at once.

---

## Install

### pnpm (monorepos)

```yaml
# pnpm-workspace.yaml
overrides:
  typescript: npm:typescript-native-bridge@<version>
```

```bash
pnpm install
pnpm exec vue-tsc -b --noEmit    # or your project's typecheck script
```

If packages depend on `typescript` via `catalog:`, update the **catalog entry too**,
or those packages still resolve stock TypeScript:

```yaml
catalog:
  typescript: npm:typescript-native-bridge@<version>
overrides:
  typescript: npm:typescript-native-bridge@<version>
```

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

Use the alias **and** the `$typescript` override reference as shown — putting
`npm:typescript-native-bridge@…` directly inside `overrides` is rejected or mis-resolved
by some npm versions (issue #8). `<version>` is an exact version
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

### Local path (pinning a git checkout)

```yaml
# pnpm-workspace.yaml
overrides:
  typescript: link:../typescript-native-bridge
```

The checkout must be built first (requires Go — `npm run setup` in the TNB repo).

**After any override change: reinstall.** The override applies repo-wide — `vue-tsc`,
`@typescript-eslint/parser`, and every other transitive `typescript` consumer picks up
the fork.

---

## Confirm it's working

On the **first** type-check in a process, TNB prints to **stderr**:

```
┌─────────────────────────────────────────────────────────┐
│  ✅  TNB ACTIVE — `typescript` is the tsgo-backed fork  │
└─────────────────────────────────────────────────────────┘
```

**No banner = stock `typescript` is still loaded.** See [Troubleshooting](#troubleshooting).

```bash
node -e "console.log(require.resolve('typescript'))"
# should point at typescript-native-bridge, not node_modules/typescript@6.x
```

---

## Verified compatible tools

Verified means: the tool runs on the fork and its output matches stock `typescript@6.0.3`
on the stated workload (no crash, no silent under-reporting, no false positives beyond
the [known differences](#known-differences-from-stock-typescript)).

| Tool | Status | Verified on |
|---|---|---|
| `tsc` | ✅ | compiler test corpus |
| `vue-tsc` | ✅ | elk.zone monorepo (~2,000 files): **emitted-error parity** with stock, ~3.1× faster |
| `astro-check` | ✅ | fixture project: output identical to stock |
| `svelte-check` | ✅ | fixture project: output identical to stock (incl. `svelteHTML` ambient shims) |
| `glint` | ✅ | fixture project: same error set as stock (transformed `.gts` virtual files) |
| ESLint + typescript-eslint (type-aware rules) | ✅ | 1,000-file type-aware corpus: lint output byte-identical to stock |
| `tsserver` + `@vue/typescript-plugin` | ✅ | volar language-tools test suite: 205/205 pass |
| `tsslint` | ✅ | runs as the volar repo's own linter |

Continuous verification: a nightly CI gate replays **19,028 language-service probe
units** (quickinfo / definition / references / diagnostics) against the same stock
build — no new divergences allowed. If your tool isn't listed, try it and file an issue;
the fork covers any tool that drives the standard `typescript` Compiler API.

### Framework specifics

- `.vue`, `.svelte`, `.astro`, `.mdx`, `.gts` etc. via the standard
  `extraFileExtensions` contract — no hard-coded per-framework special case.
- Host-injected **virtual content** (Volar virtual TS, glint's transformed modules,
  svelte's ambient shims) reaches the Go checker.
- `allowArbitraryExtensions` is inferred `true` when host extra extensions are present
  and tsconfig leaves it unset; explicit `false` opts out.
- **Not supported:** custom `resolveModuleNames` / `resolveModuleNameLiterals` that
  remap an import to a different physical file (the bridge is synchronous JS→Go; tsgo
  cannot call back into JS resolvers).

---

## Performance

Measured on this repo's benchmarks (Apple Silicon; your repo will differ — measure):

| Workload | Stock `typescript` | TNB | |
|---|---|---|---|
| `vue-tsc -b` full check (elk.zone, ~2000 files) | 9.7s | **3.1s** | ~3.1× |
| type-aware ESLint, watch path (1000-file corpus) | 7.1s | 9.8s | 0.7× |
| type-aware ESLint, single-run path (plain TS projects) | 7.6s | 7.7s | parity |
| JS heap peak (same 1000-file ESLint run) | 1.57GB | **0.87GB** | −45% |

### Where the time goes (checker vs everything else)

Every workload splits into **tool overhead** (file IO, parsing, AST conversion, rules —
paid by both sides) and the **type-checking phase**. TNB wins or loses depending on
which phase dominates:

**`vue-tsc -b` (why TNB wins):** the whole-program semantic pass is most of the time.

| | Stock | TNB |
|---|---|---|
| Type-checking | ~5.6s (JS checker) | ~0.6s (Go checker) |
| Tool overhead (Volar codegen, JS, transport) | ~4.1s | ~2.5s |
| **Total** | **9.7s** | **3.1s** |

**Watch-mode ESLint (why TNB loses):** typescript-eslint rebuilds the program ~once per
linted file and issues ~469K small checker queries (86K `getTypeAtLocation` + symbol /
contextual-type lookups). Each query crosses JS→Go:

| | Stock | TNB |
|---|---|---|
| Lint without type info (tool overhead only) | 1.8s | 1.7s |
| Type-aware phase | ~5.3s (JS checker, in-process) | ~8.1s (see breakdown) |
| **Total** | **7.1s** | **9.8s** |

TNB's type-aware phase (~8.1s) decomposed:

| Layer | Time | What it is |
|---|---|---|
| Bridge round-trips | ~3.4s | 469K JS→Go calls, transport + Go compute measured together at the boundary (~7µs/call; ~1s of that is JSON serialization by CPU profile) |
| Go checker compute | inside the round-trips, small | bounded by measurement: the same engine does elk's entire whole-program pass in 0.6s — the engine is not the bottleneck |
| Fork JS query machinery | ~4.2s | adapter/fixup, remote node & symbol wrappers, GC churn (by subtraction) |
| Per-generation fixed costs | ~0.5s | 1,002 thin-program rebuilds (stock's structural sharing avoids these) |

Stock pays **zero transport** for the same queries — its checker sits in-process.
Single-run ESLint (plain TS projects) has exactly one program generation, so there's
nothing to repeat and it's parity. In short: **whole-program checking favors TNB;
high-frequency small-query workloads pay the bridge toll plus JS-side adapter costs.**

---

## Editor / tsserver (VS Code, Cursor)

CLI typecheck picks up TNB automatically. **The editor does not** — VS Code ships its
own TypeScript and only uses yours when you opt in.

**1. Workspace settings** (commit `.vscode/settings.json` for the team):

```jsonc
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true
}
```

Use a path relative to the workspace folder that contains `node_modules`.

**2. Switch to the workspace version** (once per machine):

Command Palette → **TypeScript: Select TypeScript Version** → **Use Workspace Version**.

**3. Verify:** the version picker shows a path under `node_modules/typescript/lib`; the
Output → TypeScript channel may show **TNB ACTIVE** on first project load. Vue/Nuxt users:
keep `@vue/typescript-plugin` in `tsconfig` `compilerOptions.plugins` as today — it runs
as a tsserver LS Plugin on this fork.

| | CLI | Editor |
|---|---|---|
| Override needed | Yes | Yes (same `node_modules/typescript`) |
| Extra config | No | `typescript.tsdk` + Use Workspace Version |

---

## Known differences from stock TypeScript

The checker is tsgo, so behavior is not yet bit-for-bit identical to the JS checker.
Across **19,028** replayed language-service probe units (quickinfo / go-to-definition /
find-all-references / diagnostics on a real-world Vue fixture corpus), **1,097 (5.8%)**
currently differ from the pinned stock build — all triaged and attributed (display
formatting, result ordering, cross-file reference residuals, intentional deviations).
The breakdown is tracked in
[#2 — known differences](https://github.com/johnsoncodehk/typescript-native-bridge/issues/2).
**Emitted-error parity on a large real-world Vue monorepo is exact.** If you hit a
difference not listed in the tracker, please file an issue with a minimal repro.

---

## Platform support

The bridge binary ships as per-platform optional dependencies; `npm install` pulls only
the one matching your machine (the main package is pure JS):

| Platform | Sub-package |
|---|---|
| macOS Apple Silicon | `@typescript-native-bridge/darwin-arm64` |
| macOS Intel | `@typescript-native-bridge/darwin-x64` |
| Linux x64 | `@typescript-native-bridge/linux-x64` |
| Linux arm64 | `@typescript-native-bridge/linux-arm64` |
| Linux arm (32-bit) | `@typescript-native-bridge/linux-arm` |
| Windows x64 | `@typescript-native-bridge/win32-x64` |
| Windows arm64 | `@typescript-native-bridge/win32-arm64` |

On an unsupported platform the loader fails with a clear "unsupported platform or
missing optional dependency" error — build from source there (clone with submodules,
then `npm run setup`; requires Go + a C toolchain).

---

## Troubleshooting

### No banner appears

| Check | Action |
|---|---|
| Override at workspace **root** | Monorepo: `pnpm-workspace.yaml`, not a leaf package |
| pnpm 11 | Move `package.json` → `pnpm.overrides` to `pnpm-workspace.yaml` → `overrides:` (pnpm 11 no longer reads the `pnpm` field — silently ignored) |
| `catalog:` pin | Update catalog **and** overrides |
| Stale install | `pnpm install` again; clear CI cache if needed |
| Wrong resolution | `node -e "console.log(require.resolve('typescript'))"` |

### CLI works, editor doesn't (or vice versa)

- **CLI OK, editor not:** add the [tsdk settings](#editor--tsserver-vs-code-cursor) and
  run **TypeScript: Select TypeScript Version → Use Workspace Version**. The override
  alone is not enough for the editor.
- **Editor OK, CLI not:** check `require.resolve('typescript')` — should point at TNB.
  Reinstall after changing overrides.

### Type errors differ from stock

Check [Known differences](#known-differences-from-stock-typescript) first — if yours
isn't listed, pin a version, diff results, and file an issue.

### Missing native bridge

Error mentioning `bridge.dylib` / `bridge.so` / `bridge.dll` / "unsupported platform" →
see [Platform support](#platform-support) (build from source, or use a `link:` install
built with `npm run setup`).

### Debug a slow run

`TSGO_PROFILE=1` prints a `[tsgo-profile]` RPC/timing summary to stderr on process exit.

---

## Uninstall / rollback

Remove the `typescript` override, reinstall, confirm:

```bash
pnpm install
node -e "console.log(require.resolve('typescript'))"   # stock typescript@6.x again
```

No source changes required.

---

## FAQ

**Do I need to change my code?** No.

**Do I configure `vue-tsc` / ESLint / my editor plugin separately?** No. They import
`typescript`; one override covers them.

**Is this the same as TypeScript 7 / tsgo?** Same engine, different package. TNB pins
tsgo 7.x as its checker (the version string ends in `tsgo.7.0.2`), but keeps the classic
`typescript` API and `tsserver` in front of it. `typescript@7` gives you the new tsgo
API and its own LSP instead — see [Why not just use TypeScript 7?](#why-not-just-use-typescript-7-tsgo)

**How much faster is it?** See [Performance](#performance) — biggest on `vue-tsc`-style
full-program workloads. Measure on your own repo.

---

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This package is a derivative work of [Microsoft TypeScript](https://github.com/microsoft/TypeScript)
and [microsoft/typescript-go](https://github.com/microsoft/typescript-go).
