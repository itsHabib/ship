# Observability — Technical Design Document

**Status:** draft / proposal — NOT a build commitment. The artifact we decide from.
**Owner:** @michael
**Date:** 2026-06-02
**Related:** dossier project `ship` (`prj_01KRAE24JC3JCZPNHQQQWGKFY1`); prior point-fixes [#103](https://github.com/itsHabib/ship/pull/103) (surface-failed-run-diagnostics), [#105](https://github.com/itsHabib/ship/pull/105) (ship-store-write-contention); feedback task `failed-run-errormessage-omits-inflight-tool-call` (`tsk_01KT3CYEFSM41WS3VEQM5NMG0K`).

> **Reviewers — focus areas:**
> - §4 D1 (one shared `failure-category` enum threaded through every surface) — the load-bearing decision.
> - §4 D2 (`@ship/logger` as a leaf package vs a module) and D4 (pino choice).
> - §7 the failure-classification flow — does the category mapping cover the real terminal states?
> - §3 the stdout/stderr split — getting this wrong corrupts the MCP protocol.

## 1. Problem & hypothesis

Ship's whole job is **"fire an agent, then know what it did and why it failed."** Observability isn't a side-feature here — it's roughly half the product. Yet today:

- **No structured logging.** ~24 ad-hoc sites: `console.warn` in `store/db.ts` + `store/store.ts`; `process.stderr.write("[ship-cloud-warn|error|debug] …")` in `cursor-runner`; bare `process.stderr.write(err.message)` in `core/service.ts` + `mcp-server/bin.ts`. No logger library, no logger module. When ship itself misbehaves, there's no queryable trail.
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
| Backpressure on existing surfaces | `events.ndjson` and `result.json` are unchanged; logs are ship's *own* diagnostics, not a duplicate of the agent event stream. |
| Swappability | Logger sits behind a narrow interface; pino is the default impl, replaceable without touching call sites (operator's backend-interface convention). |
| Config | Level via `SHIP_LOG_LEVEL`; JSON in prod, pretty in a TTY/dev. |

## 3. Architecture overview

Two new primitives, both leaves in the dependency graph; everything else is wiring into surfaces that already exist.

```
            @ship/logger (NEW, leaf)            @ship/workflow (EXISTING leaf)
            interface + pino default            + failureCategorySchema (NEW enum)
                    │                                     │
        ┌───────────┼───────────┬───────────┐            │ consumed where runs reach terminal
     store     cursor-runner   core      mcp-server       │ (cursor-runner mapErrorResult, core finalizeFailure)
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

## 4. Key decisions & trade-offs

**D1 — One shared `failure-category` enum, threaded through every surface.** *(load-bearing)*
The alternative is per-surface ad-hoc strings (status quo — what #103/#105 each did). One enum in `@ship/workflow` consumed by the log field, `get_workflow_run`, and the stats filter means a failure has *one* canonical classification everywhere. Cost: a small up-front taxonomy commitment (and enum churn if a new failure mode appears). Worth it — the whole point is to stop reinventing the error string.

**D2 — `@ship/logger` as a package, not a per-package module.** A shared package gives one logger config + one interface for all five consumers; a per-package module would duplicate config and drift. Cost: one more package in the monorepo. Accept — it's a leaf, matches the package-per-responsibility layout.

**D3 — Logger behind a narrow interface, pino as default impl.** Per the operator's backend-interface convention (intersection-of-capabilities). The interface exposes only `debug/info/warn/error({fields}, msg)` + `child(fields)`. Provider-specific pino features stay inside the impl. Cost: a thin indirection layer. Worth it for swappability + test fakes.

**D4 — pino over winston/bunyan.** pino is the closest Node analog to Go's zap: JSON-first, low-overhead, child loggers, async. winston is heavier and slower; bunyan is less maintained. Cost: pino's pretty-printing is a separate transport (`pino-pretty`) — a dev dependency.

**D5 — Classify at the point a run reaches terminal, not by re-parsing later.** The classifier runs where the terminal signal is freshest — `cursor-runner` `mapErrorResult` / `core` `finalizeFailure` — and persists the category, rather than re-deriving it from `events.ndjson` on every read. Cost: a store column (or reuse of an existing diagnostics field). Worth it — read paths stay cheap and the category is stable across resume.

## 5. Data model

- **`@ship/workflow`:** `failureCategorySchema = z.enum(["contention", "timeout-near-cap", "agent-collapse-on-running-tool", "sdk-throw", "cancelled", "logic", "unknown"])`. `unknown` is the honest fallback when no signal classifies (never silently mis-bucket).
- **Store:** persist the category on the failed run. Prefer extending the existing failure-diagnostics surface (#103 already added run-diagnostics fields) over a brand-new table — likely one nullable `failure_category` column on the run/cursor-run row, set at finalize. (A migration; the startup-schema-skew guard from #100 covers the upgrade path.)
- **`@ship/logger`:** no persisted model — it writes to stderr. A `LogFields` shape (`{ workflowRunId?, cursorRunId?, phase?, failureCategory?, … }`) is the structured-field convention, not a stored entity.
- **Unchanged:** `events.ndjson` (agent run-event stream) and `result.json` (per-run terminal snapshot) keep their current shapes. Logs are additive and separate.

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

**Classifier (`@ship/cursor-runner` or `@ship/core`):**

```ts
function classifyFailure(input: {
  sdkTerminalStatus?: string;        // "ERROR" | "EXPIRED" | …
  runDurationMs?: number; maxRunDurationMs?: number;
  events: readonly SDKMessage[];     // for the in-flight / error-bearing tool_call
  cause?: unknown;                   // StoreContentionError, thrown SDK error
}): FailureCategory;
```

**(Stretch) stats surface:** either a new `ship stats` CLI / `get_run_stats` MCP read, or a `failureCategory` filter on `list_workflow_runs`. Defined in the phase-3 doc when it unblocks.

## 7. Key flows

**Failure classification (the load-bearing path):**

1. A run reaches terminal failure in `cursor-runner` (`mapErrorResult`) or `core` (`finalizeFailure`).
2. `classifyFailure` maps the signals → a category, in priority order:
   - `cause instanceof StoreContentionError` or SQLite-busy text → `contention`.
   - a thrown SDK error (reject path) → `sdk-throw`.
   - `sdkTerminalStatus === "CANCELLED"` → `cancelled`.
   - last event is an **error-bearing** `tool_call` → keep #103's detail; category `logic` (agent hit a real error).
   - no error event **but** a tool_call stuck `running` near the cap → `agent-collapse-on-running-tool` (the feedback-task case: a long `make check` outran the agent). Surface `…last activity: shell 'make check' running 4m12s, never completed`.
   - `durationMs` within ε of `maxRunDurationMs`, no other signal → `timeout-near-cap`.
   - otherwise → `unknown`.
3. Persist the category; build `errorMessage` from it (the category gives the prefix, the detail gives the specifics).
4. Emit one structured log line at the failure site: `log.error({ workflowRunId, cursorRunId, failureCategory, durationMs }, "run failed")`.

**Read path:** `get_workflow_run` returns the persisted `failureCategory` (no re-derivation). `ship diagnose <wf>` (phase 2) prints category + duration-vs-cap + last activity + watchUrl — the whole picture, no `events.ndjson` grep.

**Logging hot path:** a call below the configured level is a near-noop (pino guards before serializing). Run-scoped context (`workflowRunId`, etc.) is bound once via `log.child(...)` at run start so every line carries it without repetition.

## 8. Failure / safety model

- **Logging must never throw into business logic.** The logger swallows its own write errors (a failed diagnostic write can't fail a run) — mirrors the existing `try/catch` around `[ship-cloud-*]` writes.
- **stdout protection is a hard invariant**, asserted by a test: in the MCP-server process, nothing writes to stdout except the JSON-RPC transport. The logger's default stream is stderr; the assertion guards against regressions.
- **Classifier is total** — every terminal failure maps to *some* category (`unknown` is the catch-all); it never throws and never returns undefined for a failed run.

## 9. Rollout / implementation plan

Breadth now, depth (per-task specs) just-in-time. **Validation gate after Phase 1.**

| Phase | Goal | High-level tasks | Depends on | Gate |
|---|---|---|---|---|
| **1 — logging foundation + category primitive** | Structured logging everywhere + the shared enum defined | (a) `@ship/logger` package: `Logger` interface + pino impl + config (`SHIP_LOG_LEVEL`, stderr default, pretty-in-TTY); (b) `failureCategorySchema` in `@ship/workflow` + `classifyFailure` at the terminal sites; (c) migrate the ~24 ad-hoc sites to `@ship/logger`, emitting `failureCategory` on failure lines | — | **VALIDATION GATE** |
| **2 — run diagnosis surface** | A failed run is fully diagnosable from structured surfaces; closes the feedback task | thread `failureCategory` into `get_workflow_run` + `errorMessage`; in-flight-tool-call fallback (closes `tsk_01KT3CYEFSM41WS3VEQM5NMG0K`); `ship diagnose <wf>` CLI | Phase 1 | gated |
| **3 — cross-run stats (stretch)** | Patterns across runs, not just single-run forensics | failure-rate / by-category / p50-p95 duration / near-cap rate; `ship stats` or `list_workflow_runs` category filter | Phase 1 + 2 | gated |

**Validation gate (after Phase 1):** the next real failed run is diagnosable from the structured log line + persisted category **alone** — no `events.ndjson` grep needed to know *why*. If that holds, Phase 2/3 are worth it; if the category taxonomy proves wrong/insufficient in practice, revise it before investing in the richer surfaces.

**Per-phase scope (weighted-LOC bands, repo budget <700 ideal):** Phase 1 splits into ~3 PRs (logger package ~amazing; enum+classifier ~amazing; site migration ~ideal). Phases 2/3 sized when they unblock.

## 10. Open questions

1. **Category persistence home** — a new `failure_category` column, or fold into the existing #103 diagnostics field? Leaning column (queryable for Phase 3 stats). Reviewer call.
2. **Classifier package** — does `classifyFailure` live in `cursor-runner` (closest to the SDK signals) or `core` (closest to the workflow finalize)? Both terminal sites need it; likely a small shared helper in `cursor-runner` consumed by `core`.
3. **Token/cost axis (L3)** — explicitly deferred. Revisit as its own TDD if cloud-cost visibility becomes a priority; it's orthogonal to correctness observability.
4. **`agent-collapse-on-running-tool` threshold** — what counts as "near the cap" / "stuck running long enough"? Needs a concrete heuristic (e.g. last running tool_call with no completion + run within N% of cap). Pin in the Phase-2 task.

## 11. Validation plan

The Phase-1 gate is the binary signal: **take the next failed ship run and answer "why did it fail?" from the structured log line + `failureCategory` alone.** Pass = no `events.ndjson` grep required and the category is correct. That single check flips go/no-go on Phases 2–3. Secondary: the stdout-protection test passes (no MCP-protocol corruption), and `make check` (incl. coverage) stays green through the site migration.
