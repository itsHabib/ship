# Observability — Technical Design Document

**Status:** draft / proposal — NOT a build commitment. The artifact we decide from.
**Owner:** @michael
**Date:** 2026-06-02
**Related:** dossier project `ship` (`prj_01KRAE24JC3JCZPNHQQQWGKFY1`); prior point-fixes [#103](https://github.com/itsHabib/ship/pull/103) (surface-failed-run-diagnostics), [#105](https://github.com/itsHabib/ship/pull/105) (ship-store-write-contention); feedback task `failed-run-errormessage-omits-inflight-tool-call` (`tsk_01KT3CYEFSM41WS3VEQM5NMG0K`).

**Revisions:** **v2** (2026-06-02) — addressed the #111 design-review verdict. The bots endorsed the core bet (D1 shared enum, D4 pino, the phase split) but caught that v1's §5/§7 mis-stated ship's actual finalize plumbing. v2: classification + persistence move into `core`'s finalize, fed a bounded diagnostic carried on `CursorRunResult`, covering the real failed-run path (today `finalizeSuccess`) **and** cloud (§4 D5 / §5 / §7); the Phase-1 gate is reconciled with the phase split (§9 / §11); `cancelled` is dropped from the failure taxonomy (§5 / §7); all four §10 questions resolved.
**v3** (2026-06-02) — addressed the cycle-2 confirm review (claude: APPROVE). Both finalize paths now classify (`finalizeFailure` is the primary path for `sdk-throw`/`contention`); cloud `EXPIRED` reclassified as a failure (was `→ cancelled`); classifier takes `isStoreContention`/`thrownError` flags from `core` (no `cursor-runner`→`@ship/store` edge) and drops `isCancelled` (caller pre-screens); `durationMs` not `runDurationMs`; ε thresholds defined; tombstone enum literals; `pino-pretty` devDep + prod-JSON-only; stdout test extends the existing e2e stdio suite. (§4 D4/D5, §5, §6, §7, §8, §10, §11)

> **Reviewers — focus areas:**
> - §4 D1 (one shared `failure-category` enum threaded through every surface) — the load-bearing decision.
> - §4 D2 (`@ship/logger` as a leaf package vs a module) and D4 (pino choice).
> - §7 the failure-classification flow — does the category mapping cover the real terminal states?
> - §3 the stdout/stderr split — getting this wrong corrupts the MCP protocol.

## 1. Problem & hypothesis

Ship's whole job is **"fire an agent, then know what it did and why it failed."** Observability isn't a side-feature here — it's roughly half the product. Yet today:

- **No structured logging.** ~24 ad-hoc sites (all under `packages/*/src/`): `console.warn` in `store/db.ts` + `store/store.ts`; `process.stderr.write("[ship-cloud-warn|error|debug] …")` in `cursor-runner`; bare `process.stderr.write(err.message)` in `core/service.ts` + `mcp-server/bin.ts`. No logger library, no logger module. When ship itself misbehaves, there's no queryable trail.
- **Run diagnosis has been patched reactively** — three separate point-fixes nibbling at "why did this run fail" (#103 folded duration-vs-cap + `sdkTerminalStatus` + `recentEvents` into `get_workflow_run`; #105 added `StoreContentionError`; expose-cursor-watch-url added `watchUrl`). Each invents its own string. The pattern of one-off fixes IS the signal that the surface deserves a coherent design.

**Two audiences this design keeps distinct** (they get conflated, and they want different things):

| Audience | Question | Home |
|---|---|---|
| **A — operator/dev of ship** | "Why did ship-*the-tool* misbehave?" | structured app logging (L0) |
| **B — operator driving work** | "What happened in the agent *run*, and why did it fail?" | run diagnosis + cross-run stats (L1/L2) |

**Hypothesis:** a single structured-logging foundation plus one shared failure-classification primitive, threaded through ship's existing surfaces, turns reactive per-failure string-patching into a systematic "errors are always knowable" property — without ship becoming an APM platform.

**Non-goals (the boundary that keeps this a samurai-sword toolkit, not an observability product):**

- No external APM / OpenTelemetry exporters, no metrics-shipping, no tracing spans across services.
- No web dashboard. Ship is MCP + CLI; observability lives in those surfaces.
- No log ingestion/rotation/sink infrastructure. Ship emits clean JSON that *could* be ingested downstream; building the downstream is not ship's job.
- Token/cost usage tracking is a **separate axis** (cost, not correctness) — deferred (§10).

## 2. Functional & non-functional requirements

**Functional**

- FR1. A structured logger (JSON), available to every package, replacing the ~24 ad-hoc log sites.
- FR2. A typed `failure-category` enum classifying *why* a run reached a terminal failure, derived from signals ship already captures.
- FR3. The category is surfaced on the run-diagnosis surface (`get_workflow_run`) and carried as a field on the failure's log line — one source of truth.
- FR4. A failed run is fully diagnosable from the structured surfaces alone, with **no need to grep `events.ndjson`** — including the in-flight (never-completed) tool_call case the current `errorMessage` omits.
- FR5. (Stretch) Cross-run aggregates: failure-rate, failures-by-category, duration percentiles, near-cap rate.

**Non-functional**

| Property | Target |
|---|---|
| Protocol safety | Logs **never** touch stdout in the MCP-server process (JSON-RPC owns stdout). Logs → stderr (or a file). |
| Overhead | Logging adds negligible hot-path cost — pino-class (async, JSON, no string interpolation when below level). |
| Backpressure on existing surfaces | `events.ndjson` is unchanged; `result.json` / `CursorRunResult` gain `failureCategory` + a bounded failure detail (small — not a duplicate of the event stream). Logs are ship's *own* diagnostics. |
| Swappability | Logger sits behind a narrow interface; pino is the default impl, replaceable without touching call sites (operator's backend-interface convention). |
| Config | Level via `SHIP_LOG_LEVEL`; JSON in prod, pretty in a TTY/dev. |

## 3. Architecture overview

Two new primitives, both leaves in the dependency graph; everything else is wiring into surfaces that already exist.

```
            @ship/logger (NEW, leaf)            @ship/workflow (EXISTING leaf)
            interface + pino default            + failureCategorySchema (NEW enum)
                    │                                     │
        ┌───────────┼───────────┬───────────┐            │ consumed where runs reach terminal
     store     cursor-runner   core      mcp-server       │ classifyFailure() called in core's finalize (§4 D5)
        └───────────┴───────────┴───────────┘            │
                    │  log({category, workflowRunId, …})  │
                    ▼                                      ▼
                stderr (JSON)                  get_workflow_run.failureCategory
                                               errorMessage (category-prefixed)
                                               list_workflow_runs / ship stats (filter by category)
```

- **`@ship/logger`** — new leaf package. A narrow `Logger` interface + a pino-backed default. Consumed by `store`, `cursor-runner`, `core`, `mcp-server`, `cli`. No package depends *on* a consumer, so no cycles (mirrors `@ship/workflow`'s position).
- **`failure-category`** — a new enum in `@ship/workflow` (where the other shared domain enums live: `cursorRunStatusSchema`, `workflowStatusSchema`, …). One definition, three consumers (log field, run surface, stats filter). **This is the connective tissue** — defining it once is what makes the layers one story instead of three features.
- **The stdout/stderr split is load-bearing.** The MCP server speaks JSON-RPC over stdout; a stray log line there corrupts the protocol. Logs go to stderr. CLI *command output* (the `--json`-aware `process.stdout.write` in `cli/commands/*`) is **user output, not logging** — it stays on stdout, untouched.
- **Classification lives in `core`'s finalize, fed by the runner via `CursorRunResult`** — *not* at `cursor-runner`'s `mapErrorResult` (no store access) and *not* only at `finalizeFailure` (a failed `CursorRunResult` finalizes through `finalizeSuccess`). The shared `classifyFailure` is exported from `cursor-runner`; `core` calls it. See §4 D5 / §7.

## 4. Key decisions & trade-offs

**D1 — One shared `failure-category` enum, threaded through every surface.** *(load-bearing)*
The alternative is per-surface ad-hoc strings (status quo — what #103/#105 each did). One enum in `@ship/workflow` consumed by the log field, `get_workflow_run`, and the stats filter means a failure has *one* canonical classification everywhere. Cost: a small up-front taxonomy commitment (and enum churn if a new failure mode appears). Worth it — the whole point is to stop reinventing the error string.

**D2 — `@ship/logger` as a package, not a per-package module.** A shared package gives one logger config + one interface for all five consumers; a per-package module would duplicate config and drift. Cost: one more package in the monorepo. Accept — it's a leaf, matches the package-per-responsibility layout.

**D3 — Logger behind a narrow interface, pino as default impl.** Per the operator's backend-interface convention (intersection-of-capabilities). The interface exposes only `debug/info/warn/error({fields}, msg)` + `child(fields)`. Provider-specific pino features stay inside the impl. Cost: a thin indirection layer. Worth it for swappability + test fakes.

**D4 — pino over winston/bunyan.** pino is the closest Node analog to Go's zap: JSON-first, low-overhead, child loggers, async. winston is heavier and slower; bunyan is less maintained. Cost: pretty-printing is a separate transport (`pino-pretty`). Keep it a **devDependency** and gate pretty on **dev** (not bare TTY) — **production always emits JSON**, so the transport is never loaded at runtime where it isn't installed (codex @91).

**D5 — Classify in `core`'s finalize, fed a bounded diagnostic the runner attaches to `CursorRunResult`.** *(corrected per the #111 review — load-bearing)* v1 named `cursor-runner` `mapErrorResult` + `core` `finalizeFailure` as the classify/persist sites. The bots established that's wrong about ship's actual plumbing: (a) a *failed* `CursorRunResult` is finalized through **`finalizeSuccess`** (a failed result isn't a thrown error), not `finalizeFailure`; (b) `mapErrorResult` (cursor-runner) has **no store access** — the only handoff to `core` is `CursorRunResult`; (c) the **cloud** runner forwards events to `onEvent` but doesn't retain them, so cloud failures would have no signals to classify. Corrected: `classifyFailure` is a **pure function exported from `@ship/cursor-runner`** (where the SDK signal shapes live), **called by `core` at finalize** (where store access is) — `core` already depends on `cursor-runner` via `CursorRunResult`, so no new edge (claude §10 Q2). Both runners attach a **bounded diagnostic** (last-N events / `lastSdkStatus` / `cause`) to `CursorRunResult`; `core` runs `classifyFailure` over it, persists the category, and builds `errorMessage`. Cost: `CursorRunResult` + `result.json` grow a small diagnostic; one store column. Worth it — read paths stay cheap; category is stable across resume. **Both** `core` finalize paths call the classifier — `finalizeSuccess` (failed `CursorRunResult`) and `finalizeFailure` (thrown SDK/store error, no result), the primary path for `sdk-throw`/`contention` (codex @160). `core` passes `isStoreContention`/`thrownError` flags so `cursor-runner` needs no `@ship/store` dep (Copilot @163). And Phase 1 reclassifies cloud `EXPIRED` (today mapped to `cancelled`) as a failure so it reaches the classifier (codex @168 / claude) — a behavioral change, see §7.

## 5. Data model

- **`@ship/workflow`:** `failureCategorySchema = z.enum(["contention", "timeout-near-cap", "agent-collapse-on-running-tool", "sdk-throw", "logic", "unknown"])`. **`cancelled` is intentionally NOT here** (review consensus — codex/Copilot/cursor): cancellation is already `run.status === "cancelled"`, finalized on the success/cancelled path, and never reaches the failure classifier — including it made the contract ambiguous and would never be assigned. `unknown` is the honest fallback when no signal classifies. Persisted in SQLite → literals are **tombstones**: never rename/delete one, only add (mirrors `phaseKindSchema`), so historical rows keep hydrating (Copilot @99).
- **`CursorRunResult` + `result.json`:** gain `failureCategory?` **and** a bounded `failureDetail?` (last-activity / errorMessage summary). This is the runner→core handoff that lets `core` persist the category and answer *why* without re-reading `events.ndjson`. (v1 wrongly said `result.json` was unchanged — codex.)
- **Store:** a **new nullable `failure_category` column** on the finalize-target row (claude §10 Q1 — a column, not a JSON blob, so Phase-3 stats can filter/aggregate in SQL), set at finalize. A migration; the startup-schema-skew guard from #100 covers the upgrade path.
- **`@ship/logger`:** no persisted model — it writes to stderr. `LogFields` (`{ workflowRunId?, cursorRunId?, phase?, failureCategory?, … }`) is the structured-field convention, not a stored entity.
- **Unchanged:** `events.ndjson` (agent run-event stream) keeps its shape — the new diagnostic is a *bounded summary* on `result.json`, not a duplicate of the stream.

## 6. API contract

**Logger interface (`@ship/logger`):**

```ts
export interface Logger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
  child(fields: LogFields): Logger; // bind run-scoped context once
}
export interface LogFields {
  readonly workflowRunId?: string;
  readonly cursorRunId?: string;
  readonly phase?: string;
  readonly failureCategory?: FailureCategory;
  readonly [k: string]: unknown;
}
export function createLogger(opts?: { level?: string; pretty?: boolean; stream?: NodeJS.WritableStream }): Logger;
```

- Default `level` from `SHIP_LOG_LEVEL` (fallback `info`); `pretty` auto-on for a TTY; `stream` defaults to `process.stderr`.
- The MCP-server + CLI entrypoints construct the logger with `stream: process.stderr` explicitly and pass it down (DI), so no module ever reaches for stdout.

**Run-diagnosis surface (`get_workflow_run`, extends `@ship/mcp` `getWorkflowRunOutputSchema`):**

```ts
failureCategory?: FailureCategory;   // present on failed runs; absent otherwise
// (existing post-#103 fields stay: runDurationMs, maxRunDurationMs, sdkTerminalStatus, recentEvents, watchUrl)
```

**Classifier — pure function in `@ship/cursor-runner`, exported; called by `core`'s finalize:**

```ts
function classifyFailure(input: {
  sdkTerminalStatus?: string;     // raw SDK status, ANY case — normalized internally
  isStoreContention?: boolean;    // set by `core` (it catches StoreContentionError) — keeps cursor-runner free of an @ship/store dep (Copilot @163)
  thrownError?: boolean;          // true when the failure is a thrown SDK error (reject path) → sdk-throw
  durationMs?: number;            // matches CursorRunResult.durationMs (NOT the get_workflow_run output field `runDurationMs`) (Copilot @151)
  maxRunDurationMs?: number;
  events: readonly SDKMessage[];  // bounded window; empty array is valid → may yield `unknown` (total)
}): FailureCategory;
```

- **Total**: every failed run maps to a category; empty `events` is valid input and yields `unknown` — never `undefined`/throw.
- **No `cause`/`isCancelled` in the signature** (claude): `core` owns both guards — it catches `StoreContentionError` and sets `isStoreContention` (so `cursor-runner` never imports `@ship/store`), and it pre-screens cancellation, so `classifyFailure` is **never called for a cancelled run** (Option A) and has no `cancelled` return.
- **Normalize `sdkTerminalStatus` internally** (`.toLowerCase()`): local persists lower-case `"error"`, cloud emits `"ERROR"`/`"EXPIRED"`.

**Runner→core handoff (`CursorRunResult`):** gains `failureCategory?` + bounded `failureDetail?`. The **cloud** runner must retain a bounded event window — the local runner already keeps a 256-event ring buffer; `mapCloudRunResult` currently passes none (codex @138, claude).

**(Stretch) stats surface:** either a new `ship stats` CLI / `get_run_stats` MCP read, or a `failureCategory` filter on `list_workflow_runs`. Defined in the phase-3 doc when it unblocks.

## 7. Key flows

**Failure classification (the load-bearing path):**

1. A run finishes failed via one of **two** finalize paths — **both must classify** (codex @160):
   - **`finalizeSuccess`** — a *failed* `CursorRunResult` resolved normally (the dominant agent-failure path). `core` runs `classifyFailure` over the result's bounded diagnostic.
   - **`finalizeFailure`** — a *thrown* SDK or store error with **no** `CursorRunResult` (`Agent.create`/`send` rejects, a `StoreContentionError`). `core` calls `classifyFailure` with `{ thrownError: true }` and/or `{ isStoreContention: true }` (set when it caught the error). This is the **primary** path for `sdk-throw` and `contention`.
2. `classifyFailure` maps signals → a category, priority order (status compared **case-insensitively**):
   - `isStoreContention` → `contention`.
   - `thrownError` → `sdk-throw`. For cloud setup/provisioning failures, `failureDetail` carries the `stage` from `cloud-runner`.
   - latest **failed `tool_call`** in the window → `logic` (keep #103's detail). **Scan for the latest *failed tool_call*, not literally the last event** — a trailing `status:ERROR` is normal and must not mask it (#103 parity).
   - no error event **but** a `tool_call` stuck `running` with `durationMs > 0.8 × maxRunDurationMs` AND last-running-tool age > 30s → `agent-collapse-on-running-tool`; `failureDetail` = `…last activity: shell 'make check' running 4m12s, never completed`.
   - status normalizes to `expired` **or** `durationMs ≥ 0.95 × maxRunDurationMs` → `timeout-near-cap`.
   - otherwise → `unknown`.
   Cancellation never reaches here — `core` pre-screens it (handled on the success/cancelled path), so there's no `cancelled` category and no ordering ambiguity.
3. `core` persists the category (new column) + builds `errorMessage = "<category prefix>; <failureDetail>"`. The bounded `failureDetail` ships in **Phase 1** so the gate holds for `logic`/`sdk-throw`/`unknown` (see §9).
4. Emit one structured log line: `log.error({ workflowRunId, cursorRunId, failureCategory, durationMs }, "run failed")`.

> **Cloud `EXPIRED` is a behavioral change, not just a new field (codex @168 / claude).** `cloud-runner.ts` currently maps an `EXPIRED` SDK result to `mapTerminalResult(…, "cancelled")` → `core` finalizes it on the success/cancelled path, so it never reaches the classifier. Phase 1 must **reclassify cloud `EXPIRED` as a failure** (route it through `mapErrorResult`) so it lands `timeout-near-cap`.

**Read path:** `get_workflow_run` returns the persisted `failureCategory` + `errorMessage` (no re-derivation). `ship diagnose <wf>` (Phase 2) prints category + duration-vs-cap + last activity + watchUrl.

**Logging hot path:** a call below the configured level is a near-noop (pino guards before serializing). Run-scoped context (`workflowRunId`, etc.) is bound once via `log.child(...)` at run start so every line carries it without repetition.

## 8. Failure / safety model

- **Logging must never throw into business logic.** The logger swallows its own write errors — mirrors the existing `try/catch` around `[ship-cloud-*]` writes.
- **stdout protection is a hard invariant.** Assert it by **extending the existing stdio integration suite** (`e2e/integration/mcp-server.integration.test.ts`, which already connects over stdio and would fail on any non-JSON-RPC stdout line — Copilot @180): add an assertion that every stdout line is valid JSON-RPC. Stronger than a unit assert on the logger's stream — it catches a `console.log` from any transitive dependency. No new harness needed.
- **CLI user-facing error exits stay as-is.** The `process.stderr.write(err.message)` + `process.exit(1)` sites in `cli/commands/*` are user-facing error output, **not** diagnostics — the §9 migration explicitly excludes them (claude).
- **Classifier is total** — every terminal failure maps to *some* category (`unknown` is the catch-all); it never throws and never returns undefined; empty `events` is valid input.

## 9. Rollout / implementation plan

Breadth now, depth (per-task specs) just-in-time. **Validation gate after Phase 1.**

| Phase | Goal | High-level tasks | Depends on | Gate |
|---|---|---|---|---|
| **1 — logging foundation + category primitive** | Structured logging everywhere + the shared enum + the classify/persist path | (a) `@ship/logger`: `Logger` interface + pino impl + config (`SHIP_LOG_LEVEL`, stderr default, pretty-in-TTY, `redact`-ready); (b) `failureCategorySchema` in `@ship/workflow` + `classifyFailure` (exported from `cursor-runner`) called in `core`'s finalize — persists the category **and a bounded `failureDetail`**, populated for local + cloud; (c) migrate the ~24 ad-hoc sites to `@ship/logger` (**excluding** CLI user-facing error exits) | — | **VALIDATION GATE** |
| **2 — run diagnosis surface** | A failed run is fully diagnosable from structured surfaces; closes the feedback task | thread `failureCategory` into `get_workflow_run` + `errorMessage`; in-flight-tool-call fallback (closes `tsk_01KT3CYEFSM41WS3VEQM5NMG0K`); `ship diagnose <wf>` CLI | Phase 1 | gated |
| **3 — cross-run stats (stretch)** | Patterns across runs, not just single-run forensics | failure-rate / by-category / p50-p95 duration / near-cap rate; `ship stats` or `list_workflow_runs` category filter | Phase 1 + 2 | gated |

**Validation gate (after Phase 1):** the next real failed run is diagnosable from the persisted `failureCategory` + bounded `failureDetail` (in the log line + `result.json`) **alone** — no `events.ndjson` grep to know *why*. The bounded detail ships in Phase 1 precisely so the gate holds for `logic`/`sdk-throw`/`unknown` too (codex @158); the *richer* `get_workflow_run`/`ship diagnose` surface is still Phase 2. If the gate holds, Phases 2/3 are worth it; if the taxonomy proves insufficient in practice, revise before investing further.

**Per-phase scope (weighted-LOC bands, repo budget <700 ideal):** Phase 1 splits into ~3 PRs (logger package ~amazing; enum+classifier ~amazing; site migration ~ideal). Phases 2/3 sized when they unblock.

## 10. Resolved questions (from the #111 review)

All four v1 open questions were resolved in the design review:

1. **Category persistence → new nullable `failure_category` column** (not a JSON blob) so Phase-3 stats filter/aggregate in SQL (claude). §5.
2. **Classifier home → `@ship/cursor-runner`, exported, called by `core`'s finalize** — no new dependency edge (`core` already depends on `cursor-runner`), and it sits where the SDK signals are while `core` owns persistence (claude). §4 D5 / §6.
3. **Token/cost axis → deferred** as its own TDD; orthogonal to correctness observability.
4. **Thresholds defined** (claude / Copilot @167): `agent-collapse-on-running-tool` = `durationMs > 0.8 × maxRunDurationMs` AND last-running-`tool_call` age > 30s (percentage + absolute floor, so short dev caps don't false-positive); `timeout-near-cap` = `durationMs ≥ 0.95 × maxRunDurationMs` with no running-tool signal.

**Cycle-2 pins (resolved in v3):**

5. **Both finalize paths classify** — `finalizeSuccess` (failed result) **and** `finalizeFailure` (thrown error, no result); the latter is the primary path for `sdk-throw`/`contention` (codex @160). §4 D5 / §7.
6. **Cloud `EXPIRED` reclassified as a failure** (route through `mapErrorResult`, not `→ cancelled`) so it reaches the classifier — a Phase-1 behavioral change (codex @168 / claude). §7.
7. **Dep direction** — `core` passes `isStoreContention`/`thrownError` flags; `cursor-runner` imports no `@ship/store` (Copilot @163). **`isCancelled` contract — Option A**: `core` pre-screens cancellation, `classifyFailure` is never called for a cancelled run (claude). §6.
8. **Persistence uses `durationMs`** (matches `CursorRunResult`); the `get_workflow_run` output field stays `runDurationMs` (Copilot @151). `failure_category` literals are tombstones (Copilot @99). `pino-pretty` stays a devDep; prod is JSON-only (codex @91).

Remaining genuinely-open: none blocking Phase 1. The cloud bounded-event-window size is a Phase-1 impl detail (a small N; tune if it misses signals).

## 11. Validation plan

The Phase-1 gate is the binary signal: **take the next failed ship run and answer "why did it fail?" from the persisted `failureCategory` + bounded `failureDetail` alone** (log line + `result.json`). Pass = no `events.ndjson` grep required and the category is correct. That flips go/no-go on Phases 2–3. Secondary: the stdout-purity assertion added to the existing `e2e/integration/mcp-server.integration.test.ts` passes (no JSON-RPC corruption), and `make check` (incl. coverage) stays green through the site migration.
