# Driver tick self-resume — a `run` tick re-attaches its own orphaned cloud runs

**Status:** ready · **Owner:** work-driver:michael · **Date:** 2026-06-13
**Repo:** itsHabib/ship · **Scope budget:** ~120 weighted LOC (source 1.0× + tests 0.5×)

## Problem

#137 made cloud orphan-resume opt-in (default off) so a read-only sibling
process — e.g. a keyless `ship driver status` poll — can no longer adopt-and-fail
another process's live cloud runs. Only the long-lived `@ship/mcp-server` bin
opts in. That silently broke the driver's cloud kill+resume: a re-run
`ship driver run` tick constructs a resume-off `ShipService`, never re-attaches
its own orphaned cloud run after a kill, and the stream strands `dispatched`
until `--max-wait` expires. Before #137 the CLI always swept on construction
(that *was* the multi-process bug); #137 fixed the bug but left the driver's
resume off.

## Fix

Resume is a property of the **tick**, not of service construction. The driver
engine's `run` invokes the ship's `resumeOrphanedRuns` as its first step, then
runs the dispatch/poll tick. The poll loop (or the caller's re-invocation)
harvests the re-attached result. Concretely:

- `DriverShipPort` gains an optional `resumeOrphanedRuns?: () => Promise<void>`
  (the real `ShipService` already exposes it; engine L1 fakes may omit it).
- `DriverService.run` fires it fire-and-forget at tick entry. Fire-and-forget
  keeps the tick inside its `maxWaitMs` bound — the staleness-guarded re-attach
  lands in this poll window or the next re-invocation, rather than blocking the
  tick on an unrelated still-streaming orphan.

This scopes resume precisely to ticks and covers **both** callers (the CLI
`ship driver run` and the MCP `driver_run` tool) through the one `run` path. The
read verbs — `status`, `render`, `decide`, `mark-merged`, `cancel`, `import` —
never sweep, so #137's read/write separation holds. No CLI wiring change is
needed: `createCliDriverService` keeps its #134 shape (shares the plain ship
factory); the ship's `resumeOrphanedRuns` method works on demand regardless of
the construction-time opt-in flag.

## Engineering decisions

- **ED-1: resume belongs in the tick, not construction.** Construction-time
  resume fires for whichever verb happens to construct the service first — that
  is exactly the read/write leak codex flagged (a `status` poll would sweep).
  The tick is the one operation that polls in-flight work, so it owns recovery.
- **ED-2: fire-and-forget, not await.** A tick is bounded by `maxWaitMs`;
  awaiting a DB-wide re-attach (which blocks until each orphan reaches terminal)
  could exceed that bound or hang on an unrelated process's still-streaming
  orphan. Firing it lets the existing poll/re-invoke loop observe the harvested
  row, consistent with the bounded-tick contract.
- **ED-3: optional port method.** `resumeOrphanedRuns?` is optional so the
  engine's existing L1 fakes need no change and the `run` path tolerates a port
  without it (covered by a test). Production always provides it.

## Tradeoffs / known behavior

- **Resume waits out the staleness window (~5 min), by design.** A re-tick
  within `ORPHAN_RESUME_STALENESS_MS` of the kill sees the orphan as "fresh" and
  skips it (the guard that protects live sibling runs); it resumes on a re-tick
  after the window. Instant self-resume — the driver re-attaching *its own*
  streams by positive manifest ownership rather than the generic staleness
  heuristic — is a future refinement, deliberately out of scope.
- The sweep is DB-wide (re-attaches any stale orphan, not only this driver
  run's streams). Acceptable: a tick is a mutating, progress-making operation;
  harvesting other stale orphans is harmless and idempotent.

## Validation

- **Driver test (new):** `run` invokes `port.resumeOrphanedRuns` while the read
  verbs (`render`, `getDriverRun`) do not — asserted via the fake port's call
  log. Plus a test that `run` tolerates a port without `resumeOrphanedRuns`.
- **Mechanism:** the staleness-gated re-attach and every other branch stay
  covered by the `@ship/core` `resumeOrphanedRuns` suite (behavior unchanged;
  this PR only adds a caller). It is not unit-testable above `createShipService`
  because production wiring hardcodes the clock — the live validation gate is its
  integration proof.
- `make check` green (typecheck + lint + format + tests, ubuntu + windows).

## Out of scope

- Instant driver self-resume by manifest ownership (future refinement above).
- CLI honoring `SHIP_DB_PATH` (separate friction).
- Any change to the core resume mechanism or the mcp-server boot/periodic sweep.

## Implementation plan

1. `DriverShipPort`: add optional `resumeOrphanedRuns`.
2. `DriverService.run`: fire it at tick entry (fire-and-forget, errors swallowed
   — the ship logs per-orphan attach failures internally).
3. Fake ship port: record `resumeOrphanedRuns` calls for the test.
4. Driver service test: run-resumes / read-verbs-don't + tolerates-absent-method.

## PR

Title: `fix(driver): a run tick re-attaches its own orphaned cloud runs`. Body:
reference #137 (made resume opt-in) and the validation gate that needs this;
note read verbs stay sweep-free (the codex read/write-separation point).
