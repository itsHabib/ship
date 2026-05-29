# Cloud artifact retrieval

Status: design draft
Owner: ship (cursor)
Date: 2026-05-29

> A general operator capability: list and download the artifacts a cloud session produced — build outputs, logs, generated data, reports, screenshots, anything the agent wrote to its cloud workspace that isn't a git commit. Browser/UI-smash screenshots are **one consumer**, not the motivation; this doc designs the capability standalone. Source: cursor-cloud-followups item D. SDK surface confirmed in [`docs/cursor-sdk-typescript.md` § Artifacts](../../cursor-sdk-typescript.md).

## Scope

**Weighted LOC budget — ~650, "ideal" band, split into 2 PRs (see Implementation plan).**

- `packages/cursor-runner/src/cloud-runner.ts` — capture `listArtifacts()` at terminal; expose `downloadArtifact(path)` through the runner interface.
- `packages/cursor-runner/src/index.ts` (+ `_shared`) — `CursorRunResult.artifacts?: ArtifactRef[]`; `CursorRunner.downloadArtifact?` (cloud-only optional method).
- `packages/workflow/src/workflow.ts` — `artifactRefSchema` (`{ path, sizeBytes, updatedAt }`).
- `packages/store/src/cursor-runs.ts` — persist the manifest: `cursor_runs.artifacts_json` column + migration; read/write in record/update paths.
- `packages/core/src/service.ts` — `listArtifacts(workflowRunId)` (DB read) + `downloadArtifact(workflowRunId, path)` (fetch → disk); path-containment guard.
- `packages/core/src/artifacts/paths.ts` — `artifacts/` subdir under the run dir.
- `packages/mcp/src/mcp.ts` — schemas for two new tools.
- `packages/mcp-server/src/tools/` — `list_artifacts` + `download_artifact` tools.
- `packages/cli/src/` — `ship artifacts list <wf>` + `ship artifacts download <wf> <path> [--out <dir>]`.
- Tests across all layers + an L3 cloud download scenario.

## Summary

Cloud agents run in a full VM and routinely produce non-git outputs — a compiled binary, a coverage report, a generated dataset, a flamegraph, a log bundle, a screenshot. The Cursor SDK exposes them: `agent.listArtifacts(): SDKArtifact[]` (`{ path, sizeBytes, updatedAt }`) and `agent.downloadArtifact(path): Buffer`, **cloud-only**. Ship surfaces neither today — a `ship.ship` cloud run can produce a binary and the operator has no way to get it.

This adds the operator-pull path: **list** what a run produced, **download** any of it to local disk. Artifacts are addressed by their cloud `path` (the SDK's key — no separate id). The manifest is captured at terminal and persisted (refs only, never contents); download is on-demand and lazy. Downloads land under the existing run-dir layout at `<runsDir>/<wf>/artifacts/<path>`.

Explicitly **not** about any one artifact type. Screenshots from a browser run, a built `.exe`, a `coverage.lcov` — all the same path through this surface.

## Functional requirements

### F1 — Capture the artifact manifest at cloud terminal

On a cloud run reaching terminal success, `CloudCursorRunner` calls `agent.listArtifacts()` and includes the result on `CursorRunResult.artifacts` (`ArtifactRef[]` = `{ path, sizeBytes, updatedAt }`). Best-effort: a `listArtifacts` failure logs a warning and yields an empty manifest — it never fails the run (the agent's work already succeeded). Local runs: `artifacts` absent.

### F2 — Persist the manifest; `list_artifacts` reads it

`cursor_runs.artifacts_json` stores the manifest (refs, not bytes). `ShipService.listArtifacts(workflowRunId)` returns it from the DB (no network). New MCP tool `list_artifacts { workflowRunId }` → `{ artifacts: ArtifactRef[] }`. CLI `ship artifacts list <wf>` renders a table (path / size / updatedAt). Empty for local runs or runs that produced nothing.

### F3 — `download_artifact` fetches on demand to disk

MCP tool `download_artifact { workflowRunId, path }`: resolves the run's cloud `agentId` (from `cursor_runs.agent_id`), obtains the agent handle, `downloadArtifact(path)`, writes bytes to `<runsDir>/<wf>/artifacts/<path>`, returns `{ localPath, sizeBytes }`. CLI `ship artifacts download <wf> <path> [--out <dir>]`. Download is the only network/bytes operation — `list` never transfers contents.

### F4 — Path containment (no traversal escape)

The SDK-provided `path` is untrusted. Before writing, the resolved destination must realpath-contain within `<runsDir>/<wf>/artifacts/`. Reuse the `isDescendantPath` guard from `validate.ts`. A `path` that escapes (`../`, absolute) → `ArtifactPathEscapesRunDirError`, no write.

### F5 — Local-runtime + agent-expiry behavior

- Local runs: `list_artifacts` → empty; `download_artifact` → `ArtifactsUnavailableLocalError` (SDK supports artifacts cloud-only).
- Cloud agent disposed/expired (the manifest persists, but the bytes are gone cloud-side): `download_artifact` → `ArtifactGoneError` naming the run + path. The persisted manifest still lists what *was* produced; only retrieval fails.

## Tradeoffs

- **`artifacts_json` column vs `cursor_run_artifacts` table.** Column chosen for v1 — a run produces a handful of artifacts, the manifest is small, no query-by-artifact need. A table is the answer only if per-artifact querying or very high counts appear; noted as the migration path, not built now.
- **Eager list-at-terminal vs fully lazy.** Persisting the manifest at terminal makes `list` a fast offline DB read and preserves the record of what a run produced even after the cloud agent expires. The cost: one extra `listArtifacts()` call per cloud run. Worth it. (Download stays lazy.)
- **Buffer vs stream.** The SDK's `downloadArtifact(path)` returns a `Buffer` — fully in memory. Fine for typical artifacts; a multi-GB artifact would spike memory. v1 accepts this with a configurable size guard (F-risk below); streaming waits on an SDK streaming API.
- **Dedicated tools vs folding into `get_workflow_run`.** Artifacts are a variable-length list that can be large/many — a dedicated `list_artifacts` keeps `get_workflow_run` lean (unlike `watchUrl`, which was a single scalar and rode along).

## Engineering decisions

- **ED-1** — Address by SDK `path`, no Ship-side artifact id. Matches the SDK; one less mapping.
- **ED-2** — Manifest captured at terminal, persisted as refs in `cursor_runs.artifacts_json`; bytes never persisted, downloaded on demand.
- **ED-3** — `downloadArtifact` is an optional method on the `CursorRunner` interface, implemented only by `CloudCursorRunner`; `LocalCursorRunner` omits it → `ArtifactsUnavailableLocalError` at the service layer.
- **ED-4** — Downloads land at `<runsDir>/<wf>/artifacts/<path>`, path-contained (F4) via the existing `isDescendantPath` guard.
- **ED-5** — Size guard: refuse (with a clear error + the `--force` / config override) any artifact over a configurable cap (default e.g. 100 MB) so a runaway artifact can't OOM Ship. Surfaced, not silent.

## Validation

- **L1/L2** — fake SDK artifact API in `@ship/test-harness`: manifest capture at terminal; `listArtifacts` DB read; `download_artifact` writes to the right path; path-traversal `path` rejected (F4); local-run errors (F5); size-guard trip (ED-5); schema round-trips.
- **L3** — `cloud-artifact-download.e2e.test.ts`: a cloud run that writes a known file, then `download_artifact` retrieves it byte-identical. Gated on `SHIP_LIVE` + `SHIP_CLOUD`.
- `make check` green.

## Risks

- **Huge artifact → memory spike** (buffer download). Mitigated by the size guard (ED-5); true fix is SDK streaming.
- **Agent expiry loses bytes.** The manifest outlives the agent but the bytes don't — `download` fails clearly (F5). Operators who want a build output should pull it before the agent is reaped. Document the window.
- **Path traversal** from a malicious/odd artifact path — closed by F4. Test it explicitly.
- **`listArtifacts` latency at terminal** adds to every cloud run's finalize. Best-effort + a short timeout keeps it from dominating (F1).

## Out of scope

- **Push/publish direction** (`publish_artifact` from inside a run — the comm-layer thesis in the SDK leverage doc). This is operator-pull only.
- **Auto-download** on terminal — operators pull explicitly; no implicit byte transfer.
- **Browser/screenshot-specific handling** — screenshots flow through the generic surface; nothing here knows about images.
- **Artifact diffing / preview / retention policy** — future.

## Implementation plan

Two PRs (~650 weighted total; split at the list/download seam):

**PR A — capture + persist + list (~300):**
1. `artifactRefSchema` (`@ship/workflow`) + `CursorRunResult.artifacts` (`@ship/cursor-runner`).
2. `CloudCursorRunner` calls `listArtifacts()` at terminal (F1, best-effort).
3. `cursor_runs.artifacts_json` column + migration + store read/write.
4. `ShipService.listArtifacts` + `list_artifacts` MCP tool + `ship artifacts list` CLI.
5. Tests (capture / persist / list / local-empty).

**PR B — download (~350):**
1. `CursorRunner.downloadArtifact?` + `CloudCursorRunner` impl (F3).
2. `artifacts/` run-subdir (`paths.ts`); `ShipService.downloadArtifact` with path containment (F4) + size guard (ED-5) + local/expiry errors (F5).
3. `download_artifact` MCP tool + `ship artifacts download` CLI.
4. Tests (download-to-disk / traversal-rejected / size-guard / local + expiry errors) + L3.

## On merge

This is the general capability the cloud-UI-e2e-bug-smash needs for screenshots — once it lands, that work consumes `download_artifact` rather than blocking on a bespoke screenshot path. Cross-link, don't couple.
