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
- **Review the landed diff for elegance before committing** — top smells: duplicated truth (call the source instead), caches that hide the problem, hidden contracts. Don't defend the first draft.

## Repo in one paragraph

TNB is a tsgo-backed TypeScript fork: upstream `microsoft/TypeScript` and `microsoft/typescript-go` pinned as submodules, a small patch set on top (`patches/`), and a NAPI bridge (`bridge.node`) that runs the tsgo checker in-process. Sources of truth: `patches/typescript/overlay` + `patches/typescript/*.patch` (edit via the submodule then `npm run save-ts-patches`), `patches/typescript-go/overlay` + `*.patch` (`npm run save-patches`). Build: `npm run build:lib` (fork bundles) and `npm run build:bridge` (NAPI addon).

## Gates (run before committing behavior changes)

- `npm run check:lib` / `check:enums` / `check:sourcefile-guard`
- Witnesses: `node tools/triage-sim-xfile.mjs`, `triage-sim-edit.mjs`, `triage-quickinfo-emptyparity.mjs`, `triage-crossgen-reuse.mjs` (issue #11: cross-generation RemoteSourceFile reuse + edit invalidation), `triage-framework-checks.mjs` (svelte-check/astro-check/glint vs stock parity — cached fixture installs under /tmp/tnb-fw-fixtures), f2hl/f2r6 series, `triage-refs-exportspec.mjs`, `triage-display-tokens.mjs`, `triage-computed-literal.mjs`, `triage-napi-fuzz.mjs`, `triage-arena-parity.mjs` (arena-vs-JSON transport differential: every arena-capable method's result byte-equal across the two transports), `triage-electron-abi.mjs` (wired in CI via `npm i --no-save electron@42`)
- Big net: sim-nav vs `test/baselines/` (`npm run check:sim-nav` — 4 parallel shards from isolated tools copies, merged and baseline-gated by `tools/sim-nav-parallel.mjs`) — no new divergences allowed. Baselines are slim (keys/counters/labels only) with test-workspace-relative keys — machine-local paths in a committed baseline make the nightly gate red by construction. Refresh by running check:sim-nav then `node tools/sim-nav-merge.mjs --slim /tmp/tnb-simnav-merged-4.json test/baselines/nav-results-<sha>-t<N>.json` (refuses absolute keys), re-pin `BASELINE` in `.github/workflows/nightly.yml`, delete the superseded baseline. The local gate cannot catch non-portable keys (same machine, same prefix) — nightly is the clean-machine gate, check its result after a refresh.
- volar suite: `npm test` in the volar checkout (205 tests)

## Conventions

- Commits: plain-language, component-prefixed (`fix(bridge):`, `perf(bridge):`, `ci:`, `docs(readme):`), says what and why, no filler.
- Issue replies: written by a human or reviewed by the maintainer before posting. No templated "thanks for the detailed report" tone.
- Memory and behavior parity with stock `typescript` are the two hard constraints; measure before claiming either.
