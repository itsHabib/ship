**Status**: ready for impl — P3 merged as #131 (squash `798612b`); §"P3 surface consumed" verified against the merged exports
**Owner**: @michael
**Date**: 2026-06-12
**Related**: dossier task `driver-cli-mcp-surface` (id: `tsk_01KTWZEZ2BYB4G17A5QCWF9SKK`); locked design [docs/features/driver-extraction/spec.md](../spec.md) — §6 (CLI/MCP contract), §9 P4, §11. Depends on P3 [driver-engine-loop.md](driver-engine-loop.md).

# @ship/driver brain-facing surface — 7 CLI subverbs + 3 MCP tools + fake-cursor e2e

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/cli/src/commands/driver.ts` (7 subverbs via `registerXCommand`, ~260), `@ship/mcp` zod schemas (~80), `packages/mcp-server` tool registrations (~90), wiring (~30) | ~460 | 460 |
| Tests | CLI arg/exit-code L1 (~180), MCP schema round-trips (~80), fake-cursor e2e scenarios (~280) | ~540 | 270 |
| Configs / docs | this doc, package.json edges, lockfile | — | 0 |
| **Total** | | | **~730 — just over ideal; acceptable, no split** |

No-split note: the e2e scenarios are the phase's acceptance and exercise both surfaces; CLI-only would merge unproven. If implementation busts past ~850 weighted, the permissible seam is MCP tools + their schemas as a fast-follow PR (CLI + e2e must stay together).

## Goal

P3's engine is library-only. This phase gives the two brains their hands: CLI verbs for the interactive session (and later the Managed-Agent session — same wrapper, §1) and MCP tools for in-process callers. Ends at the **validation gate** (§11.2): after this merges, the next session drives one real ≥2-stream cloud batch via `ship driver run` — go/no-go for P5.

## P3 surface consumed

From `@ship/driver` (P3, verified against #131's merged `src/index.ts`): `createDriverService({ store, ship })` (`ship` is a `DriverShipPort` — `@ship/core`'s `ShipService` satisfies it), `DriverService`, `DriverRunRef`, `RunOpts`, `Decision`, `MergeFacts`, `DriverTickResult`, `JudgmentRequest`, and the typed errors `TickLiveError` / `PreconditionError` / `DecideError` / `CancelError` / `DriverRunNotFoundEngineError` / `ImportManifestError` — map ALL of these to exit 1 with their messages; they are the engine-error channel (§4.1). Note: `DriverService.run` and `cancel` are async; `decide`/`markMerged`/`render` are sync.

## Behavior

### 1. CLI — `ship driver <subverb>` (spec §6 verbatim)

Registered via the existing `registerXCommand(program, factory)` pattern; same `SHIP_DB_PATH` / `SHIP_RUNS_DIR` resolution and service construction as the existing commands; `SHIP_TEST_FAKE_CURSOR=1` flows through the runner seam untouched.

```
ship driver import <driver.md>                          → { driverRunId }
ship driver run    <driver.md | drv_id> [--batch N] [--json]
                   [--max-wait 20m] [--poll-interval 30s] [--force]
ship driver decide <drv_id> --stream <ds_id> <retry|skip|abort> [--reason "..."]
ship driver decide <drv_id> --stream <ds_id> adopt --workflow-run <wf_id>
ship driver mark-merged <drv_id> --stream <ds_id> --pr <n> --sha <sha> [--merged-at <iso>] [--cycles <n>]
ship driver cancel <drv_id>
ship driver render <drv_id> [--out <path>]
ship driver status <drv_id> [--json]
```

- **Exit codes are the contract (§4.1):** `0` = done/progress/blocked_on_merges (the brain reads `status` to distinguish), `10` = awaiting_judgment, `1` = engine error. Pin all three in tests; `blocked_on_merges` is exit 0 (it's a normal pause for policy work, not a judgment).
- `--max-wait` / `--poll-interval` accept duration strings (`20m`, `30s`, `90s`) — reuse whatever duration parsing the CLI already has (`parsePruneDuration` exists); don't invent a new format.
- `run` and `status` print human-readable summaries by default; `--json` emits the raw `DriverTickResult` / run view. `import`, `decide`, `mark-merged`, `cancel` always print compact JSON (they're machine-shaped already).
- `render --out <path>` writes the regenerated manifest to the path (creating parent dirs); without `--out`, prints to stdout.
- `status` flags **`⚠ manifest modified since import <imported-at>`** when the file at `manifest_path` exists and its current content's frontmatter differs from the stored `source_json` frontmatter (§4.2's post-import-edits-ignored warning made visible). Missing file is NOT a warning — store-only operation is a feature (§7.4).
- `reason` is required for `skip` and `abort` (matches the `Decision` type); the CLI enforces it with a clear message.

### 2. MCP — 3 tools (spec §6 v2)

Via `registerXTool`, input/output zod schemas in `@ship/mcp`:

- `driver_run { manifestPath? | driverRunId?, batch?, maxWaitMs?, pollIntervalMs?, force? } → DriverTickResult` — **`maxWaitMs` defaults to `0`** (one dispatch + scan pass, return immediately; the polling loop belongs to the caller, which knows its transport limits). Exactly one of `manifestPath` / `driverRunId` required — zod refinement.
- `driver_status { driverRunId } → run view` (same shape as `ship driver status --json`, including the manifest-modified flag).
- `driver_decide { driverRunId, streamId, decision } → DriverRun view` — `decision` is the §6 discriminated union.

No `driver_import` / `driver_cancel` / `driver_mark_merged` MCP tools in this phase — the CLI covers the rarer verbs; MCP gets the three the brain loop actually needs per spec §6. Adding more later is additive.

### 3. Fake-cursor e2e (the phase's acceptance)

In the existing `e2e/` harness with `SHIP_TEST_FAKE_CURSOR=1`, against a real (temp-dir) db and a real `ShipService`:

1. **N=1 happy path:** write a 1-batch/1-stream manifest → `ship driver run <path>` → auto-import → dispatch → fake terminal → exit 0, run `done` (manifest vocabulary: stream `done` requires markMerged — assert the tick ends `blocked_on_merges`? No: a lone batch with no dependents finishes the tick `done`-eligible only when streams are `done|skipped`; landed-but-unmerged with no dependent batches exits `blocked_on_merges`. Assert THAT — it is the §7.6-correct shape — then `mark-merged` → second run → exit 0 `done`).
2. **`--batch` targeting:** 2-batch manifest, run `--batch 1` only; batch 2 untouched.
3. **Failed-retry:** fake-cursor scripted failure → exit 10 + `failure-triage` in JSON → `decide retry` → re-run → success; attempts length 2.
4. **Store-only resume:** import, run to `blocked_on_merges`, DELETE the manifest file, `mark-merged`, re-run by `drv_` id → `done`; `render --out` regenerates the file.
5. **Cancel:** mid-flight cancel → exit 0, run `cancelled`, sticky on re-run.

Windows + ubuntu CI green on all five (CRLF/path discipline — no bash-isms; the harness already runs on both).

## Acceptance

- All five e2e scenarios green on both CI matrices.
- Exit-code contract pinned by tests (0 / 10 / 1, incl. `blocked_on_merges` → 0).
- MCP `driver_run` default `maxWaitMs: 0` verified (returns after one pass with in-flight streams still `dispatched`).
- `status` manifest-modified flag: shown when edited, absent when byte-identical, absent when file deleted.
- Coverage thresholds met; mutation score not reduced; `make check` green.

## Out of scope

- **The dogfood gate execution** — running a real ≥2-stream cloud batch is the NEXT session's work (§11.2), not this PR.
- P5 skill rewrite; F6 watch; F5 push events.
- Any engine behavior change — if e2e reveals an engine bug, fix it in a separately-labeled commit so the surface PR stays reviewable.

## Implementation plan

1. `@ship/mcp` zod schemas + MCP server registrations + schema tests.
2. CLI `driver.ts` subverbs + arg/exit-code tests.
3. e2e scenarios 1–5.
4. Doc + `make check` clean.

Single PR. Title: `feat(cli,mcp): ship driver verbs + driver_* MCP tools + fake-cursor e2e (P4)`. Include this doc verbatim at `docs/features/driver-extraction/phases/driver-cli-mcp-surface.md` (set Status to "ready for impl" with the P3-surface section verified).
