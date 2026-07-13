# Dispatch fallback chain — Technical Design Document

**Status:** draft / proposal — NOT a build commitment. The artifact we decide from.
**Owner:** @itsHabib
**Date:** 2026-07-13
**Related:** `docs/features/agent-runner-abstraction/` (the provider×runtime matrix this walks), `docs/features/driver-provider-passthrough/` (per-stream provider), `docs/features/gateway-auth-carrier/` (local-claude auth legibility), dossier project `ship`.

> **Reviewers — focus areas:** §4.2 (which failure categories auto-fall-back vs escalate — this is the risk surface), §4.4 (credential precondition stays outside ship), §7.2 (the hop flow and its interaction with the parallelism ledger), §8 (loop guard / exhaustion semantics).

## 1. Problem & hypothesis

A driver stream is bound to one `(runtime, provider)` pair for its whole life. When dispatch fails — a flaky cloud provider, an exhausted credit pool, a gateway auth rejection — the engine parks the stream at `failed`, stamps the run `awaiting_judgment`, and waits for a seat to type `ship driver decide retry`. That retry re-dispatches the **same** pair (`PENDING_RESET_PATCH` deliberately leaves `runtime`/`provider` untouched), so a dead provider produces a seat-interrupt loop for what is fundamentally a routing decision.

The operator already routes around this by hand: cursor-cloud got demoted as default because it flakes; local-claude (runtime `local`, provider `claude`) is $0 on the subscription and is the preferred floor. The engine should encode that routing: **each stream carries an ordered chain of fallback dispatch targets, and a dispatch failure with an environmental cause advances to the next target instead of interrupting the seat.**

Hypothesis: for dispatch-time failures with environmental categories, an auto-hop resolves the majority without judgment, and the run completes on a cheaper/steadier target with full provenance intact.

**Non-goals:**
- No credential loading in ship. The local-claude token precondition is the launcher's job (see §4.4); ship stays a pure env pass-through (`buildGatewayEnv`).
- No budget *tracking*. Ship reacts to `budget-exceeded` failures; it does not meter spend or enforce ceilings. A spend-aware policy is a different feature.
- No mid-run migration in v1. A stream that fails *after* work has started (partial commits, an open PR) does not auto-hop — that path keeps going to judgment (§10 Q3).
- No `rooms` targets. The engine already refuses `rooms` streams (`collectStreamPreflightErrors`); chains reject them the same way.

## 2. Functional & non-functional requirements

**FR**
1. A manifest stream may declare an ordered list of fallback dispatch targets; a run may declare a default chain inherited by streams that don't.
2. On a dispatch failure whose classified category is fallback-eligible, the engine rewrites the stream to the next viable target and re-dispatches — no seat interaction.
3. Non-eligible categories, and chain exhaustion, behave exactly as today: `failed` → `awaiting_judgment` with an escalation.
4. Every hop is recorded on the stream (from-target, to-target, triggering category) and visible in `driver status` and the rendered manifest.
5. Chains are validated at import: unknown/illegal targets (per the `selectRunner` matrix) fail the import loudly, not at hop time.
6. Streams with no chain behave byte-for-byte as today. The feature is opt-in.

**NFR**

| Dimension | Target |
| --- | --- |
| Safety | A hop can never dispatch the same work twice concurrently: the failed attempt holds no parallelism slot and is terminal before the re-dispatch is written. |
| Determinism | Chain consumption is strictly left-to-right, each target tried at most once per stream lifecycle. No retry loops within a target (that stays `decide retry`'s job). |
| Provenance | The stream's final `runtime`/`provider` columns reflect the target that did the work — `/provenance` and the PR footer derive from `driver_streams`, so they must be correct for free. |
| Legibility | Every hop and every skipped target leaves a recorded reason, mirroring `tierDegradeReason`. Silent rerouting is a bug. |
| Compat | Store schema change is additive; existing driver DBs open unchanged. Manifest without the new keys parses unchanged. |

## 3. Architecture overview

Two orthogonal enums already exist: `runtime` (`local | cloud | rooms` — `driverRuntimeSchema`, `packages/store/src/driver-schemas.ts`) and `provider` (`cursor | claude | codex` — `agentProviderSchema`, `packages/workflow/src/workflow.ts`). A **dispatch target** is one `(runtime, provider)` cell of the `selectRunner` matrix (`packages/core/src/service.ts`). The chain is a list of targets.

```
manifest: runtime/provider (+ fallback: [target, ...])
              │ import (validate every target against selectRunner cells)
              ▼
driver_streams: runtime, provider, fallback_chain, fallback_cursor, fallback_log
              │ tick → dispatchStream → dispatchStartShip
              ▼
        startShip throws ──► classifyFailure → category
              │                    │
              │        eligible + next viable target?
              │            yes ──► FALLBACK_RESET_PATCH (rewrite runtime/provider,
              │                    advance cursor, log hop) → re-dispatch next tick
              │            no  ──► failed → awaiting_judgment   (today's path, unchanged)
```

**Reused, not built:** the runtime-rewrite mechanism (`flipStreamToCloud` / `FLIP_CLOUD_RESET_PATCH` proves the store+engine can rewrite a stream's target mid-life and re-dispatch cleanly — this generalizes it); the failure taxonomy (`failureCategorySchema` already carries `gateway-unreachable`, `gateway-auth`, `budget-exceeded`, `sdk-throw` as tombstoned literals; `classifyFailure` in `packages/agent-runner/src/classify-failure.ts` already produces them); per-dispatch tier remapping (`buildShipInput` recomputes `mapTierToDispatch` per attempt — "must not inherit a previous attempt's mapping or degrade flags" — so a hop to a new provider gets correct model/effort mapping for free).

**Net-new:** the chain fields (manifest + store), the eligibility policy table, the hop transition in `dispatchStartShip`'s failure path, and the viability check (wired matrix cell + env precondition).

## 4. Key decisions & trade-offs

### 4.1 Chain elements are `(runtime, provider)` pairs, not runtimes
"Fall back to local" is ambiguous — local-what? The matrix has six wired cells and they differ in cost, steadiness, and auth needs. A pair-chain expresses the real policy (`cloud/cursor → cloud/claude → local/claude`) with no new vocabulary: both enums exist, `selectRunner` already rejects illegal combinations. **Alternative rejected:** a single `fallback_runtime` scalar (the `flipStreamToCloud` shape) — can't express the two-hop cost story that motivates this.

### 4.2 Failure-category policy: static allowlist, dispatch-time only
Fallback-eligible categories (v1): **`sdk-throw`, `gateway-unreachable`, `gateway-auth`, `budget-exceeded`, `contention`.** These are environmental: the *target* failed, not the work. Everything else — `logic`, `patch-apply-fail`, `timeout-near-cap`, `agent-collapse-on-running-tool`, `sandbox-denial`, `unknown` — escalates as today, because re-running the same spec on a different provider either won't help or deserves a human/seat look first. `unknown` escalating is the conservative choice: fallback must never mask a novel failure mode.

The table is a constant in `packages/driver` (policy), not config (mechanism stays dumb). **Alternative rejected:** per-category chain config in the manifest — YAGNI, and it turns a routing table into a programming language.

### 4.3 v1 scope: the `dispatchStartShip` catch path only
The hook is the existing failure branch in `dispatchStartShip` (`packages/driver/src/engine.ts`): the attempt is already stamped, the slot already released, the stream about to be marked `failed`. Interposing there means the hop inherits every invariant the failed-dispatch path already maintains. Failures *after* a successful dispatch (mid-run) keep today's judgment path — a mid-run hop has to reason about partial work, branch reuse, and half-open PRs, none of which dispatch-time has (§10 Q3).

### 4.4 Credential precondition stays outside ship
A hop to `(local, claude)` only works if `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` is in the ambient env — ship reads no `credentials.json` and gains no credential-loading responsibility (the neutral-gateway boundary, `buildGatewayEnv` / `validateRunInput` in `packages/claude-runner/src/local-runner.ts`). The engine treats "env precondition unmet" as a **viability check at hop time**: the target is skipped with a recorded reason and the chain advances. Import-time preflight *warns* (recorded on the run) but does not fail — the env at import and the env at hop time are the same process env today, but warning-not-failing keeps the check honest about what it can actually promise. **Alternative rejected:** ship loading the token itself — convenient, and wrong; it crosses a boundary the gateway-auth-carrier work deliberately drew.

### 4.5 Opt-in, no engine default chain
An unset chain means today's behavior, byte-for-byte. The *policy* of "cloud runs should fall back to local-claude" belongs to the layer that writes manifests (`/work-driver` prep), not baked into the engine — same split as tier policy (seat picks tiers, `tier-map` maps them). Whether `/work-driver` should stamp a default chain into every manifest it generates is an operator policy call (§10 Q1).

## 5. Data model

**Manifest** (`packages/driver/src/manifest.ts`):
- Per-stream `fallback`: array of `{ runtime, provider }`, default `[]`.
- Run-level `default_fallback`: same shape; streams without an explicit `fallback` inherit it. Mirrors the existing `default_runtime` / `default_provider` precedent.

**Store** (`packages/store/src/driver-schemas.ts`, additive columns on `driver_streams`):
- `fallbackChain` — JSON array of targets, frozen at import (resolution of manifest + run default).
- `fallbackCursor` — integer, next chain index to try; starts 0.
- `fallbackLog` — JSON array of hop records: `{ from: target, to: target, category, skipped?: reason, at }`. Append-only, the `tierDegradeReason` analog.

The stream's existing `runtime` / `provider` columns remain the single source of truth for *current* target — hops rewrite them (the `flipStreamToCloud` precedent), which is what keeps `driver status`, rendering, and `/provenance` correct with zero changes.

Failure-category literals: no additions needed — v1's eligibility set uses existing tombstones.

## 6. API contract

- **Manifest keys** as in §5; import validation extends `collectStreamPreflightErrors`: every chain target must be a wired `selectRunner` cell, must not be `rooms`, and must not equal the stream's primary target or an earlier chain entry (dupes are certainly authoring errors).
- **No new CLI/MCP verbs.** `driver status` and the rendered manifest gain a fallback line per hopped stream (`fallback: cloud/cursor → local/claude on budget-exceeded`), same rendering seam as `degrade=` in `status-mapping.ts`.
- **`decide` verbs unchanged in v1.** `retry` keeps meaning "same target again" — its reset patch untouched. (A `retry --target` override is the natural v2, §9 P3.)
- **Escalation copy** on chain exhaustion names the chain: what was tried, what category killed each hop. The escalation shape (`buildFailureTriageRequests`) is otherwise unchanged.
- **Error model:** import rejects invalid chains with per-stream structured errors (same channel as existing preflight errors). Hop-time skips are not errors — recorded reasons in `fallbackLog`.

## 7. Key flows

### 7.1 Import
1. Parse manifest; resolve each stream's effective chain (`fallback` ?? `default_fallback` ?? `[]`).
2. Validate every target (wired cell, no `rooms`, no dupes vs primary/earlier entries) → structured import failure on violation.
3. If any chain contains `(local, claude)` and neither `ANTHROPIC_AUTH_TOKEN` nor `ANTHROPIC_API_KEY` is present in env: record a run-level warning (visible in status), proceed.
4. Freeze chain onto the stream row, cursor 0, empty log.

### 7.2 Dispatch failure → hop
1. `dispatchStartShip` catches the throw from `ship.startShip`; attempt stamped, no slot held (all existing behavior).
2. Classify: dispatch-time throws today stamp `sdk-throw`; where the thrown error carries a structured category (gateway/budget), use it. Category not in the eligibility allowlist → step 6.
3. Walk `fallbackChain` from `fallbackCursor`: for each candidate, check viability — wired cell (defense in depth; import already guaranteed it) and, for `(local, *)` claude targets, the env precondition. Unviable → append `{skipped}` record, advance cursor, continue.
4. Viable target found → apply `FALLBACK_RESET_PATCH`: rewrite `runtime`/`provider` to the target, reset status to pending and clear tier-mapping/degrade columns (superset of `PENDING_RESET_PATCH`), advance cursor past the target, append hop record.
5. Next tick dispatches the stream normally: `buildShipInput` branches on the *new* runtime, `mapTierToDispatch` remaps tiers for the *new* provider, `selectRunner` picks the runner. Nothing downstream knows a hop happened.
6. No viable target (empty, exhausted, or ineligible category) → today's path verbatim: `failed`, `awaiting_judgment`, escalation (now enriched with the hop history).

### 7.3 What goes wrong
- **Hop target also fails** → same flow; cursor already advanced, so it tries the next entry or exhausts. Termination is structural (finite chain, monotonic cursor).
- **Crash between patch and re-dispatch** → the stream is a pending row with rewritten target; resume dispatches it — identical to how a pending stream survives a crash today.
- **Operator retries an exhausted stream** (`decide retry`) → same target as its last hop (the current columns), cursor stays exhausted; a second failure escalates again rather than re-walking the chain. Chains don't refill.

## 8. Concurrency / consistency / failure model

- Hops happen inside the tick's failure handling for that stream — single-writer per stream, same as every other stream mutation; no new races.
- The failed attempt is terminal before the reset patch is applied; the re-dispatch is a fresh attempt row. At most one live attempt per stream, invariant preserved.
- Chain state is monotonic: cursor only advances, log only appends. There is no path that re-tries a consumed target automatically.
- Ineligible category, exhausted chain, empty chain: all collapse to the existing `failed → awaiting_judgment` machinery. Fallback strictly *narrows* the set of seat interrupts; it never invents a new terminal state.

## 9. Rollout / implementation plan

| Phase | Goal | High-level tasks | Depends on | Gate | Scope |
| --- | --- | --- | --- | --- | --- |
| **P1 — chain schema** | Chain declared, validated, stored, visible | manifest keys + inheritance; store columns; import preflight (cell/rooms/dupe validation, env warning); status/render line | — | — | ~250–400 wLOC |
| **P2 — engine hop** | Dispatch failure auto-hops end-to-end | eligibility table; viability check; `FALLBACK_RESET_PATCH` (generalize the flip precedent); hook in `dispatchStartShip` failure path; exhaustion escalation copy; fake-runner e2e (forced dispatch fail → completes on next target) | P1 | **VALIDATION GATE** | ~350–550 wLOC |
| P3 — decide target override *(post-gate stub)* | `decide retry` accepts an explicit target for judged failures | new decide option + reset patch variant; supersedes `flipStreamToCloud`'s one-off shape | P2 | gated | stub |
| P4 — mid-run fallback *(post-gate stub, maybe never)* | Env-category failures after dispatch auto-hop | requires partial-work semantics (branch reuse, PR state) — see §10 Q3 | P3 | gated | stub |

**The gate (after P2):** on a real run, force a dispatch failure on the primary cloud target with a chain ending in `(local, claude)` → the stream completes on local-claude with zero `decide` interactions, correct provenance columns, and a legible hop record in `driver status`. Binary: it either lands unattended or it doesn't. Phases P3/P4 are speculative until this proves out.

## 10. Open questions

1. **Should `/work-driver` stamp a default chain into generated manifests** (e.g. `default_fallback: [cloud/claude, local/claude]` whenever the primary is cloud)? Engine stays opt-in either way; this is seat-layer policy and the operator's call. (This was the original prompt for the feature — "stamp CLAUDE.md with fallbacks" — resolved here as: the *manifest* is where that policy lands, not repo markdown.)
2. **Is `contention` correctly in the eligibility set?** Local-run contention hopping to cloud is attractive (that's the `flipStreamToCloud` use case, inverted); but contention can also mean "wait a tick and it clears." Reviewers: weigh in.
3. **Mid-run fallback semantics** (P4): what does a hop mean when the failed attempt pushed commits or opened a PR? Adopt-and-continue on the new target, or fresh-branch restart? Unresolved; deliberately out of v1.
4. **Dispatch-time category fidelity:** dispatch throws today classify as `sdk-throw`, which is broad. Is it worth teaching the dispatch path to surface `gateway-auth`/`budget-exceeded` from structured runner errors in P2, or is `sdk-throw`-eligible good enough to prove the thesis?

## 11. Validation plan

The §9 gate is the signal: **one real forced-failure run that lands unattended on the fallback target.** Secondary checks: (a) a no-chain manifest produces a byte-identical stream lifecycle vs main (regression harness with fake runners); (b) chain exhaustion produces exactly one escalation whose body names every hop; (c) `/provenance` on the gated run reports the fallback target, not the primary. All three are binary and baseline-free.
