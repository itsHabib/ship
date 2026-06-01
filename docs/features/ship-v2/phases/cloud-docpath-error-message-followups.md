**Status**: draft
**Owner**: @michael
**Date**: 2026-06-01
**Related**: dossier task `cloud-docpath-error-message-followups` (id: `tsk_01KSZQEWE8VPMMQ7JDJZYY1SW8`); parent phase doc [cloud-docpath-remote-source.md](./cloud-docpath-remote-source.md); deferred from PR #96 cycle-1/2 review.

# Cloud docPath — error-message + branch-logic refinements

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/core/src/errors.ts` (`DocNotFoundError` ~L26, message split), `packages/core/src/doc-source/remoteDocSource.ts` (`resolveRef` branch simplification) | ~40 | 40 |
| Tests | `packages/core/src/errors.test.ts`, `packages/core/src/doc-source/remoteDocSource.test.ts` | ~50 | 25 |
| **Total** | | | **~65** |

Band: **amazing** (< 500).

## Goal

Three minor refinements deferred from PR #96 cycle-1/2 review of the cloud docPath remote-source work.

## Behavior / fix

1. **Copilot — context-split the `DocNotFoundError` message.** Its default message now appends cloud-specific guidance ("commit the doc to the repo branch or pass a local workdir"), shown even on local-only runs. Split the message by local-vs-cloud context (`packages/core/src/errors.ts` ~L26) so local errors don't suggest cloud remedies. Plumb whichever local/cloud flag the call sites already carry; don't invent new state.
2. **Copilot — redundant branching in `remoteDocSource.resolveRef`.** When `prUrl` is empty and `workOnCurrentBranch` is true, both the inner branch and the fallthrough call `resolveDefaultBranch`, so the `workOnCurrentBranch === true` check is a no-op. Simplify — drop the dead branch.
3. **codex P2 — fork-PR head ref** (low priority): when `prUrl` is a PR from a fork, `pulls.get(...).head.ref` is the fork's branch name; fetching it from the base repo may miss. Cloud scope is single-repo today, so this is a documented caveat / small guard, not a full cross-fork fetch implementation.

## Acceptance

- A local-only `DocNotFoundError` no longer suggests cloud remedies; a cloud `DocNotFoundError` still does (asserted by tests for both contexts).
- `resolveRef` no longer has the dead `workOnCurrentBranch === true` branch; behavior unchanged (tests stay green).

## Test plan

- `errors.test.ts`: `DocNotFoundError` local context → message has no cloud guidance; cloud context → message includes it.
- `remoteDocSource.test.ts`: existing `resolveRef` cases stay green after the simplification (empty `prUrl` + `workOnCurrentBranch` true/false both resolve the default branch identically).

## Non-goals

- Full cross-fork PR head fetching — item 3 is a caveat/guard only; cloud is single-repo per phase 04.
- Any change to the happy-path doc resolution behavior; this is messaging + dead-branch cleanup.
