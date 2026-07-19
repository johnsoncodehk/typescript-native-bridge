# AGENTS.md

## Philosophy

**One path. No fallback. No ceremony.**

- **One path** — no mode flags or opt-out env vars. A fallback nobody sets is an untested code path that rots while the default gets all the coverage. If two behaviors are both defensible, pick one and delete the other; verify it with the gates, not with a switch.
- **No fallback** — do not degrade around hypothetical edges. Enumerate real edges and kill them by construction (idempotency, mechanism guarantees). If a failure mode cannot occur on the supported floor (Node ≥ 20, Go 1.26, current V8), do not code for it — fail loudly so real problems surface instead of hiding behind a silent degraded mode.
- **No ceremony** — if the language/runtime contract already provides the behavior (e.g. returning a NULL-initialized value propagates a pending napi exception), do not restate it in code. Comments explain *why* (ownership, contracts, invariants), never *what the next line does*.

Reference implementation of the style: `patches/typescript-go/overlay/bridge/napi_shim.c`.

### Convergence rules (so the tree never needs a sweep)

- **Env knobs need a committed consumer** — a switch nothing in the repo sets is deleted on sight. Adding a knob requires its consumer (gate, witness, repro script) in the same change. Two spellings for one knob are one bug, not compatibility.
- **Debug scaffolding never merges** — no `TEMP` dumps, no `/tmp` trace blocks in product code. If a witness needs product-side instrumentation, the instrumentation and its consumer live and die together: closing the investigation deletes both in the same change.
- **The pinned bundle is the floor** — the vendored native-preview/bridge surface is fixed at build time. No presence guards for "stale" bridge methods, no compat branches for older bundle shapes, no `??` fallbacks on pinned enums. Call directly; a mismatch is a build bug and must throw.
- **Abandoned approaches die in the same commit** — dead functions, unused exports/params/fields, orphan imports, and unreachable branches left by a pivot are part of the pivot's diff, not follow-up work.
- **Triage scripts are disposable** — a script is either a wired gate (CI or the list below), an exit-coded reusable probe, or investigation scaffolding deleted when its issue closes. The artifact of an investigation is the fix plus its gate coverage, never the script archive.
- **One harness, parameterized** — never fork a diagnostic script to vary it (shards, file filters, output paths); add the parameter to the original. Two copies rot independently.
- **Mechanism changes sweep their vocabulary** — when a mechanism is replaced, grep its name (`koffi`, `create_buffer_copy`, …) across `patches/`, `tools/`, and comments in the same change. Comments describe the current contract, not the history of contracts.
- **Deletions are verified by the gates, not hedged by switches** — the gates below are why the rules above are safe. If a deletion feels risky, the answer is a witness, not a fallback.

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
