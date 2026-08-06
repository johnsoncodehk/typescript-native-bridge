# AGENTS.md

## Philosophy

**One path. No fallback. No ceremony.**

- **One path** — no mode flags or opt-out env vars. A fallback nobody sets is an untested code path that rots while the default gets all the coverage. If two behaviors are both defensible, pick one and delete the other; verify it with the gates, not with a switch.
- **No fallback** — do not degrade around hypothetical edges. Enumerate real edges and kill them by construction (idempotency, mechanism guarantees). If a failure mode cannot occur on the supported floor (Node ≥ 20, Go 1.26, current V8), do not code for it — fail loudly so real problems surface instead of hiding behind a silent degraded mode.
- **No ceremony** — if the language/runtime contract already provides the behavior (e.g. returning a NULL-initialized value propagates a pending napi exception), do not restate it in code. Comments explain *why* (ownership, contracts, invariants), never *what the next line does*.

Reference implementation of the style: `patches/typescript-go/overlay/bridge/napi_shim.c`.

### Convergence rules (so the tree never needs a sweep)

- **Env knobs need a committed consumer** — otherwise they're deleted on sight. One name per knob.
- **No debug scaffolding in product code** — instrumentation and its witness live and die together.
- **The pinned bundle is the floor** — call its API directly; no presence guards or compat branches. A mismatch must throw.
- **Abandoned approaches die in the same commit** — dead code is part of the pivot's diff.
- **Triage scripts are disposable** — wired gate, exit-coded probe, or deleted when the issue closes.
- **One harness, parameterized** — never fork a script to vary it.
- **Mechanism changes sweep their vocabulary** — grep the old name across patches/, tools/, comments in the same change.
- **Deletions are verified by the gates, not switches.**
- **No framework hardcoding** — behavior keys on registered mechanisms (`extraFileExtensions` / `supportedTSExtensionsFlat`), never on literal framework suffixes or names (`.vue`, `vue`, `svelte`…). If a fix needs a framework literal, the mechanism is what's missing.
- **One Go→JS file-name boundary** — `wireFileNameToHost` (tsgoLibPaths.ts) is the only normalization point for wire-decoded file names; every new transport/payload must funnel through it at its decode point, call sites never re-normalize. (Key folding is `canonicalSourceFilePath`; JS→Go input is `resolveHostFileName`.)
- **Review the landed diff for elegance before committing** — top smells: duplicated truth (call the source instead), caches that hide the problem, hidden contracts. Don't defend the first draft.

## Repo in one paragraph

TNB is a tsgo-backed TypeScript fork: upstream `microsoft/TypeScript` and `microsoft/typescript-go` pinned as submodules, a small patch set on top (`patches/`), and a NAPI bridge (`bridge.node`) that runs the tsgo checker in-process. Sources of truth: `patches/typescript/overlay` + `patches/typescript/*.patch` (edit via the submodule then `npm run save-ts-patches`), `patches/typescript-go/overlay` + `*.patch` (`npm run save-patches`). Build: `npm run build:lib` (fork bundles) and `npm run build:bridge` (NAPI addon).

## Gates (run before committing behavior changes)

- `npm run check:lib` / `check:enums` / `check:sourcefile-guard`
- Witnesses: 70 across wg0–wg6, all wired in CI (`.github/workflows/ci.yml`), single source of truth `tools/ci-witness-groups.mjs` — `node tools/ci-witness-groups.mjs all` validates dup/missing/orphan/local-only/baseline wiring and emits the matrix (`matrix` mode feeds the ci.yml prepare job).
- Local-only — run on demand, not in the matrix (reasons in the matrix header comment): framework-checks, external-edits, generation-retention, napi-fuzz, completion-latency, postedit-latency, perf-edit-rpc, perf-qi-rpc, typing-cpuprof.
- Semantic witnesses (the rest of the matrix is bare stock-parity checks):
  - `triage-crossgen-reuse` — issue #11: cross-generation RemoteSourceFile reuse + edit invalidation; a pre-edit type handle must die, not re-resolve
  - `triage-prototype-refresh` — issue #57: a replacement snapshot keeps Type prototype APIs routed to its live checker
  - `triage-nuxtui-exportstar` — issue #26: `./X.vue` with an on-disk `X.d.vue.ts` resolves to the declaration (@nuxt/ui dist pattern)
  - `triage-checker-differential` — checker-API stock differential: byte-equal canon per method@location, stale exemptions fail
  - `triage-type-field-audit` — every data field stock puts on a Type crosses the bridge equal or carries an inline exemption
  - `triage-program-info` — program-info API stock differential (include reasons, explainFiles, resolution caches, ATA)
  - `triage-arena-parity` — arena-vs-JSON transport differential: every arena-capable method's result byte-equal across both transports
  - `triage-symbol-global-exports` — `export as namespace` UMD symbol exposes a stock-shaped Map via hasGlobalExports + getGlobalExportsOfSymbol
  - `triage-lazy-accessor-retry` — failed reads are not memoized, retries resolve, success memoizes (incl. light-first exportSymbol upgrade)
  - `triage-bridge-thread-race` — worker_threads hosts: cross-thread text-response integrity + teardown-unload survival
  - `triage-eslint-typeref-target` — issue #35: isTypeReference→target→getSymbol() reads back registry-identical objects
  - `triage-custom-transformers` — issue #40: emit with non-empty customTransformers must throw (tsgo can't execute JS transformers)
  - `triage-ambient-order` — issue #42 class: ambient-module index run-stable (Go map order must not leak onto the wire)
  - `triage-diag-determinism` — issues #42/#51: whole-program diagnostics byte-identical across fresh runs (strided checker assignment)
  - `triage-exit-codes` — CLI exit-code stock parity (DiagnosticsPresent_OutputsGenerated = 2; noEmitOnError ordering)
  - `triage-cli-only-flags` — CLI-only options (`--strict`, `--target`, …) ride updateSnapshot to Go; diagnostics must move like stock
  - `triage-electron-abi` — issue #44: win32 bridge.node loads under Electron-as-node (wired out-of-matrix: ci.yml build job + nightly test-bridge-win32)
  - `triage-external-edits` (local-only) — issue #49: disk rewrites reach tsgo across estree/tsserver/tsc-watch host classes
  - `triage-generation-retention` (local-only) — 100 edit+F12 rounds hold a ≈0 heapUsed slope (no closure pins a generation island)
  - `triage-framework-checks` (local-only) — svelte-check/astro-check/glint vs stock parity (fixtures under /tmp/tnb-fw-fixtures)
  - `triage-napi-fuzz` (local-only) — NAPI payload fuzz probe
  - `triage-display-tokens` — issue #4: decoded RemoteNode display tokens (optionality token, template-head rawText)
  - `triage-computed-literal` — binder-literal computed property names print as-written
  - `triage-refs-exportspec` / `triage-quickinfo-emptyparity` — wg0 sweep pair: refs on re-exported classes + quickinfo empty-result parity (sweep-ls-throws regenerates /tmp/tnb-sweep-fixtures first)
  - `triage-sim-xfile` / `triage-sim-edit` — IDE-sim stock differential (cross-file ops + edit sessions)
  - f2hl/f2r6/f2qi/f2r5 series — editor-origin parity families (module-augmentation highlights, lib-global refs, def/ref case families)
- Big net: sim-nav vs `test/baselines/` (`npm run check:sim-nav` — 4 parallel shards from isolated tools copies, merged and baseline-gated by `tools/sim-nav-parallel.mjs`) — no new divergences allowed. Baselines are slim (keys/counters/labels only) with test-workspace-relative keys — machine-local paths in a committed baseline make the CI gate red by construction. Refresh by running check:sim-nav then `node tools/sim-nav-merge.mjs --slim /tmp/tnb-simnav-merged-4.json test/baselines/nav-results-<sha>-t<N>.json` (refuses absolute keys), re-pin `BASELINE` in `.github/workflows/ci.yml` and `.github/workflows/nightly.yml` (currently `test/baselines/nav-results-8c26673-t1.json`), delete the superseded baseline. The local gate cannot catch non-portable keys (same machine, same prefix) — CI is the clean-machine gate, check its result after a refresh.
- volar suite: `npm test` in the volar checkout (205 tests)

## Conventions

- Commits: plain-language, component-prefixed (`fix(bridge):`, `perf(bridge):`, `ci:`, `docs(readme):`), says what and why, no filler.
- Issue replies: written by a human or reviewed by the maintainer before posting. No templated "thanks for the detailed report" tone.
- Memory and behavior parity with stock `typescript` are the two hard constraints; measure before claiming either. **TNB fixes only bridge-introduced divergences.** That category includes the **bridge contract surface** (stock-API semantics the bridge must implement so stock's own services/session code runs correctly — additive APIs like `getSymbolOfExpando`, wire shapes, symbol identity) and **bridge-only-triggered engine bugs** (engine invariants no upstream caller relies on but the bridge's call patterns violate — fix locally, link the upstream report).
- For engine-owned behavior, the reference is **tsgo's actual behavior** (its own LSP/IDE output), not stock — deliberate engine design is documented, not overridden, and engine bugs go **upstream** (file the issue, link it, document the divergence as a known issue) rather than being patched here. Any "is it tsgo's or the bridge's?" verdict requires verification against **pristine, unpatched tsgo** — never the patched submodule, never TNB-vs-stock inference.
- **Exceptions:** a crasher *or a silent wrong result* on the headline path may carry a stopgap patch — each must be listed in the README's tsgo-behavior-changes section with the upstream issue link, and removed once upstream lands the fix. **Every TNB change to tsgo behavior is listed in the README, and the list is gate-enforced against the patch contents** — the mechanism is annotation-driven: the change-site hunk carries a `Ledger(<key>)` comment and `tools/check-readme-ledger.mjs` fails on either direction of drift (annotation without a README row, row without an annotation). A large alignment cost is never the default action — it needs maintainer sign-off.

## Accepted design tradeoffs

Mechanism-level compromises the convergence audit decided to keep as-is. Each entry: current state, why accepted, who polices it. Do not "fix" one of these without first re-opening the tradeoff in a review.

- **Arena oversize escapes to the JSON path** — an arena encode that would overflow (record/string regions meet) fails and the call's JSON document returns out-of-band as the napi value instead; 4 MiB is ~80× the largest expected hot-class response, so capacity is by design. Accepted because the escape is the same transport every method already has, and it turns an overflow into a loud failed encode rather than memory corruption. Policed by `triage-arena-parity.mjs` (every arena-capable method runs once per transport — JSON and arena — and must byte-equal).
- **Stale type handles die loudly, by construction** — Go TypeIDs are per-checker counters (`t.id = TypeId(c.TypeCount)`) with no generation marker, so the JS side pins handles in a snapshot-scoped registry (`projectRegistries`, keyed by TypeID = `t.Id()`): a handle from an old snapshot either still names the same type or fails with "type handle N not found in project registry" — it can never silently resolve to a rebuilt snapshot's same-id type. Accepted because stable ids are what let unchanged types reuse across generations; the cost is the loud-error contract. Policed by `triage-crossgen-reuse.mjs` (negative test: a handle captured pre-edit must die, not re-resolve).
- **Stable-SF cross-generation reuse rides external-change event completeness** — a reused stable host SourceFile is only as fresh as the events that evict it: every external rewrite must reach `_pendingExternalChangePaths`, drained by the overlay collect — the single transport choke (host≠disk rides the overlay push, host==disk becomes updateSnapshot `fileChanges.changed`). Accepted because one choke keeps the invariant checkable. Policed by `triage-external-edits.mjs` (local-only), incl. the stablecache phase.
- **Patch monoliths are accepted debt** — 0001-bridge-inplace (napi-shim overlay files + checker accessors + native-preview client — 48 files) and 0004-api-surface (the whole RPC surface: `internal/api/proto.go` + `session.go` + the native-preview api files) stay as single patches; splitting is deferred. Accepted because the carve-outs that do rebase independently (osvfs, noembed) already have their own patches. Policed by `npm run save-patches` (regenerates both from the submodule diff).
- **tsgoChecker.ts is one monolith** — the overlay adapter is a single ~13.8k-line file. Accepted because it mirrors one bridge contract; splitting it would invent an interface for ceremony's sake. Policed by review, not a gate.
- **SubstitutionType.constraint alias is code-path parity only** — the stock-name `constraint` resolving alias fires the same fetch the NESTED wire loop uses for `substConstraint`, but has no dedicated witness: there is no reliable source-level trigger. Accepted because it is a one-line alias over an already-gated fetch. Policed by review; the gap is documented in the `triage-lazy-accessor-retry.mjs` / `triage-type-field-audit.mjs` notes.
- **Cross-config light stubs pin to the first creator** — `_lightSfSharedByFile` keys stubs by host file name alone, so a stub's `metaEnabled`/`configFilePath` come from whichever config created it, not the one asking now. Accepted because BuilderProgram state only needs those fields to key stubs, and per-config stubs would duplicate the map. Policed by review.
- **checker-differential splitUnion miscuts function return unions** — `() => A | B` is split at the depth-0 `|` after its parameter list, so it can compare equal to a genuine top-level union on the U1 multiset path: a false pass, never a false failure. Accepted because it cannot fail the gate. Policed by the in-file known-limitation comment; structurally unable to false-fail.
- **Relations have no pristine differential gate** — `isTypeAssignableTo`/subtype/identical parity rests on the big nets (sim-nav, volar), not a dedicated differential witness. Accepted because no self-contained corpus produced stable triggers. Policed by the big nets; a dedicated gate needs maintainer sign-off to build.
- **typeDefinition divergences are pinned in the sim-nav baseline** — originally 22 ALWAYS divergences (16 `locClass: missing`, 6 `mixed`): TNB returns a proper subset of stock's locations. **Verdict (pristine-tsgo plain-TS restatement, 2026-08): bridge-introduced, not engine behavior** — pristine tsgo returns the full loc set identical to stock at every TNB⊂stock position. **Fixed (22/22 converged)**: three bridge gaps — (a) `checker.resolveName` with an undefined location skipped the Go RPC and returned undefined, breaking `getFirstTypeArgumentDefinitions`'s global-type unwrap gate (Array/Readonly first-type-argument declarations lost); (b) `tryGetReturnTypeOfFunction`'s `initializer === type.symbol.valueDeclaration` identity failed across the host/tsgo AST boundary (fork NodeObject vs tsgo NodeHandle), dropping return-type declarations — now a resolved-instance identity + span compare; (c) `tryGetReturnTypeOfFunction`'s gate1 `type.symbol === symbol` never fired where a virtual-file AST (volar) splits one symbol into a host binder SymbolObject and a tsgo wire symbol (the `async` keyword at `tsc/#2712/main.vue:8:1`), skipping return-type enrichment — now a `symbolsShareValueDeclaration` clause matches host-vs-wire pairs by their shared declaration node, restricted to function-like *declarations* (FunctionDeclaration / MethodDeclaration); wire pairs never take the declaration path because stock's `type.symbol` at a method-signature use-site is a distinct anonymous symbol sharing the declaration node (an over-wide version regressed `tsc/#5986/main.vue:6:30` and was caught by sim-nav). Baseline re-pinned (1747 diffs). Policed by the baseline gate (no new divergences allowed).
