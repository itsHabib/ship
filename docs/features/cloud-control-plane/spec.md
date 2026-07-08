# Cloud control plane — Technical Design Document

**Status:** draft / proposal — NOT a build commitment. The artifact we decide from.
**Owner:** @michael
**Date:** 2026-07-02
**Related:** dossier project `ship` (phases `ccp-*`); dossier tasks referenced by slug throughout; the workbench vision + agentic-infra synthesis 2026-06-30 (operator-local corpus, outside this repo). Per-task specs land at `docs/features/<phase>/…` per the repo's phase-doc convention when each task dispatches.

> **Reviewers — focus areas:** (1) §4 D5 — seat-local store, no shared control-plane database; (2) §4 D3 + §6 — the escalation split (engine writes the durable row, seat/skill owns channel policy) and the payload schema; (3) §4 D4 — grant lifecycle staying CLI-local as the authority boundary; (4) §9 — are the ladder gates falsifiable, and is the phase→parked-work mapping honest?

## 1. Problem & hypothesis

The driver engine can fire a batch and land a clean run: import → dispatch → poll → judgment → land is durable state with verified writes (`land` reads the merge back from GitHub before recording), runs survive host suspends and clock jumps (monotonic re-validation + the remote-liveness age floor), each stream dispatches with its own provider/model/effort, and every run leaves a trace that tracelens can turn into a post-run verdict. That is the execution plane, and it is in good shape.

The **control plane** — the thing that exercises judgment over that execution — is still the operator's terminal. Review-cycle triage, the consolidation of reviewer findings, the merge call (`--admin` per PR because branch protection wants approvals bots don't give), and every "is this stuck?" check run inside an attended Claude session, and escalation means the operator noticing. The composition that forms the control plane already exists locally — **dossier** (desired state) + **driver engine** (execution) + **tracelens** (verdicts) + **skills** (policy) — but its judgment half is pinned to an attended seat, and its escalation half is "the operator is watching."

**Hypothesis:** no new product is needed. The end state — Claude-managed agents in the cloud ARE the ship driver, and the operator is an escalation target (phone/Slack), not a terminal operator — is reachable by moving three responsibilities out of the attended terminal:

1. **Judgment** becomes portable: it runs in a *driver seat* — any Claude session holding the ship surface — regardless of where that session runs.
2. **Merge authority** becomes engine-enforced: a repo-scoped grant × a deterministic verdict × mechanical readiness, none of which the seat can mint for itself.
3. **Escalation** becomes push-first and durable: a structured escalation row the engine guarantees, delivered outward to the operator's channel instead of discovered by pulling status.

Most of the distance is already-parked engine work getting sequenced — the same re-home-prose-into-engine-verbs pattern that shipped `land`. The genuinely new pieces are small: escalation rows + a notify hook, blast-radius caps on the grant, and a recording-relay for seats that can't reach the dossier corpus.

**Non-goals.** This is not a fleet-management product (one operator, N agents; OUR reviewers, OUR merge policy, OUR channels — opinions are the value). No new sibling repos and no new MCP servers. No shared cloud database or resident daemon. No moving dossier, the corpus, or the operator's secrets anywhere. No "provision cloud infra" phase — every phase ships as ordinary local PRs on this repo, and the attended local flow stays byte-identical when the new config is absent.

## 2. Requirements

**Functional**

1. A driver run proceeds dispatch → poll → judgment → review-fix → merge → record with zero operator interaction on the green path, once the repo's merge grant is active AND the seat's token carries merge capability (L2 locally, L4 in the cloud — §9; L3 deliberately queues merges for the operator).
2. Every non-green transition produces a durable, structured escalation; page-class events reach the operator's channel without being polled for.
3. Judgment runs in a substrate-agnostic seat: the operator's terminal, an unattended local overnight session, or a cloud session/scheduled routine — same skills, same engine verbs, no code fork per substrate.
4. Merge authority is engine-enforced and seat-independent: no seat, however confused or prompted, can widen its own authority.
5. Every autonomous action is auditable after the fact: which verdict + grant authorized a merge, which decision resolved a park, what tracelens said about the run.
6. Autonomy expands only by climbing the trust ladder (§9); each rung has a falsifiable track-record gate and a one-step rollback.

**Non-functional**

| Dimension | Target |
|---|---|
| Escalation delivery | Row written before any notify attempt (the row is the guarantee); page-tier push attempted within one engine tick of the transition; at-least-once per transition while the seat lives; a seat that dies between row and delivery is caught by the digest's external-truth sweep (§7 Flow D) — nothing stays silent past the next digest |
| Durability | Escalation, audit, and satisfaction rows are verified writes in the driver store; engine never advances state on uncertainty — parking is design, not failure |
| Blast radius | Grant is repo-scoped; auto-merge capped per run; per-run spend ceiling; sensitive paths always require a human; revocation is immediate and local |
| Auditability | Every `--admin` merge names its authorizing verdict + grant in a per-PR audit row; every park names its class + evidence |
| Security | Seats hold operator-issued scoped tokens whose capability is graded by ladder rung (merge-capable only where the rung earns it); grant mutation is local-CLI-only, interactive-only (TTY + typed confirmation), and pages on every change; the gate never merges changes to the gate |
| Cost | Unattended run bounded by an explicit spend ceiling; a scheduled seat costs ~nothing while idle |
| Compatibility | With no grant and no notify config, behavior is byte-identical to today's attended flow |

## 3. Architecture overview

The control plane is a composition of five existing layers plus one named role:

```
     desired state              judgment (policy)                execution                verdicts
  ┌────────────┐   prep    ┌─────────────────────┐  verbs   ┌────────────────┐  traces ┌───────────┐
  │  dossier   │ ────────▶ │     driver seat      │ ───────▶ │  ship driver   │ ──────▶ │ tracelens │
  │ (corpus,   │ manifests │  a Claude session:   │ CLI/MCP  │  engine        │         │ (verdict  │
  │  local)    │ ◀──────── │  /work-driver +      │ ◀─────── │  seat-local    │ ◀────── │  JSON)    │
  └────────────┘ recording │  /review-coordinator │  JSON    │  store, grants │ verdict └───────────┘
                           └──────────┬───────────┘          │  caps, audit   │  gates
                                      │ escalation           └───────┬────────┘
                                      ▼ (page / queue)               │ escalation rows (durable)
                           ┌──────────────────────┐                  │
                           │       operator       │ ◀────────────────┘
                           │  phone / Slack; grants + policy only at the local CLI │
                           └──────────────────────┘
```

- **dossier** owns what should happen (projects/phases/tasks) and what happened (artifacts). Markdown-on-disk on the operator's machine; it is not a runtime dependency of anything (skills compose, MCPs don't).
- **ship driver engine** owns execution and every deterministic decision: readiness, verdict assembly, grant enforcement, caps, audit, escalation rows. It is the substrate-agnostic spine.
- **tracelens** owns post-run verdicts (healthy/degraded/pathological per stream) derived from run traces; the per-event timestamps, tool outcomes, and usage now captured in traces feed its retry/cost detectors.
- **skills** own policy prose: `/work-driver` (the ~137-line policy wrapper over the engine), `/review-coordinator` (the judge over the four reviewers), `/work-driver-prep` (intake), `/shipped` (digest + recording).
- **driver seat** — a name, not new software: any Claude session that satisfies the seat contract (§6). Judgment lives here. Today the seat is the operator's terminal; the whole design question is making the seat swappable.
- **operator** — the escalation target and the authority root. Grants, policy edits, and ladder promotions happen only here.

**What is new vs reused.** Reused: the entire engine spine, the runner matrix (provider × runtime), the store, tracelens, the skills. New mechanisms: escalation rows + notify hook, grant modes + caps, `markReady`, the `address` verb, MCP verb parity, a recording relay. Every one of these except the escalation rows and the relay is an already-ranked, already-specced parked item (§9 maps them).

**The seam to name:** the seat × substrate matrix mirrors the provider × runtime runner matrix. The engine doesn't know or care which substrate the seat runs on, exactly as it doesn't care which provider a stream dispatches to. A substrate qualifies by satisfying the seat contract, not by being coded for.

**What stays local forever:**

- **Authority**: grant registration/activation/revocation, policy edits (cycle caps, ceilings, sensitive-path list), ladder promotion. These are operator actions at the operator's CLI.
- **Secrets custody**: the operator's own credentials. Seats receive scoped tokens; a seat never holds the keys that could widen its own authority.
- **The dossier corpus**: markdown-on-disk is the source of truth and it lives with the operator. Non-local seats relay recording intents (§7 Flow E) rather than gaining a write path.
- **The operator's channels**: phone/Slack endpoints are configured locally and reached outward.

## 4. Key decisions & trade-offs

**D1 — Judgment runs in a seat, not a service.** *Alternative:* a resident driver daemon/orchestrator that owns the loop and calls a model API for judgment. *Rejected:* it rebuilds an orchestrator next to the engine, moves policy out of skills into service config, adds a resident failure domain no one is watching, and violates local-first. A Claude session already runs `/work-driver`; it IS the judgment runtime. Substrates change (terminal → overnight session → cloud session/scheduled routine); the seat contract doesn't. The engine stays a CLI/MCP the seat invokes — ticks are seat-driven, so a dead seat pauses work rather than corrupting it (Flow D).

**D2 — Deterministic sub-judgments keep migrating into engine verbs.** The proven pattern (the `land` verb; the `MergeVerdict` assembler): draft→ready flips become `markReady` on `DriverGhPort` (C2), review-fix re-dispatch becomes `driver address` (C10, mechanism only), merge authorization becomes grant × verdict (C14). What stays LLM judgment in the seat: triage kind selection on failures, findings consolidation, and escalate-vs-proceed under uncertainty. The audit's core finding was that the headless loop depended on agent diligence rather than engine guarantees — every migration here converts a diligence into a guarantee.

**D3 — Escalation splits into engine mechanism + seat policy.** *Engine (mechanism):* on the transitions that park or end a run abnormally — `awaiting_judgment`, cycle exhaustion, ceiling breach, terminal anomaly — write a durable escalation row (verified write, dedup-keyed), and if a notify command is configured, invoke it with the JSON payload on stdin (bounded, fire-and-forget; a notify failure is logged, never thrown — the row is the guarantee). The engine knows "a command," not a vendor. *Seat/skill (policy):* class→channel mapping (harness push for page-class, the existing huddle Slack adapter for queue-class), quiet hours, digest rendering. *Alternatives rejected:* a notify MCP (already killed once — this seam is exactly what survived that decision); the engine calling huddle directly (an MCP→MCP runtime dep); skill-prose-only push (re-creates the diligence hole — if the escalation only fires when the seat's prose remembers to fire it, an overnight run can strand silently, which is the exact audit P1 shape).

**D4 — Merge authority = three independent gates, and the seat can mint none of them.** `assertReady` (mechanical: not draft, no conflicts, green rollup — unconditional, never bypassed by any grant) × `MergeVerdict` (the deterministic assembler over reviewer ballots, coordinator cycles, CI state, adversarial-pass status — pure function, already shipped) × **grant** (operator-registered, repo-scoped, `shadow` by default, `active` only via an explicit local flip after a shadow track record — the 2026-06-30 option-B decision, inherited not reopened). This TDD adds two blast-radius caps to the grant: `max_auto_merges_per_run` (a runaway seat cannot merge an unbounded batch) and the sensitive-path rule (a PR touching the gate/verdict logic, auth, CI workflows, or branch protection always requires a human tap — the gate never merges changes to the gate).

Grant lifecycle needs more than surface-hiding, because a seat that can shell the CLI can shell `grant-merge` too. Three layers, honestly bounded:

- **MCP never exposes grant mutation** (read-only status) — removes the connector-seat path outright.
- **CLI mutation verbs are interactive-only**: `--activate`/`--revoke`/cap changes require a TTY and a typed confirmation phrase, refusing non-interactive stdin — a seat's shell calls are non-interactive, so a steered seat's invocation fails loudly instead of succeeding silently.
- **Every grant mutation is loud**: an audit row plus an immediate page-class `grant-mutated` escalation, so even a bypassed fence is visible within one tick, and the shadow/streak record resets.

The residual is named, not hidden: a local seat runs as the operator's OS user, so the fence against it is friction + loudness, not cryptography — the durable authority root sits one layer down, in the **GitHub token**, and token capability is graded by ladder rung. At L3 the cloud seat's token deliberately lacks branch-protection bypass: it cannot merge, by construction — its merge step parks as a ready-to-merge escalation and the operator (or the local seat) performs the merge. At L4 the operator issues that repo a scoped, revocable, bypass-capable token for the scheduled seat: the token grants the *capability*, while grant × verdict × caps govern every *use* of it and satisfaction rows record each one. The local overnight seat (L2) necessarily holds the operator's own token, which is exactly why L2's entry gate demands the shadow track record first and why the caps stay engine-enforced. The adversarial break-the-gate pass is a merge precondition for the C14 PR (fail-open history says the bot panel alone misses structural holes).

> **Update (2026-07-08) — the merge-authorization seam is filled by gate.** The `MergeVerdict` × grant half of D4 is superseded: **gate** (its own repo) now owns merge authorization externally — an HMAC-signed, repo-scoped grant carrying tier + review-cycle ceilings, a verdict composed from recorded state, and an exit-code contract the driver branches on (gate repo, `docs/features/driver-merge-wiring/spec.md`). This supersedes `assembleMergeVerdict` and the reserved `merge_grants`/migration-0011 slot (the #160-resume; task `freeze-scoped-merge-grant` is parked-superseded, C14 does not resume). `assertReady` is untouched — it stays ship's always-on readiness floor, composing under gate. One ship-side sub-choice remains open, named here not decided: *delete* `assembleMergeVerdict`, or *repurpose* it as the typed carrier of gate's verdict (`mergeVerdictSchema` already exists in the reserved judgment-request schemas).

**D5 — No shared control-plane database; GitHub is the cross-seat rendezvous.** The driver store stays seat-local SQLite. A run belongs to the seat that started it; what any seat (and the operator) can always see is the external truth — branches, PRs, reviews, checks on GitHub. Seat handoff is `driver render`/`status` JSON + GitHub state, not database replication. Escalation rows are seat-local too, so their visibility semantics are explicit rather than implied: **the row is the durable guarantee, delivery is the outward one.** Page-class rows push outward at write time via the notify hook; queue-class rows are read by the digest step on the seat's own machine. For a dead *local* overnight seat that is the operator's machine — nothing strands. For a *cloud* seat, unresolved escalation rows and recording intents ride the same relay export (§7 Flow E), and the page-tier push has already left the box; a cloud seat that dies between a park and its delivery is caught by the digest's external-truth sweep (§7 Flow D) — the loss is bounded to one digest cadence, never silent. That bounded window is the accepted residual of refusing a shared database. *Alternative rejected:* a hosted store (managed Postgres or similar) — an infra phase, a new failure domain, and cloud-first when the guardrail says local-first. *Consequence that must be fixed first:* two seats on ONE machine already see different stores — the packaged-app connector resolves its state under the app-virtualized data dir while a terminal CLI resolves the real one, and the CLI resolvers ignore `SHIP_DB_PATH`/`SHIP_RUNS_DIR` that the MCP server honors. Store convergence (C7) makes "one machine = one store" true and is sequenced before any seat-portability claim (§9 Phase 2).

**D6 — Dossier recording from a non-local seat is relayed, not re-plumbed.** Near term: the recording tail (`task_complete`, `artifact_link`) executes where the corpus is. Attended and local-overnight seats record directly (today's behavior). A cloud seat instead emits **recording intents** — structured (task, PR, merge-sha) tuples in its run record — and the operator's next local session replays them idempotently (`/shipped` picks them up; Flow E). *Alternative deferred:* the corpus as a synced git remote (dossier is markdown-on-disk precisely so git can be its transport) — a real option, but it's not needed until a cloud seat exists, and it's a dossier-side decision, so it stays an open question (§10) rather than a phase.

**D7 — Trust is earned per capability, advisory-first.** The tracelens gate shipped advisory-first and earned its place; every autonomy step here does the same. Merge authority runs in shadow before it runs active. The tracelens verdict is advisory before it blocks dispatch. `address` runs attended before it runs overnight. The ladder (§9) is the schedule of these flips, each gated on a track record, each reversible by one local command.

## 5. Data model (deltas only)

All deltas live in the driver store (`@ship/store`). No dossier schema changes; no tracelens changes (it consumes the richer traces already landing).

- **`merge_grants`** *(superseded 2026-07-08 — see the D4 update; gate owns merge authorization, the reserved slot is retired)* (resumed from the parked C14 plumbing): + `mode` (`shadow` | `active`, default `shadow`), + `max_auto_merges_per_run` (nullable = unlimited only if explicitly set so), + revocation timestamp. Sensitive-path patterns live in driver config, not the store — they are policy an operator edits, not run state.
- **`merge_grant_satisfactions`** (parked C14): per-PR audit rows — which verdict + grant authorized which merge, shadow-tagged when the mode was `shadow`.
- **`escalations`** (new): `id`, `driver_run_id?`, `stream_id?`, `repo?`, `class`, `payload_json`, `created_at`, `notified_at?`, `resolved_at?`, `resolution?`. Three scopes: stream-scoped (run + stream set), run-scoped (run set, stream null — `spend-ceiling`, `pathological-batch`), and system-scoped (run null, repo set — `grant-mutated`, which happens outside any run). Dedup is **open-row-only**: a partial unique index on `(COALESCE(driver_run_id, ''), COALESCE(stream_id, ''), class)` `WHERE resolved_at IS NULL` — at most one *unresolved* row per key; resolving closes the row, and a repeat transition after resolution opens a fresh row and re-pages (a park that recurs after a `retry` must page again — at-least-once means per transition, not per class). The COALESCE sentinels are load-bearing: SQLite composite UNIQUE indexes never collide on NULL, so nullable columns would otherwise duplicate freely. `grant-mutated` rows are written pre-resolved (they are FYI pages, not questions awaiting an answer), so they never suppress a successor. Each class carries a **default tier** — `page` (delivered outward at write time) or `queue` (digest-read) — overridable per class in driver config; the tier travels with the class, the channel stays with the seat. Classes (initial set): **page** — `triage-uncertain`, `auth-rejection`, `cycle-exhausted`, `product-direction`, `sensitive-path`, `spend-ceiling`, `pathological-batch`, `ci-infra`, `grant-mutated`; **queue** — `stream-parked` (the routine `awaiting_judgment` park while the seat is still triaging), `merge-blocked-no-verdict` (the verdict itself did not authorize), `merge-ready-awaiting-authority` (verdict authorized but nothing may act: no/shadow grant, or an L3 seat token without merge capability — the payload names which).
- **driver run row**: + `spend_ceiling_tokens?`, + `spent_tokens` (rolled up from the usage fields now captured per event). Ceiling enforcement is an engine check at dispatch/address decision points, not a seat courtesy.
- **recording intents**: stored on the run/stream rows as structured JSON (no new table) — emitted by non-local seats, replayed and marked applied by the local digest step.

## 6. API contract (surface deltas)

**Engine verbs.**

- `ship driver address <drv> --stream <ds> --findings <path>` — re-dispatch consolidated review findings onto the stream's **existing** PR branch: lifts the hardcoded fresh-branch dispatch (`workOnCurrentBranch:false`, absent `prUrl`) for the address path only, embeds the findings block, polls to terminal, increments the stream's review-cycle attempt. Mechanism only — *which* findings and *whether* to push back stays in `/review-coordinator` + seat judgment. (C10.)
- `markReady(repo, prNumber)` on `DriverGhPort`, invoked at the cloud poll→judgment boundary when a succeeded stream has a `prUrl`; `assertReady` remains the merge gate; the `gh pr ready` line leaves the skill prose. (C2.)
- `ship driver grant-merge <repo> [--activate | --revoke | --show]` — grant lifecycle, **CLI-only and interactive-only for mutations** (TTY + typed confirmation; non-interactive invocation refuses); every mutation writes an audit row + a `grant-mutated` page-class escalation; `land()` consumes grant × verdict; satisfaction rows always written (shadow-tagged in shadow mode). (C14.)
- **Escalation hook** — on park/exhaustion/breach/anomaly transitions: write the escalation row; for **page-tier rows only** (tier defaults per §5, config-overridable), spawn the configured `notify` command with the payload JSON on stdin, bounded timeout, failures logged not thrown. Queue-tier rows never invoke notify — they wait for the digest; paging on every routine park would train the operator to ignore pages.
- **MCP verb parity** — add `driver_import`, `driver_cancel`, `driver_render`, `driver_mark_merged` (and `driver_address` as it lands) beside the existing `driver_run`/`driver_status`/`driver_decide`/`driver_land`, so a connector-only seat can run the whole loop. Grant lifecycle is deliberately **not** exposed over MCP.

**Escalation payload** (versioned JSON):

```json
{
  "v": 1,
  "class": "cycle-exhausted",
  "driverRunId": "drv_…", "streamId": "ds_…",
  "repo": "owner/repo", "pr": 123,
  "question": "3 review cycles exhausted with 2 open actionable findings",
  "suggestion": "address once more with findings F1,F2 or merge-with-rationale",
  "evidence": { "links": ["…/pull/123"], "verdict": { }, "traceRef": "run-artifacts/…" },
  "createdAt": "…"
}
```

**The seat contract** (documentation, not code — a substrate qualifies iff it satisfies this):

1. ship engine reachable (CLI on PATH or the MCP server);
2. `gh` authenticated with a **scoped** token (repo-scoped, no admin beyond the target repos);
3. the policy skills present (`/work-driver`, `/review-coordinator`, `/work-driver-prep`);
4. tracelens on PATH (post-run verdicts);
5. an outward escalation channel (harness push and/or the huddle Slack adapter) — or the seat inherits page-class rows into its digest and the notify hook carries delivery;
6. a Claude session as the judgment runtime.

Terminal, local overnight session, cloud managed session, and scheduled routine all qualify by checklist, not by code.

## 7. Key flows

**A — Unattended failure triage.** Stream fails → engine classifies (`failureCategory`) → parks `awaiting_judgment` + writes a `stream-parked` row (queue-tier) → the seat's next tick reads the park JSON → LLM triage → `driver decide retry|skip|adopt|abort` with rationale (recorded on the stream), resolving the parked row → if the seat is uncertain, or retries are exhausted, it resolves the park and a `triage-uncertain` page-tier row opens — the notify hook fires. Other streams continue; parks are per-stream.

**B — Review-fix loop.** Reviews arrive → seat consolidates via `/review-coordinator` (ballots are structured; the verdict assembler's inputs, not prose) → actionable findings → `driver address --findings` re-dispatches onto the same PR branch → poll to terminal → re-request reviewers → cycle++ → unanimous approval / ship-it → Flow C. Cycle cap (3) exhausted with open actionables → `cycle-exhausted` escalation, page-class.

**C — Merge.** `land()` → `assertReady` (unconditional) → assemble `MergeVerdict` → grant lookup:
- no grant → today's behavior: human tap; a queue-tier `merge-ready-awaiting-authority` row when the verdict authorized but nothing may act on it (`merge-blocked-no-verdict` is reserved for the verdict itself not authorizing);
- `shadow` → write shadow satisfaction row + log "would merge PR #N under verdict …" + human tap still required (the calibration corpus);
- `active` + `merge_authorized` + under `max_auto_merges_per_run` + not sensitive-path → merge with whatever branch-protection-satisfying capability the seat's token carries (`--admin` on the operator's own token today; a bypass-capable seat token at L4) + audit row + verified read-back + record — a seat whose token lacks the capability parks a `merge-ready-awaiting-authority` escalation instead (the L3 shape);
- sensitive-path match → always park + page, regardless of mode.

**D — Seat dies overnight.** Ticks are seat-invoked, so no ticks happen; runs sit durable in the store; in-flight cloud runs keep executing remotely. Next seat (the morning terminal) re-attaches: orphan resume + the remote-liveness age floor keep run age honest across the gap, so nothing is falsely timed out and nothing is double-dispatched. Accepted semantics: **loss of seat = work paused, not corrupted.** No watchdog daemon (non-goal); the morning digest surfaces last-tick age so a dead overnight seat is visible in one glance. For a dead *cloud* seat — whose store, and any undelivered escalations in it, died with the box — the digest additionally runs an **external-truth sweep**: provider run listings + GitHub branch/PR state cross-checked against the seat's last relay export, so in-flight work is flagged even when no row survived. This sweep is the backstop behind the §2 delivery guarantee and the L4 "zero silent failures" gate: page delivery is best-effort within a tick; *detection* is guaranteed by the next digest.

**E — Cloud seat relay.** The cloud seat's relay export (on the run record) carries what the rung produced: at L3 — unresolved escalation rows + the `merge-ready-awaiting-authority` queue (its token cannot merge, so it merges nothing); at L4 — recording intents (task id, PR, merge sha) for the grant-authorized merges it performed, plus unresolved escalations. The operator's next local session runs the digest step → performs/records L3 merges, replays L4 intents into dossier (`task_complete` + `artifact_link`), idempotent on (task, sha), folds exported escalations into the morning queue → marks the export applied. Dossier never becomes a runtime dependency of the engine or the cloud seat.

**F — Spend ceiling.** Usage rolls up per run from event telemetry → at every dispatch/address decision point the engine checks `spent_tokens` vs `spend_ceiling_tokens` → breach: stop new dispatches, let in-flight streams reach terminal, park the run, write `spend-ceiling` escalation (page-class).

**G — Verdict gating (tracelens).** Post-run, the seat runs tracelens over the run trace → verdict JSON attached to the digest and recorded → advisory at first (today's behavior); at the ladder's L2 flip, a `pathological` verdict blocks the *next* dispatch of that stream shape and a `pathological-batch` pattern (≥N streams) halts the run with a page — the same advisory→enforced ramp the grant uses.

## 8. Concurrency / consistency / failure model

- **One seat per run**: the existing tick lease serializes ticks on one store. Two seats on two stores driving the same repo can race at the PR level only; GitHub is the arbiter (a second land sees the branch state and refuses). Accepted; noted, not engineered around.
- **Escalation delivery**: at-least-once **per transition**. Row first; notify after; `notified_at` null → retried next tick; the open-row-only dedup (§5) bounds duplicates to one unresolved row per (run, stream, class) while guaranteeing a recurrence after resolution re-pages. A duplicate push is annoying; a missing one is a stranded overnight run — bias accordingly.
- **Notify command failure**: logged, row stands, digest catches it. The channel is best-effort; the store is not.
- **GitHub outage mid-merge**: `land` already verifies by read-back; an unconfirmed merge is a park, not a record. `address`/`markReady` follow the same verified-write discipline.
- **Suspend/clock jumps**: already handled below this layer (monotonic cap re-validation + remote-liveness age floor). The control plane inherits, adds nothing.
- **Prompt injection at the seat**: the seat is an LLM reading PR comments and CI logs — assume it can be steered. That is why D4 puts authority in the engine: the worst a steered seat can do is decide/address within caps, page the operator, or merge something that passed readiness × verdict × grant × caps × sensitive-path — and every such action is audited. Widening authority requires an interactive operator action, and any attempt pages (D4); the deepest bound is server-side — the seat's token either can or cannot admin-merge, independent of anything the seat runs.

## 9. Rollout & trust ladder

**The ladder.** Each rung names the capability that flips, the falsifiable gate to enter it, and the rollback (always one local command or one config removal).

| Rung | Seat | What flips on | Gate to enter | Rollback |
|---|---|---|---|---|
| L0 (today) | Operator terminal, attended | — | — | — |
| L1 | Terminal, attended | Engine closes the loop under watch: ready-flip, `address`, shadow verdicts, escalation rows | Phase 1 merged; attended flows unchanged | revert config |
| L2 | Local session, **unattended** (overnight) | Grant `active` on this repo; tracelens `pathological` blocks dispatch; pages replace watching | Shadow streak: ≥10 consecutive shadow verdicts agreeing with the operator's actual merge calls, zero would-have-merged-a-rejected-PR; `address` dogfooded on ≥3 real review cycles | `grant-merge --revoke`; run attended |
| L3 | Cloud session, supervised | Same skills/verbs from a cloud seat; token deliberately lacks merge capability (merges queue for the operator); ceiling mandatory; escalations + queue via relay | **Graduation gate:** K consecutive unattended local runs (suggest K=5) where every operator touch was a genuine escalation — nothing caught only by watching | stop the cloud seat; local unattended continues |
| L4 (end state) | Scheduled routines | Routine-fired batches from the prepped backlog; operator issues the repo a scoped, revocable, bypass-capable seat token (grant × verdict × caps gate every use); operator = escalation queue + weekly policy review | ≥2 supervised cloud batches with accurate morning queues and zero silent failures | revoke the seat token; unschedule; drop to L3 |

**Phases.** Phases 1–3 are committed (they are almost entirely already-parked work being sequenced); the graduation gate sits at the end of Phase 3; Phase 4 is gated on it and stays task-less until it unblocks. Per-item sizing uses the repo's weighted-LOC bands.

**Phase 1 — Close the loop, make failures legible** (maps: C2, C10, C14, push-on-block, gateway-auth — all previously ranked/parked)

| Item | Source | Size |
|---|---|---|
| `markReady` on `DriverGhPort` + cloud poll→judgment call site; drop the skill-prose flip | synthesis C2 (new task `ccp-draft-ready-flip`) | S |
| `driver address` — the cloud review-fix verb | synthesis C10, the top move (new task `ccp-driver-address`) | M |
| ~~Merge-grant shadow ramp~~ *(superseded 2026-07-08 — gate owns merge authorization; see the D4 update. Do not resume.)* | existing task `freeze-scoped-merge-grant` (`tsk_01KW3Q7027D8J9QCF3XB6Z3VZ4`, parked-superseded) | — |
| Escalation rows + notify hook on park/exhaustion/breach transitions | synthesis "push-on-block" (new task `ccp-escalation-rows`) | S |
| Gateway auth legibility: forward the bearer carrier; classify gateway 401/403 as `auth-rejection` | existing tasks `claude-runner-forward-auth-token` (`tsk_01KWDYAJTR32YEWC1WHH1C5HES`), `claude-runner-classify-gateway-auth-rejection` (`tsk_01KWDYAWS775Z40G9SK1GJ6KYD`) | S |

*Gate 1:* one real ship batch exercises ready-flip + `address` + shadow verdicts end-to-end; the shadow-agreement streak starts counting; zero false-greens (CI demonstrably ran on every merged PR).

**Phase 2 — One store, one seat surface** (maps: C7, MCP parity, provider passthrough)

| Item | Source | Size |
|---|---|---|
| Store convergence: CLI resolvers honor `SHIP_DB_PATH`/`SHIP_RUNS_DIR` exactly as the MCP server does (absolute-path-guarded) + one-time operator merge of the split stores | synthesis C7 / the packaged-app two-store split (new task `ccp-store-convergence`) | S |
| MCP verb parity: `driver_import`, `driver_cancel`, `driver_render`, `driver_mark_merged` (+ `driver_address`) | audit follow-through (new task `ccp-mcp-verb-parity`) | S |
| Per-stream `provider` through manifest → import → dispatch (claude/codex streams in `/work-driver`; model/effort dispatch already landed) | existing task `thread-provider-through-driver` (`tsk_01KW3S8N68JRDMEDEK1VA6CMQE`) | M |

*Gate 2:* a full run driven from a connector-only seat — import → dispatch → decide → land → record without touching a terminal — and the connector + CLI demonstrably read the same store.

**Phase 3 — Local unattended rehearsal** (maps: branch-continuation, event-pump liveness, spend ceiling)

| Item | Source | Size |
|---|---|---|
| Branch-continuation dispatch + local→cloud flip (`startingRef` onto an existing branch) | existing task `freeze-branch-continuation-dispatch` (`tsk_01KW3Q5RQET3DVH39ZHPH8VKKP`) | M |
| Event-pump liveness blind spot: stop the local heartbeat from masking remote staleness in the tick give-up | existing task `event-pump-blinds-tick-liveness` (`tsk_01KWFV8KRDAM46V088DB5159PB`) | S–M |
| Per-run spend ceiling: `spend_ceiling_tokens` + rollup + breach flow | synthesis Tier-A spend ceiling — its stated trigger ("first genuinely-unattended batch") fires at this phase (new task `ccp-spend-ceiling`) | S |
| Grant `--activate` on this repo after the shadow streak; tracelens advisory→enforced flip | operational (no code) | — |
| Overnight rehearsal runs ×K with pages as the only touch | operational | — |

*Gate 3 = the graduation gate:* K consecutive unattended local runs (suggest 5) where every operator touch was a genuine escalation. This is the go/no-go for anything cloud.

**Phase 4 — Cloud seat** (post-gate; stubs only, no tasks materialized)

Seat runbook per substrate (cloud session, scheduled routine): scoped-token provisioning, seat-contract checklist, ceiling defaults. Recording-intent relay: emit on the cloud seat, replay in the local digest step. Corpus-as-git decision (open question 5) resolves at this phase's entry. First supervised cloud batch. *Gate 4:* ≥2 supervised cloud batches, accurate morning queue, zero silent failures → L4 scheduling.

**Mapping accounting** (the ≥80% claim, checkable): 13 build items across Phases 1–3; 5 are existing dossier tasks referenced in place; 6 are synthesis-ranked parked items receiving their task rows (`ccp-draft-ready-flip`, `ccp-driver-address`, `ccp-store-convergence`, `ccp-mcp-verb-parity`, `ccp-spend-ceiling`, plus the push-on-block primitive the synthesis itself surfaced as the missing piece); 2 are genuinely new mechanism (escalation rows/notify hook — the push-on-block shape made concrete; grant caps — two columns and a check). Nothing else is invented. Already shipped and therefore absent from the plan: the land verb + self-finish, the verdict assembler, both suspend-cap heads, per-stream model/effort dispatch, trace telemetry, the tracelens advisory gate.

## 10. Open questions (batched for the operator — none block Phases 1–2)

1. **Page channel:** harness phone push, Slack DM via the huddle adapter, or both? Quiet hours?
2. **K for the graduation gate** — suggest 5.
3. **Default spend ceiling** for an unattended run (tokens; suggest deriving from the telemetry of the last 10 attended runs, e.g. p90 × 1.5).
4. **Default `max_auto_merges_per_run`** — suggest 5.
5. **Corpus-as-git** for direct cloud-seat dossier writes — decide at Phase 4 entry; the relay (D6) removes urgency.
6. **Sensitive-path list** beyond gate/verdict source, auth, CI workflows, branch-protection config — anything else that must never auto-merge?
7. **L4 seat-token mechanism** — fine-grained PAT with bypass on the one repo, vs adding the seat identity to the branch-protection bypass list? Pick at Phase 4 entry; both are operator-issued and revocable, the choice is ergonomics.

## 11. Validation plan

The binary top-level signal is the graduation gate: K consecutive unattended local runs where every operator touch was a genuine escalation — baseline-free, falsifiable, and it directly operationalizes the vision's bias test ("if a human isn't watching for 8 hours, is the design still safe?"). Beneath it, each phase gate above is a demonstrable event, not a vibe. Two standing invariants ride every phase: (1) with no grant and no notify config, the attended flow is byte-identical (regression-tested); (2) every autonomous action can be reconstructed from store rows alone (audit query, no logs required). The shadow-mode satisfaction log is the calibration corpus for merge authority; the escalation table is the calibration corpus for paging — both are reviewed at each ladder promotion.
