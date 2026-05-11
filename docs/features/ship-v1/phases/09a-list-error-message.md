# Phase 9a — `listRuns` error message rename

Status: chip task doc (Phase 9 first dogfood). Single-PR fix.
Owner: itsHabib (delegated to Cursor `composer-2` via `ship ship`)
Date: 2026-05-10

> **Companion docs.** Source chip from [phases/09-bug-smash.md § Outcome](09-bug-smash.md). This is the first Phase 9 chip materializing as its own task doc + PR, per Phase 9 ED-2 (alphabetic suffixing under Phase 9). Trivial-rename scope; intentionally chosen as the lowest-risk dogfood to validate the Ship-builds-Ship loop before tackling larger chips.

## Scope

Weighted-LOC budget: ~5 src + ~6 test = **8 weighted LOC**. Comfortably inside "amazing < 500."

## Summary

When the user passes `--limit > 200` to `ship list`, the CLI surfaces the store's `RangeError` verbatim:

```
$ ship list --limit 201
listRuns limit 201 exceeds maximum 200
```

The string `listRuns` is the internal store-layer function name. The operator sees CLI argv (`--limit 201`) and is told about a symbol they have no reason to know about. Same complaint applies anywhere this error reaches a user — including the MCP boundary (the MCP `list_workflow_runs` tool's Zod schema catches `limit > 200` pre-handler with a separate Zod message, so MCP clients don't actually see this error today; but the asymmetry itself is a code smell).

## Functional requirements

### F1 — Rename the RangeError messages in `clampLimit`

In `packages/store/src/workflow-runs.ts`, the two `RangeError` throws inside `clampLimit(limit)`:

```ts
throw new RangeError(`listRuns limit must be a positive integer, got ${String(limit)}`);
throw new RangeError(`listRuns limit ${String(limit)} exceeds maximum ${String(MAX_LIMIT)}`);
```

become boundary-agnostic:

```ts
throw new RangeError(`limit must be a positive integer, got ${String(limit)}`);
throw new RangeError(`limit ${String(limit)} exceeds the maximum allowed value ${String(MAX_LIMIT)}`);
```

### F2 — Update existing test pins

Tests that assert on the old message text must be updated:

- `packages/store/src/workflow-runs.test.ts` — search for `listRuns limit` and update the matchers.
- `packages/cli/src/format.test.ts` / `packages/cli/test/list-command.test.ts` — same.
- `e2e/integration/cli-binary.integration.test.ts:91-95` — currently matches `/exceeds maximum/`. **The substring does NOT survive the rename**: the new wording inserts `the` between `exceeds` and `maximum`, so the regex needs updating to `/exceeds the maximum allowed value/`. (Cycle-1 review of #19 caught the earlier draft's wrong claim that this regex was unaffected — both Codex and Claude flagged it independently.)

The agent should run `grep -rn "listRuns limit" packages/ e2e/` to find every assertion site, then update.

## Non-functional requirements

- **No behavior change.** Only the error message text changes. The `RangeError` type, throw conditions, and exit codes stay identical.
- **No new tests added.** This is a text rename; existing tests that pin the message get the new text.
- **`make check` green.** Typecheck, lint, format:check, and the full unit/scenario test suite (420 tests) must all pass after the edit.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Message style | "limit ... exceeds the maximum allowed value 200" | "limit ... exceeds 200" (terse) | Operator-readable; matches the prose style of other user-facing errors in the codebase. |
| Naming the symbol | Drop `listRuns` prefix entirely | Replace with `--limit` (CLI-specific) or `params.limit` (MCP-specific) | The store layer is boundary-agnostic; the message shouldn't favor either consumer. |
| Test text matching | Update every assertion — both exact-string and regex — to match the new wording | Rewrite all assertions as regex | The earlier draft assumed `/exceeds maximum/` would still match; it doesn't (cycle-1 review caught this). All four pinned-text sites need updating. |

## Engineering decisions

### ED-1 — Store layer owns the wording

The fix lives in `packages/store/src/workflow-runs.ts` (the source of the throw), not in a wrapper at the CLI / MCP boundary. Both consumers receive the same `RangeError` instance; both see the same message. Boundary-agnostic wording is the only correct choice when the same error surface serves multiple boundaries.

### ED-2 — Defer changing the `RangeError` type

Tempting to swap `RangeError` for a typed `LimitOutOfRangeError` class. Out of scope for this chip — the chip prompt explicitly says "Changing the `RangeError` type itself or moving validation to the schema layer" is out of scope. Sticking to the text rename keeps the PR small and reviewable.

## Validation plan

- `make check` from repo root passes (typecheck + lint + format:check + 420 tests).
- `pnpm --filter @ship/cli exec tsx src/bin.ts list --limit 201` surfaces the new message; manual smoke is fine since the integration test pins it.
- The L3 subprocess integration test (`e2e/integration/cli-binary.integration.test.ts`) still passes.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Missed test pin breaks `make check` | Hot loop on lint/test failures | Agent runs `grep -rn "listRuns limit" packages/ e2e/` to find every callsite before editing. |
| Regex assertion breaks under new wording | Test failure | `e2e/integration/cli-binary.integration.test.ts:91-95` uses `/exceeds maximum/`. The new wording inserts `the` (`exceeds the maximum allowed value`), so the regex DOES need updating. The agent caught this during cycle-0 implementation; cycle-1 review of #19 then flagged the original Risks-table claim that the substring "still matched" was wrong. |
| The change touches a hot path | Performance regression | `clampLimit` runs once per `listRuns` call; message construction cost is negligible. |

## Out of scope

- Renaming any other store-layer errors (one chip per symptom; coupling defeats per-chip-PR).
- Switching from `RangeError` to a typed error class.
- Moving limit validation to the schema layer.
- Translating messages (i18n is out of V1).
- Changes to error mapping in `@ship/cli/src/errors.ts` or `@ship/mcp-server/src/errors.ts` — those map error types, not text.

## Implementation plan

The agent should:

1. `grep -rn "listRuns limit" packages/ e2e/` to enumerate every callsite.
2. Edit `packages/store/src/workflow-runs.ts:clampLimit` — update both `RangeError` messages per F1.
3. Update each test assertion that pins the exact string.
4. Run `make check` from repo root; iterate on any failures.
5. Final commit message: `fix(store): rename listRuns limit RangeError messages to be boundary-agnostic (#XX)`.

Single PR. No sub-task docs. No new tests. No new behavior.
