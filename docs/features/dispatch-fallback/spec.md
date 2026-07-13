# Dispatch fallback chain — Technical Design Document

**Status:** draft / proposal — NOT a build commitment. The artifact we decide from.
**Owner:** @itsHabib
**Date:** 2026-07-13 (v2 — review cycle 1 folded: dispatch-time category fidelity, local-target viability, budget-exceeded split, render overlay, shared target type with the model-lottery design)
**Related:** `docs/features/agent-runner-abstraction/` (the provider×runtime matrix this walks), `docs/features/driver-provider-passthrough/` (per-stream provider), `docs/features/gateway-auth-carrier/` (local-claude auth legibility), `docs/features/model-lottery/KICKOFF.md` (sibling design; shares the dispatch-target type, §4.1), dossier project `ship`.

> **Reviewers — focus areas:** §4.2 (which failure categories auto-fall-back vs escalate, and *when each can actually fire* — this is the risk surface), §4.4 (credential/worktree preconditions stay outside ship), §7.2 (the hop flow and its interaction with the parallelism ledger), §8 (loop guard / exhaustion semantics).

## 1. Problem & hypothesis

A driver stream is bound to one `(runtime, provider)` pair for its whole life. When dispatch fails — a flaky cloud provider, an exhausted credit pool, a gateway auth rejection — the engine parks the stream at `failed`, stamps the run `awaiting_judgment`, and waits for a seat to type `ship driver decide retry`. That retry re-dispatches the **same** pair (`PENDING_RESET_PATCH` deliberately leaves `runtime`/`provider` untouched), so a dead provider produces a seat-interrupt loop for what is fundamentally a routing decision.

The operator already routes around this by hand: cursor-cloud got demoted as default because it flakes; local-claude (runtime `local`, provider `claude`) is $0 on the subscription and is the preferred floor. The engine should encode that routing: **each stream carries an ordered chain of fallback dispatch targets, and a dispatch failure with an environmental cause advances to the next target instead of interrupting the seat.**

Hypothesis: for dispatch-time failures with environmental categories, an auto-hop resolves the majority without judgment, and the run completes on a cheaper/steadier target with full provenance intact.

**Non-goals:**
- No credential loading in ship. The local-claude token precondition is the launcher's job (see §4.4); ship stays a pure env pass-through (`buildGatewayEnv`).
- No budget *tracking*. Ship reacts to failure categories; it does not meter spend or enforce ceilings. A spend-aware policy is a different feature. (And `budget-exceeded` is *not* fallback-eligible in v1 — see §4.2.)
- No mid-run migration in v1. A stream that fails *after* work has started (partial commits, an open PR) does not auto-hop — that path keeps going to judgment (§10 Q3).
- No `rooms` targets. The engine already refuses `rooms` streams (`collectStreamPreflightErrors`); chains reject them the same way.

## 2. Functional & non-functional requirements

**FR**
1. A manifest stream may declare an ordered list of fallback dispatch targets; a run may declare a default chain inherited by streams that don't.
2. On a dispatch failure whose classified category is fallback-eligible, the engine rewrites the stream to the next viable target and re-dispatches — no seat interaction.
3. Non-eligible categories, and chain exhaustion, behave exactly as today: `failed` → `awaiting_judgment` with an escalation — enriched with the full hop/skip history and, for credential skips, the concrete remedy (§6 escalation copy).
4. Every hop **and every skipped target** is recorded on the stream and rendered first-class in `driver status` and the rendered manifest — same treatment as `tierDegradeReason`, never buried in a raw log column.
5. Chains are validated at import: unknown/illegal targets (per the `selectRunner` matrix), `rooms`, dupes, and **local targets on streams that can't satisfy local preconditions (no `branch_name`)** fail the import loudly, not at hop time.
6. Streams with no chain behave byte-for-byte as today. The feature is opt-in.

**NFR**

| Dimension | Target |
| --- | --- |
| Safety | A hop can never dispatch the same work twice concurrently: the failed attempt holds no parallelism slot and is terminal before the re-dispatch is written. |
| Determinism | Chain consumption is strictly left-to-right, each target tried at most once per stream lifecycle. No retry loops within a target (that stays `decide retry`'s job). |
| Provenance | The stream's final `runtime`/`provider` columns reflect the target that did the work — `/provenance` derives from `driver_streams`, so it must be correct with no extra work. (The *rendered manifest* is not free — §5 render note.) |
| Legibility | Every hop and every skipped target leaves a recorded reason with first-class rendering, mirroring `tierDegradeReason`. Silent rerouting is a bug. |
| Compat | Store schema change is additive; existing driver DBs open unchanged. Manifest without the new keys parses unchanged. |

## 3. Architecture overview

Two orthogonal enums already exist: `runtime` (`local | cloud | rooms` — `driverRuntimeSchema`, `packages/store/src/driver-schemas.ts`) and `provider` (`cursor | claude | codex` — `agentProviderSchema`, `packages/workflow/src/workflow.ts`). A **dispatch target** is `(runtime, provider, model_id?)` — a wired cell of the `selectRunner` matrix (`packages/core/src/service.ts`) plus an optional concrete model override (§4.1). The chain is a list of targets. The target type is shared with the model-lottery design; whichever feature lands second adopts it verbatim.

```
manifest: runtime/provider (+ fallback: [target, ...])
              │ import (validate targets: wired cell, no rooms, no dupes,
              │         local targets require branch_name)
              ▼
driver_streams: runtime, provider, fallback_chain, fallback_cursor, fallback_log
              │ tick → dispatchStream → dispatchStartShip
              ▼
        startShip throws ──► failure category (v1: `sdk-throw`, stamped by the
              │              dispatch path; structured categories are §10 Q4)
              │                    │
              │        eligible + next viable target?
              │            yes ──► FALLBACK_RESET_PATCH (rewrite runtime/provider,
              │                    advance cursor, log hop) → re-dispatch next tick
              │            no  ──► failed → awaiting_judgment   (today's path,
              │                    escalation enriched with hop/skip history)
```

**Reused, not built:** the runtime-rewrite mechanism (`flipStreamToCloud` / `FLIP_CLOUD_RESET_PATCH` proves the store+engine can rewrite a stream's target mid-life and re-dispatch cleanly — this generalizes it); the failure taxonomy (`failureCategorySchema` already carries `gateway-unreachable`, `gateway-auth`, `budget-exceeded`, `sdk-throw` as persisted-forever literals — "tombstone" in that file means *never rename/delete*, not *inactive*); per-dispatch tier remapping (`buildShipInput` recomputes `mapTierToDispatch` per attempt — "must not inherit a previous attempt's mapping or degrade flags" — so a hop to a new provider gets correct model/effort mapping for free).

**Net-new:** the chain fields (manifest + store), the eligibility policy table, the hop transition in `dispatchStartShip`'s failure path, the viability check (wired matrix cell + env/worktree preconditions — designed as a shared helper, §4.6), and a render-overlay extension (rendered manifests overlay progress fields only today; they must learn to reflect the current target and the fallback line — §5).

## 4. Key decisions & trade-offs

### 4.1 Chain elements are `(runtime, provider, model_id?)` targets, not runtimes
"Fall back to local" is ambiguous — local-what? The matrix has six wired cells and they differ in cost, steadiness, and auth needs. A pair-chain expresses the real policy (`cloud/cursor → cloud/claude → local/claude`) with no new vocabulary: both enums exist, `selectRunner` already rejects illegal combinations.

The optional `model_id` completes the target type: a hop across providers needs a model answer anyway (a model on one provider may have no analog on another — the `tier-map` degrade rules are the precedent), and the sibling model-lottery design needs the same triple for its pool members plus a `model_id` manifest passthrough. Semantics: entry specifies `model_id` → it wins; entry omits it → the stream's tiers remap through `mapTierToDispatch` for the new provider (existing behavior). **One target type, two features** — this TDD lands the type; the lottery adopts it verbatim.

**Alternative rejected:** a single `fallback_runtime` scalar (the `flipStreamToCloud` shape) — can't express the two-hop cost story that motivates this.

### 4.2 Failure-category policy: static allowlist, dispatch-time only — with honest fire-ability
A seam fact first (review catch, cycle 1): `dispatchStartShip`'s catch path stamps **`sdk-throw` for every dispatch-time throw and never calls `classifyFailure`**. The richer categories (`gateway-unreachable`, `gateway-auth`, `budget-exceeded`, `contention`) are produced by the poll-time path via `classifyFailure` (`packages/agent-runner/src/classify-failure.ts`). Since v1 hooks dispatch time only (§4.3), the table below distinguishes what *can fire* in v1 from what is *pre-approved* for when the dispatch path learns to surface structured categories (§10 Q4).

| Category | Fallback-eligible? | Fires at dispatch time in v1? |
| --- | --- | --- |
| `sdk-throw` | **yes** | **yes — the only live trigger in v1** |
| `gateway-unreachable` | yes (pre-approved) | no — activates with §10 Q4 |
| `gateway-auth` | yes (pre-approved) | no — activates with §10 Q4 |
| `budget-exceeded` | **no — needs a split first** (§10 Q5) | n/a |
| `contention` | **no** (v1) | n/a — poll-time input (`isStoreContention`) |
| `logic`, `patch-apply-fail`, `timeout-near-cap`, `agent-collapse-on-running-tool`, `sandbox-denial`, `unknown` | no — escalate as today | — |

Rationale for the two exclusions (both review findings, adopted):
- **`budget-exceeded` conflates two things:** provider-credit exhaustion (environmental — hop is right) and run/task budget limits (`error_max_turns`, cloud `retries_exhausted` map into the same literal — the *work* is too big, and hopping re-runs a likely-too-large task on another target, doubling spend and masking a spec problem). Out until the category is split or discriminated (§10 Q5).
- **`contention` is transient by nature** — it can clear on the next tick, and the monotonic cursor means a contention hop *permanently burns* a chain slot for a wait-shaped problem. Its real use case (local contention → go cloud) is P3's `decide retry --target`. Out of v1.

`unknown` escalating is the conservative choice: fallback must never mask a novel failure mode. `timeout-near-cap` stays out: it fires post-run, and a different provider doesn't make the task smaller.

The table is a constant in `packages/driver` (policy), not config (mechanism stays dumb). **Alternative rejected:** per-category chain config in the manifest — YAGNI, and it turns a routing table into a programming language.

### 4.3 v1 scope: the `dispatchStartShip` catch path only
The hook is the existing failure branch in `dispatchStartShip` (`packages/driver/src/engine.ts`): the attempt is already stamped, the slot already released, the stream about to be marked `failed`. Interposing there means the hop inherits every invariant the failed-dispatch path already maintains. Failures *after* a successful dispatch (mid-run) keep today's judgment path — a mid-run hop has to reason about partial work, branch reuse, and half-open PRs, none of which dispatch-time has (§10 Q3).

### 4.4 Local-target preconditions stay outside ship; skips are loud and actionable
A hop to `(local, claude)` needs three things ship doesn't own: the auth env (`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` in the ambient env — ship reads no `credentials.json`; the neutral-gateway boundary, `buildGatewayEnv` / `validateRunInput` in `packages/claude-runner/src/local-runner.ts`), a `branch_name` on the stream, and the `.claude/worktrees/<branch>` checkout (`buildLocalShipInput` requires the branch; local preflight requires the worktree). The design splits these by *when they're knowable*:

- **Import time (structural — reject):** a chain containing a `(local, *)` target on a stream with no `branch_name` is an authoring error — the fallback route could never work. Reject the import (review catch, cycle 1: without this, the flagship cloud→local route dies as an engine precondition failure *outside* the fallback path instead of a recorded skip).
- **Hop time (environmental — skip loudly):** env token absent, or worktree missing → the target is skipped with a recorded reason and the chain advances. Skips get the same first-class render treatment as `tierDegradeReason` — `driver status` shows `skipped (local, claude): ANTHROPIC_API_KEY not set` without drilling into raw columns — and the exhaustion escalation names every skipped target **with its remedy** (§6), because a skipped credential is invisible-by-default and `decide retry` won't re-walk the chain to recover it (§8; accepted v1 limitation).
- Import-time env preflight *warns* (recorded on the run) but does not fail — the env at import and at hop time are the same process env today, but warning-not-failing keeps the check honest about what it can actually promise.

**Alternative rejected:** ship loading the token itself — convenient, and wrong; it crosses a boundary the gateway-auth-carrier work deliberately drew.

### 4.5 Opt-in, no engine default chain
An unset chain means today's behavior, byte-for-byte. The *policy* of "cloud runs should fall back to local-claude" belongs to the layer that writes manifests (`/work-driver` prep), not baked into the engine — same split as tier policy (seat picks tiers, `tier-map` maps them). Whether `/work-driver` should stamp a default chain into every manifest it generates is an operator policy call (§10 Q1).

### 4.6 The viability check is one shared mechanism, used at two moments
"Is this target dispatchable right now, and if not, record why and move on" is the same question for a fallback hop (this TDD) and for the model-lottery's assign-time preflight (drop a dead pool member with a note, continue). Design it once in `packages/driver` — input: a target + a stream; output: viable, or a structured skip reason — invoke it at both call sites. Prevents the two features growing divergent notions of "dead target."

## 5. Data model

**Manifest** (`packages/driver/src/manifest.ts`):
- Per-stream `fallback`: array of `{ runtime, provider, model_id? }`, default `[]`.
- Run-level `default_fallback`: same shape; streams without an explicit `fallback` inherit it. Mirrors the existing `default_runtime` / `default_provider` precedent.
- (`model_id` on chain entries is the same manifest passthrough the model-lottery needs for primary assignment; P1 lands the field once.)

**Store** (`packages/store/src/driver-schemas.ts`, additive columns on `driver_streams`):
- `fallbackChain` — JSON array of targets, frozen at import (resolution of manifest + run default).
- `fallbackCursor` — integer, next chain index to try; starts 0.
- `fallbackLog` — JSON array of hop/skip records: `{ from: target, to: target, category, at }` or `{ skipped: target, reason, at }`. Append-only, the `tierDegradeReason` analog.

The stream's existing `runtime` / `provider` columns remain the single source of truth for *current* target — hops rewrite them (the `flipStreamToCloud` precedent), which keeps `driver status` and `/provenance` correct with zero changes.

**Render note (review catch, cycle 1):** the rendered manifest is *not* correct for free — `renderDriverRun` parses stored `sourceJson` and `overlayStreamProgress` overlays progress fields only (status/PR/merge/cycles), not `runtime`/`provider`. P1 extends the overlay to reflect the stream's current target plus the fallback/skip line. Without this, a hopped stream renders as its original target — silent rerouting, which §2 NFR-Legibility forbids.

Failure-category literals: no additions needed — v1's eligibility set uses existing tombstoned literals (§10 Q5 may add a billing-specific one later).

## 6. API contract

- **Manifest keys** as in §5; import validation extends `collectStreamPreflightErrors`: every chain target must be a wired `selectRunner` cell, must not be `rooms`, must not equal the stream's primary target or an earlier chain entry (dupes are certainly authoring errors), and a `(local, *)` target requires the stream to carry `branch_name`.
- **No new CLI/MCP verbs.** `driver status` and the rendered manifest gain a fallback line per affected stream — hops (`fallback: cloud/cursor → local/claude on sdk-throw`) *and* skips (`skipped (local, claude): ANTHROPIC_API_KEY not set`), same rendering seam as `degrade=` in `status-mapping.ts`.
- **`decide` verbs unchanged in v1.** `retry` keeps meaning "same target again" — its reset patch untouched. (A `retry --target` override is the natural v2, §9 P3.)
- **Escalation copy on chain exhaustion — specified now, not deferred:** subject `dispatch failed after fallback: <stream> exhausted <n>-target chain`; body lists, in order: the primary target + its category, then each chain entry with its outcome — `hopped on <category>` / `failed: <category>` / `skipped: <reason> — remedy: <e.g. "set ANTHROPIC_API_KEY and decide retry">`. The escalation shape (`buildFailureTriageRequests`) is otherwise unchanged. A no-chain stream's escalation is byte-identical to today's.
- **Error model:** import rejects invalid chains with per-stream structured errors (same channel as existing preflight errors). Hop-time skips are not errors — recorded reasons in `fallbackLog`, rendered per above.

## 7. Key flows

### 7.1 Import
1. Parse manifest; resolve each stream's effective chain (`fallback` ?? `default_fallback` ?? `[]`).
2. Validate every target (wired cell, no `rooms`, no dupes vs primary/earlier entries, `(local, *)` requires `branch_name`) → structured import failure on violation.
3. If any chain contains `(local, claude)` and neither `ANTHROPIC_AUTH_TOKEN` nor `ANTHROPIC_API_KEY` is present in env: record a run-level warning (visible in status), proceed.
4. Freeze chain onto the stream row, cursor 0, empty log.

### 7.2 Dispatch failure → hop
1. `dispatchStartShip` catches the throw from `ship.startShip`; attempt stamped, no slot held (all existing behavior). The failure category is `sdk-throw` (v1; structured categories §10 Q4).
2. Category in the eligibility allowlist? No → step 6.
3. Walk `fallbackChain` from `fallbackCursor`: run the shared viability check (§4.6) on each candidate — wired cell (defense in depth; import already guaranteed it), and for `(local, *)` targets the env token and worktree preconditions. Unviable → append `{skipped, reason}` record, advance cursor, continue.
4. Viable target found → apply `FALLBACK_RESET_PATCH`. Enumerated columns (not just "superset"): everything `PENDING_RESET_PATCH` clears (`dispatchModel`, `dispatchModelParams`, `dispatchProvider`, `effortDegraded`, `status` → pending, `tierDegradeReason`), plus `runtime` and `provider` rewritten to the target, **`workOnCurrentBranch` reset to `false`** (a previously cloud-flipped stream carries `true` from `FLIP_CLOUD_RESET_PATCH`; a local hop must not inherit it), `fallbackCursor` advanced past the target, hop record appended. If the entry carries `model_id`, it is stamped as the dispatch model; otherwise tiers remap for the new provider.
5. Next tick dispatches the stream normally: `buildShipInput` branches on the *new* runtime, `mapTierToDispatch` remaps tiers for the *new* provider, `selectRunner` picks the runner. Nothing downstream knows a hop happened.
6. No viable target (empty, exhausted, or ineligible category) → today's path verbatim: `failed`, `awaiting_judgment`, escalation per the §6 copy (hop/skip history + remedies).

### 7.3 What goes wrong
- **Hop target also fails** → same flow; cursor already advanced, so it tries the next entry or exhausts. Termination is structural (finite chain, monotonic cursor).
- **Crash between patch and re-dispatch** → the stream is a pending row with rewritten target; resume dispatches it — identical to how a pending stream survives a crash today.
- **Operator retries an exhausted stream** (`decide retry`) → same target as its last hop (the current columns), cursor stays exhausted; a second failure escalates again — exactly one new escalation, no chain re-walk (§11 check d). Chains don't refill; a skipped-then-remedied target is reachable only via P3's `retry --target`.

## 8. Concurrency / consistency / failure model

- Hops happen inside the tick's failure handling for that stream — single-writer per stream, same as every other stream mutation; no new races.
- The failed attempt is terminal before the reset patch is applied; the re-dispatch is a fresh attempt row. At most one live attempt per stream, invariant preserved.
- Chain state is monotonic: cursor only advances, log only appends. There is no path that re-tries a consumed target automatically — including targets consumed by a *skip*: if the operator fixes the env after a credential skip, the chain does not rewind (accepted v1 limitation; the escalation remedy line + P3 `retry --target` are the recovery story).
- Ineligible category, exhausted chain, empty chain: all collapse to the existing `failed → awaiting_judgment` machinery. Fallback strictly *narrows* the set of seat interrupts; it never invents a new terminal state.

## 9. Rollout / implementation plan

| Phase | Goal | High-level tasks | Depends on | Gate | Scope |
| --- | --- | --- | --- | --- | --- |
| **P1 — chain schema** | Chain declared, validated, stored, visible | shared target type `(runtime, provider, model_id?)` + manifest keys + inheritance; store columns; import preflight (cell/rooms/dupe/local-branch validation, env warning); render overlay extension (current target + fallback/skip line) | — | — | ~300–450 wLOC |
| **P2 — engine hop** | Dispatch failure auto-hops end-to-end | eligibility table (v1: `sdk-throw` live); shared viability helper (§4.6); `FALLBACK_RESET_PATCH` (enumerated columns, §7.2); hook in `dispatchStartShip` failure path; §6 exhaustion escalation copy; fake-runner e2e (forced dispatch fail → completes on next target) | P1 | **VALIDATION GATE** | ~350–550 wLOC |
| P3 — decide target override *(post-gate stub)* | `decide retry` accepts an explicit target for judged failures + skipped-target recovery | new decide option + reset patch variant; supersedes `flipStreamToCloud`'s one-off shape | P2 | gated | stub |
| P4 — mid-run fallback *(post-gate stub, maybe never)* | Env-category failures after dispatch auto-hop | requires partial-work semantics (branch reuse, PR state) — see §10 Q3 | P3 | gated | stub |

**The gate (after P2), with a reproducible forcing condition:** a real run whose primary is a cloud target configured with a deliberately invalid provider credential (guaranteed dispatch-time throw → `sdk-throw`), chain ending in `(local, claude)` → the stream completes on local-claude with zero `decide` interactions, correct provenance columns, and a legible hop record in `driver status`. Binary: it either lands unattended or it doesn't. Phases P3/P4 are speculative until this proves out.

## 10. Open questions

1. **Should `/work-driver` stamp a default chain into generated manifests** (e.g. `default_fallback: [cloud/claude, local/claude]` whenever the primary is cloud)? Engine stays opt-in either way; this is seat-layer policy and the operator's call. (This was the original prompt for the feature — "stamp CLAUDE.md with fallbacks" — resolved here as: the *manifest* is where that policy lands, not repo markdown.)
2. ~~Is `contention` correctly in the eligibility set?~~ **Resolved (cycle 1): out of v1** — poll-time-only input, transient by nature, and a hop permanently burns a chain slot for a wait-shaped problem. P3's `retry --target` covers the real use case.
3. **Mid-run fallback semantics** (P4): what does a hop mean when the failed attempt pushed commits or opened a PR? Three options, not two: adopt-and-continue on the new target, fresh-branch restart, or **pause-and-ask (today's behavior — the do-nothing default)**. Unresolved; deliberately out of v1.
4. **Dispatch-time category fidelity:** dispatch throws stamp `sdk-throw` unconditionally (`dispatchStartShip` never calls `classifyFailure`), which makes `sdk-throw` v1's only live trigger. Teaching the dispatch path to surface structured `gateway-auth` / `gateway-unreachable` from runner errors activates two pre-approved rows in §4.2 — worth doing in P2 if cheap, else first post-gate work.
5. **Splitting `budget-exceeded`** (new, cycle 1): the literal covers both provider-credit exhaustion (hop-worthy) and task-budget exhaustion (`error_max_turns`, `retries_exhausted` — hop re-runs a too-big task and doubles spend). Options: a new tombstone literal for billing/credit failures, or a discriminator field on the failure detail. Until split, `budget-exceeded` escalates.

## 11. Validation plan

The §9 gate is the signal: **one real forced-failure run (invalid cloud credential) that lands unattended on the fallback target.** Secondary checks, all binary and baseline-free: (a) a no-chain manifest produces a byte-identical stream lifecycle vs main (regression harness with fake runners); (b) chain exhaustion produces exactly one escalation whose body names every hop and skip with remedies (§6 copy); (c) `/provenance` on the gated run reports the fallback target, not the primary; (d) `decide retry` after exhaustion produces exactly one new escalation on failure — no chain re-walk, no duplicate escalations.
