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
(e.g. `6.0.3-bridge.6.tsgo.7.0.2` — pin exactly; caret ranges don't match
prerelease versions) or the `latest` dist-tag.

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

On the **first** type-check in a process, TNB prints one dimmed line to **stderr**:

```
▎ TNB ACTIVE — `typescript` is the tsgo-backed fork
```

**No banner = stock `typescript` is still loaded.** See [Troubleshooting](#troubleshooting).

```bash
node -e "console.log(require.resolve('typescript'))"
# should point at typescript-native-bridge, not node_modules/typescript@6.x
```

---

## Verified compatible tools

Verified means: the tool runs on the fork and its behavior matches tsgo's on the
stated workload (no crash, no silent under-reporting, no false positives beyond
the [differences from tsgo](#behavior-and-differences-from-tsgo)).

| Tool | Status | Verified on |
|---|---|---|
| `tsc` | ✅ | compiler test corpus |
| `vue-tsc` | ✅ | elk.zone monorepo (~2,000 files): **emitted-error parity** with stock, ~3× faster |
| `astro-check` | ✅ | fixture project: output identical to stock |
| `svelte-check` | ✅ | fixture project: output identical to stock (incl. `svelteHTML` ambient shims) |
| `glint` | ✅ | fixture project: same error set as stock (transformed `.gts` virtual files) |
| `mdx-tsc` | ✅ | fixture project: diagnostic output identical to stock (Volar `runTsc`, errors mapped to MDX source spans) |
| ESLint + typescript-eslint (type-aware rules) | ✅ | 1,000-file type-aware corpus: lint output byte-identical to stock |
| `tsserver` + `@vue/typescript-plugin` | ✅ | volar language-tools test suite: 205/209 pass (4 skipped) |
| `tsslint` | ✅ | runs as the volar repo's own linter |

Continuous verification: a nightly CI gate replays the language-service probe
corpus (quickinfo / definition / references / diagnostics, ~19k units) against the
same stock build — no new divergences allowed. If your tool isn't listed, try it and
file an issue; the fork covers any tool that drives the standard `typescript`
Compiler API.

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
| `vue-tsc -b` full check (elk.zone, ~2,000 files) | 9.7s | **3.2s** | ~3× |
| type-aware ESLint, single-run (1,000 plain-TS files, one program) | 2.3s | 2.4s | +1.5% |
| same, 3,000 files | 6.9s | 6.8s | ~parity |
| JS heap peak (1,000-file ESLint fixture) | 769MB | 631MB | −18% |
| peak RSS, whole-process (vue-tsc -b; TNB's includes the in-process Go checker) | 1.8GB | 3.3GB | ~1.9× — structural |

**The rule is simple: wherever the time is in the checker, TNB is faster.** The
question for any workload is how much of its time that phase is — and how much of
it pays the JS↔Go boundary instead.

**`vue-tsc -b` (checker-dominated — the big win):** the whole-program semantic
pass drops from ~5.5s (JS checker) to ~1.5s (Go checker), and most of stock's
~2.6s full-program parse+bind never happens — TNB's thin program materializes
files lazily, on demand. The rest is Volar codegen and JS-side work both sides
pay. The Go checker's in-process program state is also why TNB's whole-process
RSS runs higher than stock's on this workload — JS heap stays lower; RSS is the
honest whole-process figure.

**Editor / LS path (Volar + tsserver):** the V8-arena transport (fixed-layout
records written straight into V8 memory, DataView reads, interned strings) keeps
per-keystroke work near the transport floor. Measured on a 5,537-request roam
over the volar corpus (one long-lived session): **~1.0 bridge RPC per request**;
p50 quickinfo **0.16ms**, completionInfo **0.23ms**, references **1.5ms** (p95
7.4 / 9.0 / 48ms — means are tail-dominated). Per-request byte figures in older
revisions of this section described the bridge-internal JS↔Go channel, not the
editor-facing tsserver wire.

**The carve-out — single-run type-aware ESLint is the workload with the least to
gain.** Its time is in parsing, AST conversion and rule execution (work both
sides pay), and its type-aware queries arrive as tens of thousands of tiny calls
(~44K checker RPCs per 1,000 files after the bridge's per-generation memoizing)
that measure the JS↔Go boundary, not the engine. TNB lands within ~2% of stock
at both sizes — parity, not a win; peak JS heap stays at or below stock. The
memory wins live on the long-session editor path (see release notes).

---

## Editor / tsserver (VS Code, Cursor)

CLI typecheck picks up TNB automatically. **The editor does not** — VS Code ships its
own TypeScript and only uses yours when you opt in.

**1. Workspace settings** (commit `.vscode/settings.json` for the team):

```jsonc
{
  "js/ts.tsdk.path": "node_modules/typescript/lib",
  "js/ts.tsdk.promptToUseWorkspaceVersion": true
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
| Extra config | No | `js/ts.tsdk.path` + Use Workspace Version |

---

## Behavior and differences from tsgo

The checker's behavior is **tsgo 7.0.2's** (Microsoft's Go TypeScript), not stock
TypeScript 6.0.3's — migrating from stock means inheriting tsgo's diagnostics,
bundled libs, and display output as-is.

TNB's own changes to tsgo behavior — the complete list, enforced by CI:

| Change | Why | Upstream | Removal |
|---|---|---|---|
| `getTypeFromTypeNodeWorker` resolves type-position entity names (identifier / qualified name / property access) | Silent wrong result on the headline path: hover on `P` in `[P, (typeof OBJ)[P][number]]` read `any` instead of the type parameter (issue #30) | repro branch `repro/type-position-entity-reads-any` (issue pending) | When the upstream fix lands |
| `tsgo-symbolflags-typealias-display`: typeParametersToTypeParameterDeclarations checks `Class|Interface|TypeAlias` (stock's `SymbolFlags.TypeAlias`) instead of `Class|Interface|Alias`, so type parameters now appear in type-alias display | Upstream mistranslated stock's `SymbolFlags.TypeAlias` as `SymbolFlagsAlias` (import alias), dropping `<P>` from type-alias display | upstream issue pending | When upstream fixes the mistranslation |
| `tsgo-immaliased-nil` — bridge-only guard (no tsgo behavior change): getImmediateAliasedSymbol returns nil instead of panicking for declaration-less synthetic aliases; only the bridge's exposed API can hit the branch — tsgo's own callers already nil-check the result | A Go panic on the bridge's NAPI boundary is process-fatal where stock's failure is a catchable JS throw | — | — |
| `tsgo-instsymbol-active-guard` — bridge-only guard (no tsgo behavior change): getTypeOfInstantiatedSymbol/getWriteTypeOfInstantiatedSymbol dispatch by flags when cross-checker reuse yields a nil target or a cyclic instantiation chain; the guards never fire on stock-shaped data | Per-checker valueSymbolLinks go empty/cyclic only when the bridge reuses a SymbolHandle across checkers | — | — |
| `tsgo-ctx-initializer-nil-guard` — bridge-only guard (no tsgo behavior change): getContextualType returns nil for a parentless node instead of nil-dereferencing; parsed trees always parent non-root nodes, so only the bridge's GetContextualType RPC can supply one | The bridge runs stock-derived callers that can pass synthetic/parentless nodes | — | — |

Anything that looks like a difference from stock 6.0.3 but isn't listed here is
tsgo's own behavior, not TNB's. Found an actual TNB-only divergence? File an
issue with a minimal repro.

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

Linux packages target glibc 2.31 and are rejected by the release gate if they
acquire a newer symbol requirement. **Alpine/musl is not supported**: Go's
`-buildmode=c-shared` runtime crashes at load on musl libc — even a trivial
hello-world c-shared library segfaults, on Go 1.22 through 1.26 alike
([golang/go#13492](https://github.com/golang/go/issues/13492), a 10-year-open
upstream issue with an active fix in
[golang/go#75048](https://github.com/golang/go/issues/75048); tsgo's own CLI
works on Alpine only because it ships CGO-free static binaries, and a NAPI
bridge cannot be CGO-free). Workaround: run the typecheck/lint step in a
glibc-based image (`node:24` or `node:24-bookworm-slim`) and deploy into the
Alpine stage of your multi-stage build; `apk add gcompat` does not help.

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

Expected — the checker's behavior is tsgo 7.0.2's, not stock 6.0.3's, so output
can differ from stock (see [Behavior and differences from
tsgo](#behavior-and-differences-from-tsgo)). What **is** a bug: output that
differs from tsgo itself — file an issue with a minimal repro.

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
