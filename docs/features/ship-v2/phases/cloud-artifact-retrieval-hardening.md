**Status**: draft
**Owner**: @michael
**Date**: 2026-06-01
**Related**: dossier task `cloud-artifact-retrieval-hardening` (id: `tsk_01KSZQEQSPXPAM4SABA5C96GKC`); parent phase doc [cloud-artifact-retrieval.md](./cloud-artifact-retrieval.md); deferred from PR #95 cycle-2 review.

# Cloud artifact retrieval — cycle-2 hardening follow-ups

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/core/src/artifacts/paths.ts` (symlink containment), `packages/core/src/service.ts` (`downloadArtifactImpl` ~L914 reorder; `listArtifacts` terminal timeout in finalize), `packages/cursor-runner/src/cloud-runner.ts` (bound `agent.listArtifacts()`) | ~70 | 70 |
| Tests | `packages/core/src/artifacts/paths.test.ts`, `packages/core/src/service-artifacts.test.ts` | ~110 | 55 |
| **Total** | | | **~125** |

Band: **amazing** (< 500).

## Goal

Three real-but-narrow follow-ups deferred from PR #95 cycle-2 review, non-blocking for the V1 list/download path but worth hardening now.

## Behavior / fix

1. **codex P2 (security-adjacent) — symlink-parent escape** under `<runsDir>/<wf>/artifacts/`. Containment already rejects `..`/absolute paths and checks `isDescendantPath` vs the realpath'd root; harden against a *symlinked intermediate dir* resolving outside the root. The current realpath check covers the leaf; ensure an intermediate symlink can't escape — resolve/realpath the full destination path (or each intermediate segment) before the descendant check, in `packages/core/src/artifacts/paths.ts`.
2. **codex P2 — bound `agent.listArtifacts()` with a timeout at terminal** so a stalled cloud call can't hang the run's finalize. It's best-effort already, but there's no timeout. Wrap the terminal `listArtifacts` call (cloud-runner / service finalize) in a timeout that, on expiry, logs and proceeds without artifacts rather than hanging.
3. **cursor Low — reorder in `downloadArtifactImpl`** (`packages/core/src/service.ts` ~L914): `assertSafeCloudArtifactPath` runs *after* `manifestRefForPath`. Reorder so the cheap path-safety check precedes the manifest lookup — fail fast on an unsafe path before doing work.

## Acceptance

- A symlinked intermediate directory under the artifacts root that resolves outside the root is rejected by containment (new test in `paths.test.ts`).
- A stalled `agent.listArtifacts()` at terminal does not hang finalize — it times out, logs, and the run reaches terminal without artifacts.
- `downloadArtifactImpl` rejects an unsafe path before the manifest lookup (order asserted by test).

## Test plan

- `paths.test.ts`: construct a destination whose intermediate segment is a symlink pointing outside `<runsDir>/<wf>/artifacts/` → containment rejects it.
- `service-artifacts.test.ts`: fake runner whose `listArtifacts` never resolves → finalize completes after the timeout, no hang; and `downloadArtifact` with an unsafe path errors on the path check (manifest lookup not reached).

## Non-goals

- Broader artifact-retrieval feature work — list/download already shipped in #95; this is hardening only.
- Streaming/large-artifact handling beyond the existing preflight size guard.
