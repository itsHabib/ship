# Dispatch fallback chain — Technical Design Document

**Status:** draft / proposal — NOT a build commitment. The artifact we decide from.
**Owner:** @itsHabib
**Date:** 2026-07-13 (v5 — cycles 2–4 folded. v3 headline: the v1 boundary is **pre-work failures**, not dispatch-time — hooked at both the dispatch catch and the poll-time terminal-failure path, gated by a no-work-products check. v4: `(reviewCycles ?? 0)` gate, per-cell env table split by runtime, retry-before-category ordering, `(cloud, claude)` needs `branch_name`. v5: shared viability helper takes context primitives not a stream (#202 reuse); the work-products gate reads existing columns, no phantom branch column; §4.7 sensor is a transient-shape allowlist because `isRetryable` isn't surfaced in the code today; walk atomicity + derived `failed:` line + both-seam validation checks.)
**Related:** `docs/features/agent-runner-abstraction/` (the provider×runtime matrix this walks), `docs/features/driver-provider-passthrough/` (per-stream provider), `docs/features/gateway-auth-carrier/` (local-claude auth legibility), **PR #202 — model-lottery TDD (sibling; shares the dispatch-target type and `checkTargetViability`, §4.1/§4.6)**, dossier project `ship`.

> **Reviewers — focus areas:** §4.3 (the pre-work boundary — v3's load-bearing change), §4.2 (eligibility × when each category can actually fire), §7.2 (hop flow vs attempt/slot/breaker invariants), §8 (loop guard / exhaustion / transient-retry semantics).

## 1. Problem & hypothesis

A driver stream is bound to one `(runtime, provider)` pair for its whole life. When dispatch fails — a flaky cloud provider, an exhausted credit pool, a gateway auth rejection — the engine parks the stream at `failed`, stamps the run `awaiting_judgment`, and waits for a seat to type `ship driver decide retry`. That retry re-dispatches the **same** pair (`PENDING_RESET_PATCH` deliberately leaves `runtime`/`provider` untouched), so a dead provider produces a seat-interrupt loop for what is fundamentally a routing decision.

The operator already routes around this by hand: cursor-cloud got demoted as default because it flakes; local-claude (runtime `local`, provider `claude`) is $0 on the subscription and is the preferred floor. The engine should encode that routing: **each stream carries an ordered chain of fallback dispatch targets, and a failure with an environmental cause — before any work products exist — advances to the next target instead of interrupting the seat.**

Hypothesis: for pre-work failures with environmental categories, an auto-hop resolves the majority without judgment, and the run completes on a cheaper/steadier target with full provenance intact.

**Non-goals:**
- No credential loading in ship. Env preconditions are the launcher's job (§4.4); ship stays a pure env pass-through (`buildGatewayEnv`).
- No budget *tracking*. Ship reacts to failure categories; it does not meter spend or enforce ceilings. (`budget-exceeded` is *not* fallback-eligible in v1 — §4.2.)
- No migration of started work. A stream that owns work products (pushed branch, open PR, review cycles) never auto-hops — that path keeps going to judgment. v3 enforces this with data (§4.3), not hook location, so it holds even through `decide retry` round-trips.
- No `rooms` targets. The engine already refuses `rooms` streams (`collectStreamPreflightErrors`); chains reject them the same way.

## 2. Functional & non-functional requirements

**FR**
1. A manifest stream may declare an ordered list of fallback dispatch targets; a run may declare a default chain inherited by streams that don't.
2. On a failure whose classified category is fallback-eligible **and whose stream carries no work products**, the engine rewrites the stream to the next viable target and re-dispatches — no seat interaction. This covers both synchronous dispatch throws and async pre-work terminal failures surfaced at poll time.
3. Non-eligible categories, work-carrying streams, and chain exhaustion behave exactly as today: `failed` → `awaiting_judgment` with an escalation — enriched with the full hop/skip/retry history and, for skips, the concrete remedy (§6 escalation copy).
4. Every hop, skip, and transient retry is recorded on the stream and rendered first-class in `driver status` and the rendered manifest — same treatment as `tierDegradeReason`, never buried in a raw log column.
5. Chains are validated at import: unknown/illegal targets (per the `selectRunner` matrix), `rooms`, dupes, and any target that fails the **same per-cell structural requirements primaries already enforce** (`branch_name` for `(local, *)` and `(cloud, claude)`; `repo_url` for `(cloud, *)`) fail the import loudly, not at hop time.
6. Streams with no chain behave byte-for-byte as today. The feature is opt-in.
7. Exactly one escalation per failure episode: chain exhaustion subsumes the #199 dispatch-failing breaker escalation; the two never both fire for one episode.

**NFR**

| Dimension | Target |
| --- | --- |
| Safety | A hop can never dispatch the same work twice concurrently (failed attempt terminal + slot released before the re-dispatch is written), and can never migrate started work (no-work-products gate). |
| Determinism | Chain consumption is strictly left-to-right; each target gets at most one transparent transient retry, then the cursor advances. No unbounded loops anywhere (§8). |
| Provenance | The stream's final `runtime`/`provider`/model columns reflect the target that did the work — `/provenance` derives from `driver_streams`. Hop records carry resolved from/to models so cross-provider remaps are attributable (§4.1). |
| Legibility | Every hop, skip, and retry leaves a recorded reason with first-class rendering. Silent rerouting is a bug. |
| Compat | Store schema change is additive; existing driver DBs open unchanged. Manifest without the new keys parses unchanged. |

## 3. Architecture overview

Two orthogonal enums already exist: `runtime` (`local | cloud | rooms` — `driverRuntimeSchema`, `packages/store/src/driver-schemas.ts`) and `provider` (`cursor | claude | codex` — `agentProviderSchema`, `packages/workflow/src/workflow.ts`). A **dispatch target** is `(runtime, provider, model_id?)` — a wired cell of the `selectRunner` matrix (`packages/core/src/service.ts`) plus an optional concrete model override (§4.1). The chain is a list of targets. The target type and the viability helper are shared with the model-lottery TDD (#202); whichever lands second adopts the first's verbatim.

```
manifest: runtime/provider (+ fallback: [target, ...])
              │ import (validate: wired cell, no rooms, no dupes,
              │         local needs branch_name, cloud needs repo_url)
              ▼
driver_streams: runtime, provider, target_model_id,
                fallback_chain, fallback_cursor, fallback_log
              │ tick → dispatchStream → dispatchStartShip
              ▼
   failure surfaces at EITHER seam:
     sync:  startShip throws in dispatchStartShip's catch (`sdk-throw`)
     async: runToTerminal fails in background (setImmediate) → pollOneStream
            sees terminal failure with classifyFailure category
              │
              ▼
   pre-work (no work products) AND transient-allowlist AND target unretried?
     yes ──► one same-target re-dispatch (recorded {retried}) — independent
             of the category allowlist, so transient non-hop categories
             (contention) get their second chance here
   else: eligible category AND pre-work AND next viable target?
     yes ──► FALLBACK_RESET_PATCH (rewrite target, advance cursor, log hop,
             reset #199 breaker window) → re-dispatch next tick
     no  ──► failed → awaiting_judgment (today's path; ONE escalation,
             hop/skip/retry history + remedies, subsumes breaker copy)
```

**Reused, not built:** the runtime-rewrite mechanism (`flipStreamToCloud` / `FLIP_CLOUD_RESET_PATCH` proves the store+engine can rewrite a stream's target mid-life and re-dispatch cleanly — this generalizes it); the failure taxonomy (`failureCategorySchema` literals are persisted-forever — "tombstone" means *never rename/delete*, not *inactive*; `classifyFailure` already produces the poll-time categories); per-dispatch tier remapping (`buildShipInput` recomputes `mapTierToDispatch` per attempt); the work-products signals (`reviewCycles` + the engine's real-PR discrimination in `isAddressRedispatch` — the #184 flip-skip lesson: key on `reviewCycles`, not `prUrl` alone, because a failed flip persists `prUrl`).

**Net-new:** the chain fields + `target_model_id` (manifest + store), the eligibility policy table, the no-work-products gate, the hop transition wired at **two seams** (`dispatchStartShip` catch + the poll-time terminal-failure path), the shared viability helper (§4.6), the #199 breaker interplay rule, the bounded transient retry, and a render-overlay extension (§5).

## 4. Key decisions & trade-offs

### 4.1 Chain elements are `(runtime, provider, model_id?)` targets, not runtimes
"Fall back to local" is ambiguous — local-what? The matrix has six wired cells and they differ in cost, steadiness, and auth needs. A pair-chain expresses the real policy (`cloud/cursor → cloud/claude → local/claude`) with no new vocabulary: both enums exist, `selectRunner` already rejects illegal combinations.

The optional `model_id` completes the target type: a hop across providers needs a model answer anyway (a model on one provider may have no analog on another — the `tier-map` degrade rules are the precedent), and the model-lottery TDD (#202 §7) needs the same triple for pool members plus a `model_id` manifest passthrough. Semantics: entry specifies `model_id` → it wins; entry omits it → the stream's tiers remap through `mapTierToDispatch` for the new provider. **One target type, two features.**

Two consequences made explicit (cycle-2 findings):
- **`model_id` must survive the dispatch pipeline.** Stamping `dispatchModel` in the reset patch is not enough — `dispatchStream` recomputes tiers and writes `tierDispatchPatch` before `buildShipInput`, overwriting it. The current target's `model_id` is therefore a persisted stream column (`target_model_id`, §5) that dispatch reads *after* tier mapping: present → it wins; absent → tier mapping stands.
- **A cross-provider hop changes the model, and that must be attributable.** Hop records carry the resolved from/to model. Streams that hopped are re-attributed in (or excluded from) model-comparison readouts — #202's experiment must not silently lose its assignment; one line in its readout query handles it.

**Alternative rejected:** a single `fallback_runtime` scalar (the `flipStreamToCloud` shape) — can't express the two-hop cost story that motivates this.

### 4.2 Failure-category policy: static allowlist, honest about when each fires
Where categories come from: the dispatch catch stamps **`sdk-throw`** for every synchronous throw (it never calls `classifyFailure`); the poll-time path runs `classifyFailure` (`packages/agent-runner/src/classify-failure.ts`) and produces the richer categories. v3 hooks both seams (§4.3), so poll-time categories are now live triggers — for pre-work streams only.

| Category | Fallback-eligible? | Fires in v1? |
| --- | --- | --- |
| `sdk-throw` | **yes** | yes — sync, at the dispatch catch |
| `gateway-unreachable` | **yes** | yes — async pre-work, at the poll seam |
| `gateway-auth` | **yes** | yes — async pre-work, at the poll seam |
| `budget-exceeded` | **no — needs a split first** (§10 Q5) | n/a |
| `contention` | **no** (v1) | n/a — transient; the §4.7 retry + next tick is the answer, not a burned chain slot |
| `logic`, `patch-apply-fail`, `timeout-near-cap`, `agent-collapse-on-running-tool`, `sandbox-denial`, `unknown` | no — escalate as today | — |

Rationale for the exclusions (cycle-1/2 findings, adopted):
- **`budget-exceeded` conflates two things:** provider-credit exhaustion (environmental — hop is right) and run/task budget limits (`error_max_turns`, cloud `retries_exhausted` map into the same literal — the *work* is too big; hopping re-runs a likely-too-large task on another target, doubling spend and masking a spec problem). Out until split (§10 Q5).
- **`contention` is transient by nature** — consuming a chain entry on a wait-signal is the worst version of the transient-blip problem (§4.7). Its real use case (local contention → go cloud) is P3's `decide retry --target`; `flipStreamToCloud` exists for the seat today.
- `unknown` escalating is the conservative choice: fallback must never mask a novel failure mode. `timeout-near-cap` stays out: the task isn't smaller on a different provider.

Dispatch-time category fidelity (§10 Q4): at the dispatch catch nearly everything is `sdk-throw`, so v1's sync-side policy is effectively "any dispatch throw hops (pre-work, viable target)". The `cloud-sdk-cause-persistence` task (already filed) is the P2 dependency that surfaces structured causes; as those land, the sync side inherits the same table.

The table is a constant in `packages/driver` (policy), not config (mechanism stays dumb). **Alternative rejected:** per-category chain config in the manifest — YAGNI, and it turns a routing table into a programming language.

### 4.3 v1 boundary: pre-work failures, enforced by data — not by hook location
**(v3's load-bearing change; replaces v2's "dispatch catch only".)** Two cycle-2 findings broke the v2 scoping from both sides: (a) `runShipStart` schedules `runToTerminal` via `setImmediate` and returns a workflow id immediately, so the flagship failure — an invalid cloud credential — throws in the background and surfaces through `pollOneStream`, never reaching the dispatch catch: the v2 design would park exactly the scenario its gate promised to hop. (b) After a mid-run failure and a seat `decide retry`, the *re-dispatch* can throw environmentally — the v2 dispatch-catch hook would see "dispatch-time failure, eligible" and migrate a stream that owns a pushed branch and an open PR.

Both resolve with one rule: **the fallback boundary is whether work products exist, not where the failure surfaced.** The hop hook runs at two seams — the `dispatchStartShip` catch (sync throws) and the poll-time terminal-failure handling (async failures) — and both gate on:

> eligible category **AND** the stream carries no work products.

The work-products predicate is grounded in the engine's *existing* notion of "carries real work," not a new column (cycle-3 finding: v3 named "no recorded branch push," but no branch-push column exists in `driver_streams` — §5 adds none). The load-bearing signal is **`(reviewCycles ?? 0) === 0`**: the engine already treats `prUrl` as unreliable on its own — a failed cloud flip persists `prUrl` on the failure path, so `isAddressRedispatch` deliberately requires `prUrl !== undefined && (reviewCycles ?? 0) > 0` (both), and the #184 lesson says the same. The null-coalesce is itself load-bearing — freshly imported streams have `reviewCycles` *unset*, so a literal `=== 0` fails the gate for exactly the main pre-work case (cycle-3 P1 finding); **P1 initializes the column to `0` at import** and the gate reads `(reviewCycles ?? 0)`.

One boundary P2 must pin down, not a new column: a **cloud** stream that auto-created a PR (`autoCreatePR`) at `reviewCycles == 0` is a genuine work product that the `reviewCycles`-only signal wouldn't catch. The gate must treat a *real* `prUrl` (distinguished from a failed-flip artifact exactly as the engine already does) as work → don't hop. Concretely: pre-work ⇔ `(reviewCycles ?? 0) === 0` **and** no genuine PR — reusing the engine's real-work discrimination, not reinventing it. For the dispatch-throw and async-pre-work failures this feature targets, the agent never ran, so both signals are clean; the auto-PR case is the one edge the P2 predicate must cover.

A pre-work stream is semantically identical at both seams: nothing exists anywhere except a store row, so a hop is a pure re-route. A work-carrying stream never hops, whatever the category, whichever the seam — mid-run migration (adopt-vs-restart, branch semantics across runtimes) stays P4's problem (§10 Q3). This gate also makes §7.2's reset-patch claim provably safe: no real work exists at any legal hop.

Cost of the wider seam: the poll-time hook touches `pollOneStream`'s failure branch, which is more trafficked than the dispatch catch. Mitigation: the gate is a pure predicate over columns already loaded; ineligible streams take today's path with zero behavior change (§11 check a covers both seams).

### 4.4 Env/structural preconditions stay outside ship; skips are loud and actionable
Viability preconditions are split by *when they're knowable* and *whose job they are*:

- **Import time (structural — reject):** chain targets inherit the same provider×runtime structural requirements primaries already have — a `(local, *)` or `(cloud, claude)` target on a stream with no `branch_name` (the cloud Claude runner only reconstructs branch/PR metadata from a prescribed `prBranch`; primaries are already rejected without it), or a `(cloud, *)` target on a stream/manifest with no `repo_url` (cycle-2 finding: without this, a local-primary stream with a cloud fallback hops into a `cloud stream requires repo_url` preflight throw *outside* the fallback path). All authoring errors — the route could never work; reject the import. The implementation should derive these from the same per-cell requirements the primary preflight uses, not restate them.
- **Hop time (environmental — skip loudly):** required env credential absent, or local worktree missing → the target is skipped with a recorded reason and the chain advances. Env requirements are a **per-cell table, not a local-claude special case** (cycle-2 finding — the driver-hardening run's `MissingApiKeyError` was a *cursor* cell), and the claude rows split by runtime (cycle-3 finding — `CloudClaudeRunner` reads only `ANTHROPIC_API_KEY`; the local runner also accepts Claude Code OAuth and bearer auth): `cursor/*` → `CURSOR_API_KEY`; `claude/local` → `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_API_KEY`; `claude/cloud` → `ANTHROPIC_API_KEY` only; `codex` → its key per `default-wiring.ts`. Getting this wrong isn't cosmetic: an OAuth/AUTH-token-only env would mark a cloud/claude hop viable, burn the chain entry, and fail at dispatch instead of recording an actionable skip. The table lives next to the `selectRunner` wiring, which already knows each runner's construction needs.
- Skips get the same first-class render treatment as `tierDegradeReason` — `driver status` shows `skipped (local, claude): ANTHROPIC_API_KEY not set` without drilling into raw columns — and the exhaustion escalation names every skipped target **with its remedy** (§6), because a skipped credential is invisible-by-default and `decide retry` won't re-walk the chain to recover it (§8; accepted v1 limitation).
- Import-time env preflight *warns* (recorded on the run) but does not fail — same process env at import and hop time today, but warning-not-failing keeps the check honest about what it can promise. Ship still loads no credentials (`buildGatewayEnv` / `validateRunInput` boundary — the gateway-auth-carrier line).

**Alternative rejected:** ship loading tokens itself — convenient, and wrong.

### 4.5 Opt-in engine; prep stamps the default chain
An unset chain means today's behavior, byte-for-byte. The *policy* of "cloud runs fall back to local-claude" belongs to the layer that writes manifests — and per the cycle-2 review's Q1 answer, `/work-driver` prep should stamp **`default_fallback: [local/claude]`** (one entry — the $0 floor; keep it simple) whenever the primary is cloud. The engine stays opt-in; prep carries the opinion. (This resolves the feature's original prompt — "stamp CLAUDE.md with fallbacks" — as manifest-layer policy, not repo markdown.)

### 4.6 The viability check is one shared mechanism, used at two moments
"Is this target dispatchable right now, and if not, record why and move on" is the same question for a fallback hop (this TDD) and for the model-lottery's assign-time preflight (#202 §5 names it `checkTargetViability`). One helper in `packages/driver`, invoked at both call sites — but its input is **context primitives, not a `DriverStream`** (cycle-3 P1 finding): `checkTargetViability(target, ctx: { branch_name?, repo_url?, env })` → viable, or a structured skip reason (unwired cell / missing env per the §4.4 table / missing worktree). The lottery runs *before* stream rows exist, so a stream-typed input would force it to fabricate a fake stream — exactly what "one shared mechanism" is meant to prevent. The fallback hop assembles `ctx` from the stream row; the lottery assembles it from the manifest entry + process env. Prevents divergent notions of "dead target."

### 4.7 One bounded same-target retry for transient throws, then advance
A single 10-second `api.cursor.com` connect-timeout (friction log 2026-07-06 F1 — the cursor SDK error carried `isRetryable: true`) must not permanently demote a stream off its intended target: "each target once" + "chains don't refill" would otherwise turn a blip into a lifecycle decision.

**The v1 sensor is a known-transient-error-shape allowlist, not a retryable flag** (cycle-3 finding, verified against the code): `isRetryable` appears *nowhere* in `packages/` — ship does not surface or persist it today. The friction-log flag lived on the raw SDK error and was never carried into the driver. So v1 keys on a small allowlist of transient shapes classifiable from the error already in hand — connect-timeout / transient-network / 429-rate-limit class — defined next to the eligibility table. Keying on a first-class retryable flag is a future enhancement, gated on ship first persisting one (§10 Q6, now resolved to this).

Rule: when the failure matches the transient allowlist, the stream is pre-work, **and** the current target hasn't been retried yet, re-dispatch the same target once — transparently, recorded in `fallbackLog` as `{retried, target, reason, at}` — before anything else. **The retry predicate is independent of the §4.2 category allowlist and is checked first** (cycle-3 finding: ordered after the category gate, transient non-hop categories — `contention`, exactly the case §4.2 delegates here — would never reach it). One retry per target per lifecycle; second failure falls through to the hop gate or escalates. Non-transient failures skip straight to the hop gate. This stays inside the #199 breaker budget (§7.2 step 0: two attempts on a target, then movement — the breaker's 3-consecutive park is unreachable while the chain is live).

## 5. Data model

**Manifest** (`packages/driver/src/manifest.ts`):
- Per-stream `fallback`: array of `{ runtime, provider, model_id? }`, default `[]`.
- Run-level `default_fallback`: same shape; streams without an explicit `fallback` inherit it. Mirrors the existing `default_runtime` / `default_provider` precedent.
- (`model_id` on entries is the same passthrough #202 needs for primary assignment; P1 lands the field once.)

**Store** (`packages/store/src/driver-schemas.ts`, additive columns on `driver_streams`):
- `fallbackChain` — JSON array of targets, frozen at import (resolution of manifest + run default).
- `fallbackCursor` — integer, next chain index to try; starts 0.
- `fallbackLog` — JSON array of records, append-only: hops `{ from: target, to: target, fromModel, toModel, category, at }`, skips `{ skipped: target, reason, at }`, retries `{ retried: target, reason, at }`.
- `targetModelId` — the current target's `model_id`, nullable. Read by dispatch *after* tier mapping (present → wins; absent → tier mapping stands) — required because `dispatchStream` writes `tierDispatchPatch` over `dispatchModel` before `buildShipInput` (§4.1).

**No work-product column is added.** The §4.3 pre-work gate reads *existing* columns (`reviewCycles`, plus the engine's real-PR discrimination) — there is no branch-push column in `driver_streams` and this feature does not introduce one (cycle-3 clarification).

The stream's existing `runtime` / `provider` columns remain the single source of truth for *current* target — hops rewrite them (the `flipStreamToCloud` precedent), which keeps `driver status` and `/provenance` correct with zero changes.

**Render note:** the rendered manifest is *not* correct for free — `renderDriverRun` parses stored `sourceJson` and `overlayStreamProgress` overlays progress fields only (status/PR/merge/cycles), not `runtime`/`provider`. P1 extends the overlay to reflect the stream's current target plus the fallback/skip/retry line. Without this, a hopped stream renders as its original target — silent rerouting, which §2 NFR-Legibility forbids.

Failure-category literals: no additions needed in v1 (§10 Q5 may add a billing-specific one later).

## 6. API contract

- **Manifest keys** as in §5; import validation extends `collectStreamPreflightErrors`: every chain target must be a wired `selectRunner` cell, not `rooms`, not a dupe of the primary or an earlier entry, and must satisfy the same per-cell structural requirements primaries do — `branch_name` for `(local, *)` and `(cloud, claude)`, `repo_url` for `(cloud, *)` — derived from the existing primary preflight, not restated.
- **No new CLI/MCP verbs.** `driver status` and the rendered manifest gain a fallback line per affected stream — hops (`fallback: cloud/cursor → local/claude on gateway-auth`), skips (`skipped (local, claude): ANTHROPIC_API_KEY not set`), and retries (`retried cloud/cursor once on sdk-throw`), same rendering seam as `degrade=` in `status-mapping.ts`.
- **`decide` verbs unchanged in v1.** `retry` keeps meaning "same target again" — its reset patch untouched. (A `retry --target` override is the natural v2, §9 P3.)
- **Escalation copy on chain exhaustion — specified now, not deferred:** subject `dispatch failed after fallback: <stream> exhausted <n>-target chain`; body lists, in order: the primary target + its category (+ `retried once` if applicable), then each chain entry with its outcome — `hopped on <category>` / `failed: <category>` / `skipped: <reason> — remedy: <e.g. "set ANTHROPIC_API_KEY">` — and closes with **which target a bare `decide retry` will re-fire (the current columns — i.e. the last chain target, not the primary)**, so post-remedy behavior never surprises. The `hopped`/`skipped`/`retried` lines come straight from `fallbackLog`; the terminal **`failed: <category>` line is derived, not logged** — `fallbackLog` has no failure record, so the builder joins the terminal attempt row's category with the stream's current `runtime`/`provider` at halt time (the last dispatched target). **One escalation per episode:** exhaustion subsumes the #199 `dispatch-failing` breaker copy; the breaker never separately escalates a stream with a live chain (§7.2 step 0).
- **Error model:** import rejects invalid chains with per-stream structured errors (same channel as existing preflight errors). Hop-time skips/retries are not errors — recorded reasons in `fallbackLog`, rendered per above.

## 7. Key flows

### 7.1 Import
1. Parse manifest; resolve each stream's effective chain (`fallback` ?? `default_fallback` ?? `[]`).
2. Validate every target (wired cell, no `rooms`, no dupes vs primary/earlier entries, and the same per-cell structural requirements as primaries — `branch_name` for `(local, *)` and `(cloud, claude)`, `repo_url` for `(cloud, *)`) → structured import failure on violation.
3. If any chain target's per-cell env requirement (§4.4 table) is unmet in the current env: record a run-level warning (visible in status), proceed.
4. Freeze chain onto the stream row, cursor 0, empty log, `targetModelId` null.

### 7.2 Failure → hop (both seams)
0. **Breaker interplay (#199):** while a stream has unconsumed chain (or an unused §4.7 retry), the consecutive-dispatch-failure breaker does not park it — a hop resets the breaker window (the breaker guards *same-target re-fire loops*, which a monotonic chain never produces), and at most two attempts (1 + 1 retry) land on any target before movement. The breaker resumes normal duty once the chain is exhausted — its copy folded into the §6 escalation.
1. A failure surfaces at either seam: `dispatchStartShip`'s catch (sync; category `sdk-throw` today) or `pollOneStream`'s terminal-failure handling (async; category from `classifyFailure`). Attempt stamped, no slot held (existing behavior at both).
2. **Transient retry (§4.7) — checked first, independent of the category allowlist:** stream pre-work (per the step-3 work-products predicate), failure matches the transient allowlist, current target unretried → record `{retried}`, reset to pending on the *same* target, done (re-dispatch next tick). Otherwise continue. (First, so transient non-hop categories like `contention` still get their one same-target retry.)
3. Hop gate: category in the eligibility allowlist **AND** no work products (`(reviewCycles ?? 0) === 0` and no genuine PR, per §4.3 — no branch-push column exists; P1 initializes `reviewCycles` to `0`). Fails the gate → step 7.

   *Steps 4–5 are an in-memory walk: accumulate all skip records + cursor advancement, then apply one atomic `updateDriverStream` patch (step 5 for a viable target, step 7 for exhaustion). Do not write per-skip — a chain of N dead targets is one store write, not N+1.*
4. Walk `fallbackChain` from `fallbackCursor`: run the shared viability helper (§4.6) on each candidate — wired cell (defense in depth), per-cell env requirement, local worktree existence. Unviable → accumulate a `{skipped, reason}` record, advance the (in-memory) cursor, continue.
5. Viable target found → apply `FALLBACK_RESET_PATCH`. Enumerated columns: everything `PENDING_RESET_PATCH` clears (`dispatchModel`, `dispatchModelParams`, `dispatchProvider`, `effortDegraded`, `status` → pending, `tierDegradeReason`), plus `runtime`/`provider` rewritten to the target, `targetModelId` set to the entry's `model_id` (or null), **`workOnCurrentBranch` reset to `false`** (a previously cloud-flipped stream carries `true` from `FLIP_CLOUD_RESET_PATCH`; a local hop must not inherit it), `fallbackCursor` advanced past the target, hop record (with resolved from/to models) appended, breaker window reset.
6. Next tick dispatches the stream normally: `buildShipInput` branches on the *new* runtime, `mapTierToDispatch` remaps tiers for the *new* provider, `targetModelId` overrides the mapped model when present, `selectRunner` picks the runner. Nothing downstream knows a hop happened.
7. Gate failed / no viable target (empty, exhausted) → today's path verbatim: `failed`, `awaiting_judgment`, escalation per the §6 copy (hop/skip/retry history + remedies + bare-retry target).

### 7.3 What goes wrong
- **Hop target also fails** → same flow; cursor already advanced, so it retries once if transient (§4.7) then tries the next entry or exhausts. Termination is structural (finite chain, monotonic cursor, one retry per target).
- **Crash between patch and re-dispatch** → the stream is a pending row with rewritten target; resume dispatches it — identical to how a pending stream survives a crash today.
- **Operator retries an exhausted stream** (`decide retry`) → same target as its last hop (the current columns — stated in the escalation), cursor stays exhausted; a second failure escalates again — exactly one new escalation, no chain re-walk (§11 check d). Chains don't refill; a skipped-then-remedied target is reachable only via P3's `retry --target`.
- **Async failure races a work product** (agent pushed a branch moments before dying) → the gate reads the columns as recorded at classification time; any recorded work product blocks the hop. Worst case a just-pushed branch hasn't landed in the store yet and the stream hops — the same staleness window `flipStreamToCloud` already lives with; noted as residual risk, bounded by the poll interval.

## 8. Concurrency / consistency / failure model

- Hops happen inside the tick's failure handling for that stream — single-writer per stream, same as every other stream mutation; no new races. The poll-seam hook runs in the same single-writer context as today's failed-stream write.
- The failed attempt is terminal before the reset patch is applied; the re-dispatch is a fresh attempt row. At most one live attempt per stream, invariant preserved.
- Chain state is monotonic: cursor only advances, log only appends, each target gets ≤ 2 attempts (1 + 1 transient retry). Total dispatch attempts per stream ≤ 2 × (1 + chain length) — a structural bound, no counters needed. No path re-tries a consumed target automatically — including targets consumed by a *skip*: if the operator fixes the env after a credential skip, the chain does not rewind (accepted v1 limitation; the escalation remedy line + P3 `retry --target` are the recovery story).
- Ineligible category, work-carrying stream, exhausted chain, empty chain: all collapse to the existing `failed → awaiting_judgment` machinery. Fallback strictly *narrows* the set of seat interrupts; it never invents a new terminal state, and it never double-escalates (§6 breaker subsumption).

## 9. Rollout / implementation plan

| Phase | Goal | High-level tasks | Depends on | Gate | Scope |
| --- | --- | --- | --- | --- | --- |
| **P1 — chain schema** | Chain declared, validated, stored, visible | shared target type `(runtime, provider, model_id?)` (parsed + stored in the chain JSON) + manifest keys + inheritance; store columns `fallbackChain`/`fallbackCursor`/`fallbackLog`; import preflight (cell/rooms/dupe/local-branch/cloud-repo validation, env warnings); render overlay extension (current target + fallback/skip/retry line) | — | — | ~350–500 wLOC |
| **P2a — engine hop (core)** | Pre-work failure auto-hops end-to-end, both seams | eligibility table; no-work-products gate (`reviewCycles`-keyed); shared viability helper w/ per-cell env table (§4.4/§4.6); `FALLBACK_RESET_PATCH` (enumerated, §7.2, *minus* `targetModelId`); hooks at dispatch catch + poll terminal-failure path; #199 breaker interplay; §6 escalation copy; fake-runner e2e both seams. The chain-walk (length-N) is core; the two separable extras are deferred to P2b. | P1; `cloud-sdk-cause-persistence` (soft dep, §4.2) | **VALIDATION GATE** | ~350–450 wLOC |
| **P2b — hop extras** *(gated on the P2a gate)* | Transient-blip resilience + cross-provider model fidelity | transient retry (§4.7 — the known-transient-shape allowlist); model_id dispatch honoring (`targetModelId` column + read after `tierDispatchPatch`, §4.1) + hop-record from/to models — **coordinate with #202**, which needs the same model plumbing | P2a gate | gated | ~150–250 wLOC |
| P3 — decide target override *(post-gate stub)* | `decide retry` accepts an explicit target for judged failures + skipped-target recovery | new decide option + reset patch variant; supersedes `flipStreamToCloud`'s one-off shape | P2a | gated | stub |
| P4 — mid-run fallback *(post-gate stub, maybe never)* | Env-category failures on work-carrying streams auto-hop | requires partial-work semantics (branch reuse, PR state) — §10 Q3 | P3 | gated | stub |

**Why P2a/P2b split:** the chain-walk itself is a cheap cursor loop, so the core hop mechanism (both seams, gate, viability, reset patch, breaker) is what must ship together and is what the validation gate proves. The transient retry and the `model_id` dispatch plumbing are genuinely separable weight — the latter mostly serves the sibling #202 — so they ride behind the gate as P2b. This keeps the first implementation PR reviewable (~400 wLOC) rather than a ~700-wLOC state-machine change churning through review cycles. (Implementation gets its own review rounds; a small first PR makes those cheap.)

**The gate (after P2a), reproducible forcing condition:** a real run whose primary is a cloud target configured with a deliberately invalid provider credential — which per §4.3 surfaces **async at the poll seam** (`runShipStart` returns before the failure) — chain ending in `(local, claude)` → the stream completes on local-claude with zero `decide` interactions, correct provenance columns (runtime/provider; model attribution arrives with P2b), and a legible hop record in `driver status`. Binary: it either lands unattended or it doesn't. A second, sync-seam check rides along in the fake-runner e2e (forced synchronous throw). P2b and P3/P4 are speculative until the gate proves out.

## 10. Open questions

1. ~~Should `/work-driver` stamp a default chain?~~ **Resolved-recommend (cycle 2): yes** — prep stamps `default_fallback: [local/claude]` whenever the primary is cloud (one entry, the $0 floor). Engine stays opt-in; final say is the operator's at the skill layer. (§4.5)
2. ~~Is `contention` correctly in the eligibility set?~~ **Resolved (cycle 1, reaffirmed cycle 2): out of v1** — transient by nature; the §4.7 retry + P3 `retry --target` cover it without burning chain slots.
3. **Mid-run fallback semantics** (P4): what does a hop mean when the failed attempt pushed commits or opened a PR? Three options: adopt-and-continue on the new target, fresh-branch restart, or pause-and-ask (today's behavior — the do-nothing default). Unresolved; deliberately out of v1, and now *enforced* by the §4.3 gate rather than by hook placement.
4. **Sync-side category fidelity:** the dispatch catch stamps `sdk-throw` unconditionally. The `cloud-sdk-cause-persistence` task is the vehicle for structured causes; P2 takes it as a soft dependency and the §4.2 table inherits fidelity as it lands. Async-side fidelity already exists via `classifyFailure`.
5. **Splitting `budget-exceeded`:** the literal covers both provider-credit exhaustion (hop-worthy) and task-budget exhaustion (`error_max_turns`, `retries_exhausted` — hop re-runs a too-big task and doubles spend). Options: a new tombstone literal for billing/credit failures, or a discriminator on the failure detail. Until split, `budget-exceeded` escalates.
6. ~~Retryability signal fidelity~~ **Resolved (cycle 3, verified against code): there is no retryable signal to key on.** `isRetryable` appears nowhere in `packages/` — ship never carried the SDK's flag into the driver. So §4.7's v1 sensor *is* the known-transient-error-shape allowlist (connect-timeout / transient-network / rate-limit class, classifiable from the error in hand), not a flag. Promoting to a first-class retryable signal is a future enhancement gated on ship persisting one; the P2 task notes it. No open question remains — only the allowlist's exact membership, which is a P2 implementation detail reviewable in that PR.

## 11. Validation plan

The §9 gate is the signal: **one real forced-failure run (invalid cloud credential, async seam) that lands unattended on the fallback target.** A sync-seam companion rides along in the fake-runner e2e — the fake runner must be able to force a *synchronous* `dispatchStartShip` throw (distinct code path from the async terminal failure, identical gate) so both seams are exercised. Secondary checks, all binary and baseline-free: (a) a no-chain manifest produces a byte-identical stream lifecycle vs main at *both* seams (regression harness with fake runners); (b) chain exhaustion produces exactly one escalation — hop/skip/retry history, remedies, bare-retry target named, no separate #199 breaker escalation, and the derived `failed:` line correct; (c) `/provenance` on the gated run reports the fallback target and resolved model, not the primary; (d) `decide retry` after exhaustion produces exactly one new escalation on failure — no chain re-walk, no duplicates; (e) a work-carrying stream (a fixture with `reviewCycles > 0`) with an eligible failure category does **not** hop — tested at **both** seams, and the poll-seam case specifically (an async failure on a work-carrying stream) since that is exactly the v2 scoping bug this gate guards against.
