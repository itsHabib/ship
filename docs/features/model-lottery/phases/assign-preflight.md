# Phase 2b — `assign --preflight` viability filter

**Status:** in progress
**Owner:** @itsHabib (driver seat)
**Date:** 2026-07-13
**Closes (partial):** `work-driver-prep-model-pool` (the §5 slice of P2; live-run refusal §4.2 and the `/work-driver-prep --model-pool` skill flag ship as their own follow-ons)
**Spec:** [`../spec.md`](../spec.md) §5 (preflight), §6 (advisory block), §7 (convergence with #201)

## Scope

Weighted-LOC budget: **~200 wLOC** (amazing band). New `viability.ts` helper + preflight filter wiring into the existing `assign` flow + advisory-block extension + the CLI's real network/env adapter. Tests at 0.5×.

## Functional

Adds the `--preflight` phase (default on; `--no-preflight` skips) to `ship driver assign`. Before any round-robin assignment, the whole pool is filtered for reachability:

- **cursor members** — the model id is checked against a live `GET /v1/models` catalog. Runtime-agnostic: cursor viability does not depend on which runtime a stream resolves to, so every cursor member shares one catalog fetch.
- **claude members** — credential *presence* in env, matched to the runner the resolved cell selects: `local` → `CLAUDE_CODE_OAUTH_TOKEN || ANTHROPIC_AUTH_TOKEN || ANTHROPIC_API_KEY`; `cloud` → `ANTHROPIC_API_KEY` (the cloud runner's stricter requirement).
- **codex members** — `CODEX_API_KEY || OPENAI_API_KEY` presence (presence-only, acknowledged weaker than a catalog probe per spec §5).

Non-viable members are dropped with a recorded reason. The surviving **effective pool** — the actual input to round-robin — plus the dropped list and an `assigned_at` timestamp are written into the manifest's `assignment` advisory block alongside the requested `pool`. Round-robin then runs on the effective pool exactly as it does today.

Two hard boundaries preserve determinism and safety:

1. **Whole-pool, pre-assignment.** Preflight is a filter phase that completes before the first stream is stamped — never mid-rotation. Assignment stays a pure function of `(manifest, effective pool)`; a member recovering or dying between runs just changes the effective pool, visible in the manifest diff.
2. **Empty effective pool aborts before write-back.** If every member is dropped, `assign` fails loudly with the drop reasons and writes nothing — a zero-member rotation has nothing deterministic to stamp, and a half-written manifest is worse than a loud stop.

`--no-preflight` skips the network/env probe entirely: the effective pool equals the full pool, `dropped` is empty, and the advisory block still records `pool`/`effective_pool`/`assigned_at` for a uniform on-disk shape.

## Shared helper (spec §5, §7 convergence)

The per-target check is extracted as `checkTargetViability(target, deps)` in `packages/driver/src/viability.ts` — the single mechanism PR #201 §4.4 also wires to at hop time. A **dispatch target** is `(runtime, provider, model_id)` per spec §7. The helper is I/O-free itself; network and env are injected as `ViabilityDeps` ports so both call sites (assign at prep time, the fallback walk at hop time) supply their own adapters and both are unit-testable without a live network.

```
checkTargetViability(target: DispatchTarget, deps: ViabilityDeps): Promise<ViabilityResult>
  ViabilityDeps  = { listCursorModels: () => Promise<string[]>; env: Record<string, string | undefined> }
  ViabilityResult = { viable: true } | { viable: false; reason: string }
```

`preflightPool(pool, candidateRuntimes, deps)` (in `assign.ts`, which already owns `PoolMember` + runtime resolution) resolves each member to its candidate targets, dedups on the full `(runtime, provider, model_id)` key, calls `checkTargetViability` once per unique target, and maps verdicts back to members — returning `{ effective, dropped }` in original pool order.

**Unprefixed-member runtime (resolved — conservative multi-runtime check).** A pool member without a runtime prefix inherits its stream's runtime at assignment, which is not known during the whole-pool preflight phase. A member could therefore land on any assignable stream, so it is checked against **every distinct runtime among the manifest's assignable (non-terminal) streams** (`assignableRuntimes(manifest)`) and kept only if viable on *all* of them; a prefixed member is checked against its single runtime. This is deliberately conservative: resolving against only the manifest default (an earlier draft) would let a member that passes on the default but fails on a stream's own runtime through to a credential-less dispatch — the exact failure preflight exists to catch (codex review, PR #207). For cursor the distinction is immaterial (runtime-agnostic catalog check). A false-drop is advisory (fewer models in rotation); a false-keep defeats the check — so the trade favours dropping.

## Tradeoffs

- **Injected ports over a baked-in HTTP client.** `checkTargetViability` takes `listCursorModels` + `env` rather than calling `fetch` directly, so the shared helper stays testable and #201 reuses it without a live network. The real adapter, `createViabilityDeps(env)`, ships from `viability.ts` itself — mirroring `createExecGhPort` in `gh-port.ts` (driver already ships concrete adapters beside its ports) — so PR #201's *engine-level* hop-time walk builds the same `ViabilityDeps` the CLI does, not a CLI-only helper.
- **Memoized catalog fetch.** The CLI adapter's `listCursorModels` caches its one result; all cursor members (and members differing only by runtime) reuse it. No per-member network cost.
- **`assigned_at` breaks byte-identity of the advisory block, not of the assignment.** The stream stamps stay byte-for-byte deterministic (spec §4.1); only the advisory `assigned_at` varies run-to-run. `now` is an injected `() => string` so tests pin it and the 2a idempotence test stays green.
- **Presence-only codex/claude checks.** Env presence is not a catalog probe (spec §5 acknowledges this). A present-but-dead key survives preflight and fails at dispatch with the provider's error — the existing failure path, not a preflight concern.

## Explicit decisions

- **ED1 — preflight default on.** `--preflight` is the default; `--no-preflight` opts out. Matches spec §5. A seat wanting a fast offline stamp uses `--no-preflight`.
- **ED2 — empty effective pool is a hard error, not a warning.** Every other drop is advisory; a fully-empty pool aborts before write-back (spec §5 boundary).
- **ED3 — the helper is provider-scoped and runtime-sensitive.** Uniqueness key is the full `(runtime, provider, model_id)` target, not just `model_id` — a claude member viable locally may be non-viable on cloud (different credential requirement).
- **ED4 — no new verb, no doctor subcommand.** Preflight is a flag inside `assign`, warning-grade (spec §5).

## Validation

- `viability.test.ts`: cursor id in/out of catalog; claude local present via `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_API_KEY`, absent; claude cloud present/absent (only `ANTHROPIC_API_KEY` counts); codex present via either var, absent; unknown provider → non-viable (not a codex fallthrough); the real adapter (bearer auth, memoized single fetch, missing-key, non-2xx, unexpected-shape throw, empty-catalog `[]`, base-url override).
- `assign.test.ts` (extend): preflight drops a non-viable member → effective pool shrinks, dropped recorded in advisory; empty effective pool throws `AssignError` and writes nothing; `--no-preflight` path → effective == pool, dropped == []; `assigned_at` pinned via injected `now`; the 2a idempotence test updated to inject a fixed `now` and still round-trips; conservative multi-runtime — an unprefixed claude member on a `default_runtime: cloud` manifest with a `runtime: local` stream is dropped on `ANTHROPIC_AUTH_TOKEN`-only (cloud candidate needs `ANTHROPIC_API_KEY`) and kept on `ANTHROPIC_API_KEY`.
- `make check` green on ubuntu + windows (typecheck + lint + format + coverage; driver branch threshold).

## Risks

- **R1 — cursor `/v1/models` shape/auth drift.** The adapter targets the same endpoint the runway grok run proved. If auth or the response shape differs, the adapter (`viability.ts` edge) changes without touching the helper contract (parse stays in `parseModelIds`, the helper takes `string[]`). An unexpected shape (not `{ data: [...] }`) throws a hard, legible `AssignError` rather than returning `[]` — an empty list would drop every cursor member with a misleading "not in /v1/models" reason (codex/Copilot review, PR #207). An empty `{ data: [] }` catalog is not drift and returns `[]`.
- **R2 — network flake vs unviable member.** A transient `/v1/models` failure is *can't-determine*, not *member-unviable*. The catalog fetch rejection propagates as a hard, legible `AssignError` ("cursor /v1/models unreachable … use --no-preflight to skip") that aborts before any write-back — deliberately not a per-member drop that would silently collapse to the empty-pool abort with a misleading message. `--no-preflight` is the offline escape hatch.

## Out of scope

- **§4.2 live-run refusal** (manifest already bound to a non-terminal driver run) — separate PR; it introduces a store lookup (`driver_runs.manifest_path`) that preflight does not need.
- **`/work-driver-prep --model-pool` skill flag** — separate trivial follow-on (skill prose shelling to the verb).
- **PR #201 hop-time wiring** — #201 adopts this helper when it lands; this PR only creates it.

## Implementation plan

1. **`packages/driver/src/viability.ts`** — `DispatchTarget`, `ViabilityDeps`, `ViabilityResult`, `checkTargetViability` (pure), and `createViabilityDeps(env)` (real memoized `/v1/models` fetch adapter, mirrors `createExecGhPort`). Export from `index.ts`.
2. **`packages/driver/src/assign.ts`** — `preflightPool(pool, defaultRuntime, deps)` → `{ effective, dropped }`; dedup on resolved target; original-order effective pool. `DroppedMember` type.
3. **`packages/driver/src/assign-writeback.ts`** — extend the advisory block to `{ pool, effective_pool, dropped, assigned_at }`; make `assignModelPoolToManifest` async, taking `{ preflight, deps, now }`; empty-effective-pool guard before write-back; effective-pool feeds `computeAssignments`.
4. **`packages/cli/src/commands/driver.ts`** — `--no-preflight` flag; async action; pass `createViabilityDeps(process.env)` (or omit when `--no-preflight`) + `now: () => new Date().toISOString()`.
5. **`packages/cli/src/format.ts`** — render dropped members in the assign table.
6. **Tests** — `viability.test.ts` (new) + `assign.test.ts` (extend). `make check`.
