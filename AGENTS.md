# AGENTS.md

## Philosophy

**One path. No fallback. No ceremony.**

- **One path** — no mode flags or opt-out env vars. A fallback nobody sets is an untested code path that rots while the default gets all the coverage. If two behaviors are both defensible, pick one and delete the other; verify it with the gates, not with a switch.
- **No fallback** — do not degrade around hypothetical edges. Enumerate real edges and kill them by construction (idempotency, mechanism guarantees). If a failure mode cannot occur on the supported floor (Node ≥ 20, Go 1.26, current V8), do not code for it — fail loudly so real problems surface instead of hiding behind a silent degraded mode.
- **No ceremony** — if the language/runtime contract already provides the behavior (e.g. returning a NULL-initialized value propagates a pending napi exception), do not restate it in code. Comments explain *why* (ownership, contracts, invariants), never *what the next line does*.

Reference implementation of the style: `patches/typescript-go/overlay/bridge/napi_shim.c`.

## Repo in one paragraph

TNB is a tsgo-backed TypeScript fork: upstream `microsoft/TypeScript` and `microsoft/typescript-go` pinned as submodules, a small patch set on top (`patches/`), and a NAPI bridge (`bridge.node`) that runs the tsgo checker in-process. Sources of truth: `patches/typescript/overlay` + `patches/typescript/*.patch` (edit via the submodule then `npm run save-ts-patches`), `patches/typescript-go/overlay` + `*.patch` (`npm run save-patches`). Build: `npm run build:lib` (fork bundles) and `npm run build:bridge` (NAPI addon).

## Gates (run before committing behavior changes)

- `npm run check:lib` / `check:enums` / `check:sourcefile-guard`
- Witnesses: `node tools/triage-sim-xfile.mjs`, `triage-sim-edit.mjs`, `triage-quickinfo-emptyparity.mjs`, f2hl/f2r6 series, `triage-refs-exportspec.mjs`, `triage-display-tokens.mjs`, `triage-computed-literal.mjs`, `triage-napi-fuzz.mjs`
- Big net: sim-nav 4 shards vs `test/baselines/` (`SIM_NAV_SHARD_COUNT=4 node tools/triage-sim-nav-shard.mjs`, merge with `tools/sim-nav-merge.mjs`) — no new divergences allowed
- volar suite: `npm test` in the volar checkout (205 tests)

## Conventions

- Commits: plain-language, component-prefixed (`fix(bridge):`, `perf(bridge):`, `ci:`, `docs(readme):`), says what and why, no filler.
- Issue replies: written by a human or reviewed by the maintainer before posting. No templated "thanks for the detailed report" tone.
- Memory and behavior parity with stock `typescript` are the two hard constraints; measure before claiming either.
