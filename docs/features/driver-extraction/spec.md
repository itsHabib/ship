# Driver extraction (`@ship/driver`) — Technical Design Document

**Status:** draft / proposal — NOT a build commitment. The artifact we decide from.
**Owner:** @itsHabib
**Date:** 2026-06-10
**Related:** external workbench review 2026-06-09 (findings F1 + F2, Managed-Agents addendum) · `~/.claude/skills/work-driver/SKILL.md` (the prose this extracts) · `docs/features/ship-v2/spec.md` (ED-1/ED-2 lineage) · dossier project `ship` · [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)

> **Reviewers — focus areas:**
> 1. **§4.1 — the pause-and-exit judgment-hook contract** (the brain/hands seam; everything hangs off it).
> 2. **§4.3 — the v1 scope line**: review cycles + merges stay policy (skill), the engine stops at "streams landed, PRs known." Too thin? Too thick?
> 3. **§5 — `driver_batches` as a table vs JSON-on-run** (open fork, weigh in).
> 4. **§7.3 — the dispatch-then-crash window** (idempotent re-dispatch recovery).

## 1. Problem & hypothesis

`/work-driver` is a 268-line SKILL.md encoding a deterministic state machine — manifest autodetection via `driver_version:` frontmatter, dep-ordered batch walking, per-stream `pending/failed/done` resume semantics, status writeback, terminal-state polling — **executed by an LLM re-reading prose on every invocation**. The costs are structural, not stylistic:

- **Token + wall-clock cost per run.** The LLM babysits sleep-polls and re-derives the loop each session. Under Claude Managed Agents (the intended cloud home for the driver, ~$0.08/session-hour + tokens), this is the expensive option: the session pays model rates to do `sleep 90`.
- **Drift.** Prose policy has already drifted once in the wild (the work-driver ↔ dev-workbench review-coordinator wiring contradiction). Nothing tests a SKILL.md.
- **Fragile state.** `driver.md` YAML frontmatter is the resume database, mutated by LLM text edits (F2). One malformed edit silently corrupts resume — tolerable attended, untenable unattended.
- **It cannot be a managed agent.** A cloud-managed driver needs an installed binary to shell out to; a SKILL.md is not a deployable artifact.

**Hypothesis:** extract the deterministic loop into `@ship/driver` — a tested package + CLI/MCP verbs — and leave *only judgment* to the calling agent via explicit hook points. The same engine then serves two brains unchanged: today's interactive Claude Code session (via a ≤100-line `/work-driver` policy wrapper), and later a Managed-Agent session (same wrapper as its Agent Skill, same CLI in its environment). Brain = session; hands = CLI.

**Non-goals (v1):**
- **Review-cycle automation.** Reviewer pings, verdict ingest, fix loops stay in the skill until F3's verdict CLI exists. The engine's job ends at "streams landed, PRs known."
- **Merge execution.** Merging (and the F4 gate) stays policy. The judgment-hook contract reserves a `merge-confirmation` kind so the engine can absorb mechanical merging later without a redesign.
- **The F6 trigger surface** (`ship driver watch`, dossier-tag poller). Post-gate stub — the engine is designed so `watch` is a thin wrapper around `run`.
- **MA-as-impl-runner** (`runtime: "managed"`). Separate future spec; this TDD is MA-as-coordinator only.
- **Spec/manifest *generation*.** `/work-driver-prep` remains the author of `driver.md`; its format is the input contract, unchanged.

## 2. Functional & non-functional requirements

**FR**
1. Parse + validate a `driver.md` manifest (`driver_version: 1` YAML frontmatter; today's `/work-driver-prep` output) into typed structures; reject with line-precise errors.
2. Import a manifest into the store as a `driver_run` (one-time; idempotent re-import by manifest identity).
3. Walk batches in `depends_on` order; dispatch each stream via `ShipService.startShip` honoring per-stream `runtime` (local | cloud | mixed batches).
4. Poll dispatched runs to terminal via `getRun` + `isTerminal`; record landing facts per stream (workflow_run_id, PR url when cloud auto-opened one).
5. On stream failure: persist the failure (ship's `FailureCategory` carried through), emit a structured **judgment request**, and pause — never auto-retry, never auto-abort.
6. Resume from **store state alone**: process restart, mid-run manifest deletion, and `--batch N` targeting all work.
7. Render `driver.md` *from* the store — the markdown becomes a human-readable view, byte-stable for unchanged state.
8. Expose the engine as CLI verbs (`ship driver import|run|decide|render|status`) and MCP verbs (`driver_run`, `driver_status`, `driver_decide`) returning structured JSON.
9. Honor `SHIP_TEST_FAKE_CURSOR=1` end-to-end (the existing L3 seam) so full driver runs are testable without quota.

**NFR**

| Dimension | Target |
|---|---|
| LLM involvement | **Zero model calls inside the engine.** The only LLM touchpoints are the judgment hooks, which are *exits*, not calls. |
| Determinism | Same manifest + same store state → identical plan and identical render. Golden-manifest tests; two-run determinism test. |
| Resumability | Kill -9 at any point → `ship driver run <id>` resumes losslessly from the store. Manifest file not required after import. |
| Compatibility | Every existing `driver.md` in the portfolio (dossier hygiene/policy-mech/s3-cutover, ship observability) imports cleanly — fixture test on a real historical manifest. |
| Parallelism safety | Respect `LOCAL_RUNTIME_PARALLELISM_LIMIT` (2); default local dispatch is **serialized** (friction log 2026-06-02: concurrent local SDK crashes); cloud parallelism bounded by a config cap (F9 hook). |
| Cross-platform | ubuntu + windows CI green (`make check`); no bash-isms in the engine. |
| Test rigor | L1/L2 over parse/walk/resume/writeback; property test for the render round-trip; mutation score not reduced. |

## 3. Architecture overview

```
                      BRAIN (judgment only)
   today: Claude Code session via /work-driver policy wrapper
   later: Managed-Agent session via the same wrapper as an Agent Skill
        │  invoke                ▲ structured JSON
        │  decisions             │ {awaiting | progress | done}
        ▼                        │
┌─────────────────────────────────────────────────────┐
│                 @ship/driver  (HANDS)                │
│  manifest.ts   zod schema + parser (input contract)  │
│  import.ts     manifest → driver_run rows            │
│  engine.ts     batch walker · dispatcher · poller    │
│  judgment.ts   hook-point contract (emit + decide)   │
│  render.ts     store rows → driver.md view           │
└──────┬──────────────────────────────┬───────────────┘
       │ startShip / getRun /         │ driver_runs ·
       │ cancelRun                    │ driver_batches ·
       ▼                              ▼ driver_streams
   @ship/core  ShipService        @ship/store (migration 0005)
   (single-run lifecycle —            (source of truth;
    untouched)                         driver.md is a render)
```

**Reused, untouched:** `@ship/core`'s single-run lifecycle (`startShip` → poll `getRun` → `isTerminal`), the runner seam (local/cloud/rooms), `@ship/workflow` conventions (strict zod, ulid ids, sticky terminal states), `@ship/store`'s migration runner + sync-sqlite + contention guard, CLI `registerXCommand` and MCP `registerXTool` patterns.

**New:** one package (`packages/driver`), one migration, five CLI subverbs, three MCP tools.

**The seam:** core owns *one run*; driver owns *many runs with ordering and resume*; the brain owns *judgment*. Dependency direction: `driver → core → store`; nothing below learns about the driver.

## 4. Key decisions & trade-offs

### 4.1 Pause-and-exit with structured state — not a long-running daemon

`ship driver run` executes deterministically until it (a) finishes, (b) needs judgment, or (c) hits an error — then **exits with a JSON `DriverTickResult`** (exit 0 = done/progress, exit 10 = awaiting judgment, exit 1 = engine error). The brain reads, decides, and re-invokes (`ship driver decide … && ship driver run …`). In-process callers (MCP verb) get the same shape per bounded tick.

- **Why:** crash-safe by construction (every pause is a persisted state); MA token spend becomes proportional to *decisions* (~3–10/batch), not wall-clock; no daemon to host/supervise; the identical contract serves interactive and managed brains.
- **Alternative rejected:** long-running watch-mode process with prompts/callbacks. More moving parts, needs hosting, and F5 (push events) + F6 (`driver watch`) can wrap the pause-and-exit engine later without rework.
- **Within a tick, the engine *does* poll** (`getRun` every `pollIntervalMs`, default 30s, jittered) — bounded by `--max-wait` (default 20min) so a tick can't hang a session; on expiry it exits with `progress` and the brain just re-invokes. Polling stops being a token cost because no model is awake during it.

### 4.2 Store is the source of truth; `driver.md` becomes a render (F2)

Progress fields (`status`, `pr_number`, `merge_commit`, `merged_at`, `cycles`) move into `driver_*` tables; `render.ts` regenerates the manifest's frontmatter view from rows. The manifest keeps its current shape so humans and `/shipped` read it unchanged.

- **Why:** ends YAML-edits-as-database-writes; resume survives manifest deletion; round-trip property-testable.
- **Alternative rejected:** frontmatter-canonical + lockfile. Keeps the LLM in the write path — the exact failure mode F2 names.
- **Input vs progress:** the manifest remains the authoritative *input spec* (task list, batches, deps, `touches`). Import is one-way; after import, manifest edits to *progress* fields are ignored (a re-import warns). Editing *inputs* mid-run is out of scope v1 (open question §10c).

### 4.3 v1 engine scope: dispatch → poll → land → resume → render. Reviews and merges stay policy.

The engine ends at "all streams terminal; landing facts recorded." Reviewer pings, `/review-coordinator` calls, fix cycles, merge ordering — all remain in the (shrunken) skill.

- **Why:** this is the smallest extraction that kills the worst prose (sleep-polls, YAML editing, resume bookkeeping) and matches the review's own acceptance criteria. Review-cycle mechanics are F3's extraction; merging unattended is gated on F4's required check. Absorbing them now would couple this package to two unfinished findings.
- **Forward-compat:** the `JudgmentRequest.kind` enum ships with `failure-triage` live and `merge-confirmation` / `review-adjudication` reserved, so later phases extend rather than redesign.

### 4.4 New package, not core growth

`@ship/driver` as a sibling. Core's charter is one run's lifecycle; multi-run orchestration is a different responsibility with its own state. Mirrors how `@ship/receipt` landed.

### 4.5 Retry semantics on `decide retry`

A retried stream gets a **fresh workflow run** (new `wf_` id) against the **same branch**; the prior attempt's run id is kept in the stream's `attempts` history. Same-branch keeps PR continuity (cloud `autoCreatePR` reuses the open PR); fresh-run keeps ship's run records append-only.

## 5. Data model

Migration `0005_driver_runs.sql`, following the 0001 conventions (TEXT pks, ISO timestamps, FKs with cascade, JSON columns hydrated through strict zod):

```sql
CREATE TABLE driver_runs (
  id            TEXT PRIMARY KEY,          -- drv_<ulid>
  manifest_path TEXT NOT NULL,             -- import provenance (display only)
  repo          TEXT NOT NULL,
  project       TEXT,                      -- dossier project slug (from source:)
  phase         TEXT,                      -- dossier phase slug
  status        TEXT NOT NULL,             -- pending|running|awaiting_judgment|done|failed|cancelled
  source_json   TEXT NOT NULL,             -- the parsed input spec, verbatim (re-render fidelity)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE driver_batches (
  id             TEXT PRIMARY KEY,         -- db_<ulid>
  driver_run_id  TEXT NOT NULL REFERENCES driver_runs(id) ON DELETE CASCADE,
  batch_index    INTEGER NOT NULL,         -- the manifest's `id:`
  label          TEXT,
  depends_on     TEXT NOT NULL,            -- JSON int[]
  status         TEXT NOT NULL,            -- pending|running|done|failed
  completed_at   TEXT
);

CREATE TABLE driver_streams (
  id               TEXT PRIMARY KEY,       -- ds_<ulid>
  driver_run_id    TEXT NOT NULL REFERENCES driver_runs(id) ON DELETE CASCADE,
  driver_batch_id  TEXT NOT NULL REFERENCES driver_batches(id) ON DELETE CASCADE,
  task_id          TEXT,                   -- dossier tsk_*
  task_slug        TEXT,
  spec_path        TEXT NOT NULL,
  branch           TEXT,
  runtime          TEXT NOT NULL,          -- local|cloud|rooms
  touches          TEXT NOT NULL,          -- JSON string[]
  status           TEXT NOT NULL,          -- pending|dispatching|dispatched|landed|failed|awaiting_judgment|skipped|done
  workflow_run_id  TEXT,                   -- current attempt's ship run
  attempts         TEXT NOT NULL,          -- JSON: [{workflowRunId, dispatchedAt, terminal, failureCategory?}]
  pr_number        INTEGER,
  pr_url           TEXT,
  merge_commit     TEXT,
  merged_at        TEXT,
  cycles           INTEGER,
  error_message    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX driver_streams_run_idx   ON driver_streams (driver_run_id);
CREATE INDEX driver_streams_status_idx ON driver_streams (status);
```

**Stream status semantics** *(v2: `awaiting_judgment` removed from the stream enum — it is a RUN-level state only; cursor review caught the §4.1/§7.2 contradiction)*: stream statuses are `pending | dispatching | dispatched | landed | failed | skipped | done`. `dispatching` is the crash-window marker (intent persisted before `startShip`; see §7.3). `landed` = ship run terminal-succeeded, PR known where applicable. `failed` is the stream's resting state **during** triage — `decide` acts on `failed` streams of an `awaiting_judgment` run; that pair of fields is the gate, unambiguously. `done` = merged (written by the *skill* via `ship driver mark-merged <stream> --pr N --sha X`, keeping the store authoritative even for policy-side facts).

**Schema integrity (v2, codex):** `driver_streams` carries a **composite FK** — `FOREIGN KEY (driver_run_id, driver_batch_id) REFERENCES driver_batches (driver_run_id, id)` (with the matching `UNIQUE (driver_run_id, id)` on `driver_batches`) — so a stream can never point at a batch belonging to a different run. `driver_run_id` stays on streams for the hot index.

**Render fidelity (v2, claude):** `source_json` stores the **raw frontmatter text verbatim** (pre-zod), not the parsed object — a `.strict()` parse would silently strip unknown future fields and break render round-trip across schema upgrades.

**Fork resolved (was open):** `driver_batches` is a table, not JSON — the composite-FK integrity above requires it, which closes the question (claude: a JSON column can't be an FK target; batch status also becomes first-class queryable for the walker).

## 6. API contract

```ts
// packages/driver/src — public surface
export interface DriverService {
  importManifest(manifestPath: string): DriverRun;                  // idempotent by (repo, manifest identity)
  run(ref: DriverRunRef, opts?: RunOpts): Promise<DriverTickResult>; // the engine tick (§4.1)
  decide(driverRunId: string, streamId: string, decision: Decision): DriverRun;
  markMerged(driverRunId: string, streamId: string, facts: MergeFacts): DriverRun;
  render(driverRunId: string): string;                              // driver.md text from store rows
  getDriverRun(id: string): DriverRun | null;
  listDriverRuns(filter?: { repo?: string; status?: DriverRunStatus[]; limit?: number }): DriverRun[];
}

export type DriverRunRef = { driverRunId: string } | { manifestPath: string }; // path → auto-import
export interface RunOpts {
  batch?: number;                  // target one batch (resume/recovery)
  maxWaitMs?: number;              // tick bound, default 20min
  pollIntervalMs?: number;         // default 30s
  maxParallel?: { local?: number; cloud?: number }; // defaults: local 1, cloud 4 (F9 hook)
}

export type Decision =
  | { kind: 'retry' }
  | { kind: 'skip'; reason: string }
  | { kind: 'abort'; reason: string }
  | { kind: 'adopt'; workflowRunId: string };   // v2: answers a dispatch-ambiguity request

export interface DriverTickResult {
  driverRunId: string;
  status: 'running' | 'awaiting_judgment' | 'blocked_on_merges' | 'done' | 'failed' | 'cancelled';
  awaiting: JudgmentRequest[];     // non-empty iff status === 'awaiting_judgment'
  unmerged: DriverStreamView[];    // v2: non-empty iff status === 'blocked_on_merges' (§7.6)
  progress: { batchIndex: number; dispatched: number; landed: number; failed: number; remaining: number };
  streams: DriverStreamView[];     // compact per-stream rows for the brain
}

export type JudgmentRequest =
  | {                              // a stream failed; brain triages (§7.2)
      kind: 'failure-triage';
      driverRunId: string;
      streamId: string;
      workflowRunId: string;
      failureCategory: FailureCategory; // ship's enum, carried through
      errorMessage?: string;
      attempts: number;
      hint?: string;               // e.g. LOCAL_RUN_CONTENTION_HINT passthrough
    }
  | {                              // v2: crash-recovery found >1 candidate run (§7.3)
      kind: 'dispatch-ambiguity';
      driverRunId: string;
      streamId: string;
      candidates: { workflowRunId: string; createdAt: string; status: string }[];
    };
// reserved kinds: 'merge-confirmation' | 'review-adjudication'
```

**CLI** (registered via the existing `registerXCommand(program, factory)` pattern):

```
ship driver import <driver.md>                          → { driverRunId }
ship driver run    <driver.md | drv_id> [--batch N] [--json]
                   [--max-wait 20m] [--poll-interval 30s]   exit 0 done/progress · 10 awaiting · 1 error
ship driver decide <drv_id> --stream <ds_id> <retry|skip|abort> [--reason "..."]
ship driver decide <drv_id> --stream <ds_id> adopt --workflow-run <wf_id>   # answers dispatch-ambiguity (v2)
ship driver mark-merged <drv_id> --stream <ds_id> --pr <n> --sha <sha> [--merged-at <iso>]
ship driver cancel <drv_id>                                                 # run-level (v2, distinct from decide)
ship driver render <drv_id> [--out docs/features/<phase>/driver.md]
ship driver status <drv_id> [--json]    # flags "manifest modified since import" (v2)
```

**MCP** (via `registerXTool`; input/output zod in `@ship/mcp`): `driver_run { manifestPath?|driverRunId?, batch?, maxWaitMs? } → DriverTickResult` · `driver_status { driverRunId }` · `driver_decide { driverRunId, streamId?, decision }`. *(v2, claude §10b)* The MCP tick defaults **`maxWaitMs: 0`** — one dispatch + scan pass, return immediately; the polling loop lives in the caller (the brain), which knows its own transport limits and may pass a larger bound explicitly. The CLI keeps its 20-min default (no transport to time out). `ship driver status` output flags when the manifest file has changed since import (`⚠ manifest modified since import <ts>` — §4.2's warning made visible).

Path/env: same `SHIP_DB_PATH` / `SHIP_RUNS_DIR` resolution as the existing CLI; `SHIP_TEST_FAKE_CURSOR=1` flows through to the runner seam untouched.

## 7. Key flows

### 7.1 Happy path — 2-stream cloud batch
1. `import` parses frontmatter (strict zod), writes `driver_run` + batches + streams (`pending`), `source_json` verbatim.
2. `run` finds batch 1 (deps satisfied), dispatches both streams: per stream, status→`dispatching` (txn) → `startShip({ runtime:'cloud', cloud:{ repos, autoCreatePR:true }})` → record `workflow_run_id`, status→`dispatched` (txn).
3. Poll loop: every 30s, `getRun` each in-flight id; on `isTerminal`: succeeded → harvest `branches[0].prUrl` → `landed`; failed → §7.2.
4. Both `landed` → batch `done` → next batch (or `DriverTickResult{status:'done'}`). Renderer refreshes `driver.md` if `--out` configured. The skill takes over: reviewers, cycles, merge, then `mark-merged` per stream.

### 7.2 Failure → judgment → retry *(v2: ordering made explicit — cursor)*
1. Stream B's run terminates `failed` (`failureCategory: 'timeout-near-cap'`). Engine: stream→`failed`, attempt appended. **The run does NOT pause yet** — sibling in-flight streams keep polling to terminal first (no orphaned dispatches). Only when no stream remains in `dispatching|dispatched` does the run transition to `awaiting_judgment`.
2. The tick then exits 10 with `awaiting:[{kind:'failure-triage', …}]` — one entry per `failed` stream awaiting triage.
3. Brain triages (this is the LLM's actual job): `decide … retry` → stream→`pending`, next `run` re-dispatches same branch, fresh `wf_` id (§4.5). `skip` → `skipped`, batch can still complete; `abort` → run→`failed`, sticky.

### 7.3 Crash mid-dispatch (the window §reviewers) *(v2: correlation hardened — codex)*
`dispatching` persisted but process dies before `workflow_run_id` recorded. Matching by `docPath` cardinality alone is fragile (an unrelated same-doc run gets adopted; pagination can hide the real one). v2 recovery, per `dispatching` stream:
1. Query `listRuns({repo, status:['pending','running','succeeded','failed','cancelled']})` bounded to runs **created at/after the stream's `dispatching` timestamp** (persisted in `attempts`), and match on `docPath` **AND** the stream's `branch` (both are dispatch inputs; branch is unique per stream by construction).
2. Exactly one → adopt (`dispatched`). Zero → revert to `pending` (the dispatch never left). Multiple, or pagination-suspect (result set at the limit) → emit `{kind:'dispatch-ambiguity', candidates:[{workflowRunId, createdAt, status}…]}` and pause — **never guess**; the brain answers with `decide … adopt --workflow-run <wf_id>` (or `retry` to abandon candidates and re-dispatch).
3. **Pre-P3 verification step:** confirm `listRuns` surfaces `docPath` per returned run (it is on `WorkflowRun` today) and that the limit is high enough to bound the created-after window; if not, P3 adds the needed filter to the store first.

### 7.6 Dependent batches wait for MERGE, not landed *(v2 — codex caught a contract break)*
`depends_on` exists because later batches build on earlier batches' **merged** code (the historical work-driver contract). v2 semantics: a batch is dispatch-eligible only when every batch in its `depends_on` has all streams `done|skipped` (merged or skipped — not merely `landed`). When the only remaining work is blocked on unmerged dependencies, the tick exits with `status:'blocked_on_merges'` listing the landed-but-unmerged streams; the brain runs its review/merge policy, records `mark-merged`, and re-invokes. Batches with **no** `depends_on` edge keep dispatching immediately (preserves the parallel-while-CI optimization for file-disjoint batches).

### 7.4 Resume from store alone (acceptance)
`driver.md` deleted mid-run → `ship driver run drv_…` proceeds from rows; `render --out` regenerates the file. Round-trip property: store → render → parse → import → rows lossless on progress fields.

### 7.5 Local serialization
`runtime:'local'` streams dispatch with `maxParallel.local = 1` by default (friction 2026-06-02: parallel local SDK crashes; store cap is 2 but empirically 1 is the safe default). Mixed batches: cloud streams fan out, local ones queue.

## 8. Concurrency / consistency / failure model

- **All state transitions transactional** via `@ship/store` conventions (`withStoreContentionGuard`, busy-timeout 30s); every transition bumps `driver_runs.updated_at`.
- **Single-writer assumption per driver_run** *(v2 — the heartbeat lease was over-engineered; claude §10e, plus codex caught that a `--max-wait` exit would self-block re-invocation)*: the engine stamps `tick_started_at` on tick entry and `tick_ended_at` on every exit (including `progress`/`blocked_on_merges` exits). A second `run` refuses only when a tick looks **live** — `tick_started_at` set with no matching `tick_ended_at` AND `updated_at` fresher than 3× the poll interval. A cleanly-exited tick never blocks the brain's immediate re-invoke. `--force` overrides (manual takeover after a hard crash inside the staleness window). Not a distributed lock — same trust level as the rest of the local workbench.
- **Cancellation** *(v2 — cursor caught the cancel/decide mismatch)*: `ship driver cancel <drv_id>` is its own **run-level** verb on the public surface (`DriverService.cancel(driverRunId)`), not an alias of stream-scoped `decide`: it `cancelRun`s every in-flight ship run (idempotent), marks open streams `failed` (cancelled attempt recorded), run→`cancelled`, sticky. `decide … abort` remains the stream-scoped form used during triage.
- **Engine errors ≠ stream failures:** store/contention/schema errors exit 1 and change nothing (transactions); stream failures are data (§7.2).
- **Push events (F5):** out of scope; the poll sites are isolated in `engine.ts#awaitTerminal` so an event-driven waiter can replace them without touching the walker.

## 9. Rollout / implementation plan

| # | Phase (dossier slug) | Goal | High-level tasks | Depends on | Scope (weighted) | Gate |
|---|---|---|---|---|---|---|
| 1 | `driver-extraction-manifest-schema` | `@ship/driver` bootstrap: the input contract as code | package scaffold; strict zod manifest schema + frontmatter parser; golden fixtures incl. one real historical manifest (dossier hygiene-followups); line-precise parse errors | — | ~400–600 | — |
| 2 | `driver-extraction-store-entity` | F2: progress state lives in the store | migration `0005`; `driver_runs/batches/streams` verbs on `Store`; `importManifest`; `render`; round-trip property test | 1 | ~500–700 | — |
| 3 | `driver-extraction-engine` | the loop as code | batch walker; dispatcher (startShip, runtime-aware, §7.5 serialization); poller (`awaitTerminal`); failure→judgment + `decide`; §7.3 recovery; resume | 2 | ~700 (split dispatcher/poller vs judgment/resume if it busts the band) | — |
| 4 | `driver-extraction-cli-mcp` | the brain-facing surface | 6 CLI subverbs; 3 MCP tools; `SHIP_TEST_FAKE_CURSOR` e2e: ad-hoc N=1, `--batch`, failed-retry, store-only resume | 3 | ~400–600 | **VALIDATION GATE** ⬇ |
| — | **GATE: dogfood** | drive one real ≥2-stream cloud batch end-to-end via `ship driver run` | zero manual YAML edits; zero sleep-polls in the session; judgment hooks the only LLM touchpoints; receipt/`/shipped` confirms the batch | 4 | — | go/no-go for P5+ |
| 5 | `driver-extraction-skill-rewrite` | `/work-driver` → ≤100-line policy wrapper | rewrite skill (policy only: 3-cycle cap, address-inline-and-merge, strategy selection, judgment handling); relocate lore per F7 (never delete); propagate cc-skills + public | gate | ~docs | — |
| 6 | `driver-extraction-watch-trigger` *(stub)* | F6 entry point | `ship driver watch` dossier-tag poller wrapping the engine; F9 caps enforced | 5 + F5 | unspecced | post-gate |

Phases 1–2 are committed and task-materialized now; 3–4 are committed but task-materialized when 1–2 merge (their shape depends on review of this doc); 5–6 are gated.

## 10. Open questions

*(v2: a, b, e resolved by cycle-1 design review — answers folded into §5, §6, §8. Remaining:)*

c. **Mid-run input edits** — adding a stream to an imported run. v1: not supported (re-import a new run). Acceptable?
d. **`cycles` ownership** — review cycles are policy-side; v1 records them via `mark-merged --cycles N`? Or drop from the store until F3 lands and derive from coordinator verdicts? Proposed: optional field on `mark-merged`, derive later.

## 11. Validation plan

The §9 gate is binary and baseline-free:

1. **Mechanical acceptance (CI):** golden-manifest parse/walk tests incl. failed-retry and `--batch N`; two-run determinism; store-only resume with the manifest deleted (fixture); render round-trip property test; full fake-cursor e2e (N=1 ad-hoc + manifest resume) on ubuntu + windows.
2. **Dogfood gate (go/no-go for P5):** one real ≥2-stream cloud batch driven via `ship driver run` where (a) the session performs zero manifest edits and zero sleep-polls, (b) every LLM touchpoint is a judgment hook or the review/merge policy steps, and (c) the run survives one deliberate mid-run process kill + resume. If the engine can't clear this on a real batch, P5 (skill rewrite) does not proceed.
