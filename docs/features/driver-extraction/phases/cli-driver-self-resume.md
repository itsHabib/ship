# CLI driver self-resume — the driver tick re-attaches its own orphaned cloud runs

**Status:** ready · **Owner:** work-driver:michael · **Date:** 2026-06-13
**Repo:** itsHabib/ship · **Scope budget:** ~150 weighted LOC (source 1.0× + tests 0.5×)

## Problem

#137 made cloud orphan-resume opt-in (default off) to stop a read-only sibling
process — e.g. a keyless `ship driver status` poll — from adopting and failing
another process's live cloud runs. Only the long-lived `@ship/mcp-server` bin
opts in. The **CLI driver does not**, which silently broke the driver's cloud
kill+resume story:

- A CLI `ship driver run` dispatches a cloud stream; that tick's in-process
  event pump keeps the run's store row fresh.
- Kill the tick mid-flight (the validation-gate criterion). The pump dies; the
  cloud agent keeps working; the store row freezes at `running`.
- Re-run `ship driver run`. The new tick constructs its `ShipService` with
  `resumeOrphans` defaulting to **false**, so it never re-attaches the orphaned
  cloud run. The engine polls `getRun`, sees the frozen row, never reaches
  terminal — the stream is stranded `dispatched` until `--max-wait` expires.

Before #137 the CLI always swept on construction (that *was* the multi-process
bug), so this used to work. #137 correctly fixed the bug but left the driver's
cloud resume off. This phase puts it back — scoped to the driver only.

## Fix

`createCliDriverService` builds its **own** resume-enabled `ShipService`
(`createCliService({ ...opts, resumeOrphans: true })`) instead of reusing the
plain-command ship factory. The plain CLI commands (`list`, `status`, `get`,
`ship`, `cancel`) keep their resume-off service, so a read command still never
adopts a sibling's live run — the #137 guarantee holds. Both services share the
`Store` and `activeRuns` registry via the dbPath-keyed shared infra
(`getOrCreateSharedInfra`), so dispatch and cancel still observe one in-flight
state across the two instances.

This reverts P4's "take an external `shipFactory`" signature (#134) for a
concrete reason that didn't exist then: the driver and the plain commands now
need **different resume policy**, so they must be distinct `ShipService`
instances. The composition still shares everything that matters (store +
activeRuns); only the encapsulated resume flag differs.

## Engineering decisions

- **ED-1: policy lives in the driver's CLI wiring, not the entrypoint.**
  `createCliDriverService` owns "the driver resumes"; `bin.ts` and every test
  harness just call `createCliDriverService(opts)`. Centralizing it keeps the
  flag from being re-derived at each call site and makes every caller exercise
  the real wiring.
- **ED-2: always-on for the driver, not configurable.** The driver's entire
  purpose is to survive a kill and continue; there is no driver mode that
  shouldn't resume. No new config surface (operator preference: no premature
  config).
- **ED-3: the mcp-server asymmetry is intentional.** `createMcpDriverServiceFactory`
  still takes the server's ship factory because in that single long-lived
  process *everything* resumes (the bin sets `resumeOrphans: true` globally).
  The CLI is a mix of short-lived commands where only the driver should resume,
  so the CLI driver needs its own instance.

## Tradeoffs / known behavior

- **Resume waits out the staleness window (~5 min), by design.** A re-run tick
  within `ORPHAN_RESUME_STALENESS_MS` of the kill sees the orphan as still
  "fresh" and skips it (the guard that protects live sibling runs). The stream
  resumes on a re-tick after the window. Instant self-resume — the driver
  re-attaching *its own* streams by positive manifest ownership rather than the
  generic staleness heuristic — is a future refinement, deliberately out of
  scope here (keep the step small).

## Validation

- **Wiring test (new):** a CLI-layer test seeds a terminal-parent cloud orphan
  (staleness-exempt) and asserts the resume-enabled ship — the exact instance
  `createCliDriverService` builds — reconciles it, while the default
  (resume-off) ship leaves it. This pins the flag plumbing through the
  production default-wiring path at the one layer where the ship's background
  sweep is drainable.
- **Mechanism:** the staleness-gated *running*-orphan re-attach and every other
  branch stay covered by the `@ship/core` `resumeOrphanedRuns` suite — behavior
  unchanged by this PR; only the opt-in caller moved.
- **Testability note:** the staleness-gated re-attach is not unit-testable above
  `createShipService` because the production wiring hardcodes the clock
  (`getOrCreateSharedInfra`). The live validation gate is its integration proof.
- `make check` green (typecheck + lint + format + tests, ubuntu + windows).

## Out of scope

- Instant driver self-resume by manifest ownership (future refinement above).
- CLI honoring `SHIP_DB_PATH` (separate friction).
- Any change to the mcp-server driver wiring or the core resume mechanism.

## Implementation plan

1. `createCliDriverService(opts)`: build an internal resume-enabled ship
   factory; drop the external `shipFactory` parameter.
2. Update the three call sites (`bin.ts`, `driver-disk-harness.ts`, the e2e
   driver harness) to the one-arg form.
3. Add the wiring test (terminal-parent reconcile via the resume-enabled ship).

## PR

Title: `fix(cli): driver tick resumes its own orphaned cloud runs (opt the driver into staleness-guarded resume)`. Body: reference #137 (made resume opt-in) and the validation gate that needs this.
