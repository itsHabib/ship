**Status**: draft — ready for `ship.ship`
**Owner**: @michael (human:mh)
**Date**: 2026-06-20
**Related**: dossier task `agent-runner-decursor-identity` (id `tsk_01KVH5KMN93QFVRM5ZQH4N4XJW`); TDD [../spec.md](../spec.md) §5, §9 (Phase 1b); design review PR #145. **Rebase on `agent-runner-seam-extract` (Phase 1a) — both touch `packages/core/src/service.ts`.**

# De-cursor the leaked identity surface + add a `provider` column

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production | `packages/workflow/src/workflow.ts` (watch-URL builder), `packages/mcp/src/mcp.ts` (output schema), `packages/core/src/service.ts` (`getRun` enrichment + `agent-not-created` sentinel), `packages/core/src/artifacts/prompt-template.ts` (trailer), `packages/store/src/*` (`provider` column + persistence) | ~180 | 180 |
| Tests | store migration/backfill test, MCP schema test, `getRun` enrichment test | ~160 | 80 |
| **Total** | | | **~260** |

Band: **amazing** (<500).

## Functional

Cursor identity leaked past the runner package into `workflow`, `mcp`, `core`, and the prompt template. Parameterize each by provider, **additively** — nothing removed, so the zero-cursor-behavior-change gate holds.

1. **workflow** — generalize `cursorWatchUrl(agentId)` ([workflow.ts](../../../packages/workflow/src/workflow.ts)) into a provider-aware watch-URL builder: `cursor` → `https://cursor.com/agents/<id>`; non-cursor providers → omitted (no URL), **not** a broken cursor.com link.
2. **mcp** — in the `get_workflow_run` output schema ([mcp.ts:241](../../../packages/mcp/src/mcp.ts)), **add** `agentId` (provider-neutral) + `provider` **alongside the existing, kept** `cursorAgentId`. `cursorAgentId` stays (cloud-only, `optional()`) as a deprecated cursor alias — Phase 1 only *adds* fields. (All three review bots flagged a bare rename as a breaking wire change; additive preserves the gate. Renaming/removing `cursorAgentId` is a later deprecation, out of scope.)
3. **core** — `getRun` ([service.ts:357](../../../packages/core/src/service.ts)) surfaces `agentId` + `provider` + the provider-aware `watchUrl` (cursor unchanged; `cursorAgentId` still set for cursor cloud runs). Parameterize the `agent-not-created` sentinel by provider where it's provider-shaped.
4. **core / prompt-template** — parameterize the `Co-authored-by: Cursor <cursoragent@cursor.com>` trailer ([prompt-template.ts:45](../../../packages/core/src/artifacts/prompt-template.ts)) by provider: cursor emits the cursor trailer; other providers emit their own or none.
5. **store** — add a `provider` column to `cursor_runs` (default `'cursor'` for backfill + cursor callers); persist it on write and surface it through the run view.

## Tradeoffs

- **Additive (`agentId`+`provider` alongside kept `cursorAgentId`) vs. rename** → additive. Preserves the byte-for-byte cursor gate; the rename/removal is deferred hygiene.
- **Table rename `cursor_runs`→`agent_runs`** → not now (TDD §10.3). The `provider` column captures the semantics; a table rename is migration churn with no functional payoff. Optional later hygiene.
- **Watch-URL: omit vs. empty string for non-cursor** → omit (strict-optional, like the existing local-run treatment) so no field appears rather than a null/empty one.

## EDs

- **ED-1: `cursorAgentId` is kept, not renamed.** Additive-only in Phase 1; this is the explicit design-review correction.
- **ED-2: `provider` defaults to `'cursor'`** on backfill and for all current callers, so existing rows + cursor runs are unchanged.

## Validation

- Existing cursor runs persist and surface unchanged: a cloud cursor run still exposes `cursorAgentId` + `watchUrl`; a local run omits both; the new `provider` reads `'cursor'`.
- Store migration test: the `provider` column backfills `'cursor'` on existing rows.
- MCP schema test: the `get_workflow_run` output carries `agentId` + `provider` (and still `cursorAgentId` for cloud cursor runs); round-trips with and without them.
- Full `make check` green on **ubuntu + windows**.

## Risks

- **`service.ts` overlap with the sibling task** (`agent-runner-seam-extract` renames runner types throughout `service.ts`). This task lands **after** 1a and rebases on it — see the driver manifest conflict note. The edits are textually disjoint (1a = type-name references; this = `getRun` enrichment + sentinel + trailer), so the rebase should be clean, but serialize to be safe.
- **Wire-contract addition.** `agentId`/`provider` are new optional output fields — additive, but note the change in the PR so the reviewer bots see it; the strict output schema must `extend` (not reject) the new keys.

## Out-of-scope

- The `provider` *selector* / capability map / claude wiring (Phase 2).
- The runner-seam rename + `@ship/agent-runner` extraction (sibling task `agent-runner-seam-extract`, Phase 1a).
- Table rename `cursor_runs`→`agent_runs` (deferred hygiene).
- Removing/renaming `cursorAgentId` (a later deprecation).

## Implementation-plan

1. **store** — add the `provider` column (default `'cursor'`) + migration; persist + surface; backfill test.
2. **workflow** — generalize the watch-URL builder to be provider-aware.
3. **core** — `getRun` surfaces `agentId` + `provider` + provider-aware `watchUrl`; parameterize the trailer in `prompt-template.ts` + the `agent-not-created` sentinel.
4. **mcp** — extend the `get_workflow_run` output schema with `agentId` + `provider` (keep `cursorAgentId`); schema test.
