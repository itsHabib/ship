# Phase 9b — switch both bins from `process.exit` to `process.exitCode`

Status: chip task doc (Phase 9, second dogfood). Single-PR fix.
Owner: itsHabib (delegated to Cursor `composer-2` via the **Ship MCP** `ship` tool — first MCP-to-MCP dogfood: Tower MCP created the worktree, Ship MCP runs the agent against it).
Date: 2026-05-10

> **Companion docs.** Source chip is the **P3 #8** entry in [phases/09-bug-smash.md § Outcome](09-bug-smash.md). Second chip materializing per Phase 9 ED-2; intentionally chosen as a small-but-non-trivial follow-up to the 09a text-rename — touches two binaries' top-level error handling without changing public APIs.

## Scope

Weighted-LOC budget: ~10 src + ~10 test = **15 weighted LOC**. Comfortably inside "amazing < 500."

## Summary

Both `@ship/cli` and `@ship/mcp-server` use the same anti-pattern in their `main().catch(...)` handlers and other `process.exit(code)` call sites:

```ts
// packages/cli/src/bin.ts:24-37
main().catch((err) => {
  if (err instanceof CliExit) { process.exit(err.code); }
  if (err instanceof CommanderError) { process.exit(err.exitCode); }
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
});
```

```ts
// packages/mcp-server/src/bin.ts:34-39 + 86-89
if (!useFake && (apiKey === undefined || apiKey === "")) {
  process.stderr.write("error: CURSOR_API_KEY is not set\n");
  process.exit(1);
}
// ...
main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
});
```

On Windows, `process.stderr.write` to a pipe is **async** (libuv). `process.exit(code)` immediately afterward can terminate the process before the write flushes — truncating or losing the error message. Node's docs explicitly warn: "`process.exit()` is asynchronous on synchronous I/O and tries to terminate the process immediately."

Existing integration tests don't currently observe truncation (messages are short), but the pattern is a known Node.js gotcha that bites when stderr is piped or messages get longer.

## Functional requirements

### F1 — Switch every `process.exit(code)` after a stderr write to `process.exitCode = code; return;`

The cli's `bin.ts` already exists with the `.exit(code)` pattern in the top-level catch — that pattern goes.

In **`packages/cli/src/bin.ts`** the `.catch` should become:

```ts
main().catch((err) => {
  if (err instanceof CliExit) { process.exitCode = err.code; return; }
  if (err instanceof CommanderError) { process.exitCode = err.exitCode; return; }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
});
```

In **`packages/mcp-server/src/bin.ts`** every `process.exit(...)` becomes `process.exitCode = ...; return;`:

- The preflight check (`if (!useFake && ...)`) — currently `process.exit(1)` → switch to `process.exitCode = 1; return;`.
- The top-level `.catch` — same shape as the CLI change.

### F2 — Existing tests stay green; no new test required for V1

The existing integration tests already pin the exit codes via `spawnSync`'s `result.status`. After the switch, `result.status` should still be the right code because Node uses `process.exitCode` to compute the exit value when the event loop drains. Verify by running `make integration` after the edit; if any test red-fails, the regression is real and fixable inline.

A dedicated truncation-pinning test (e.g., a long multi-line stderr message that would have truncated under the old `.exit()` pattern) is **out of scope** for this chip — the defensive switch is the main payoff; pinning the truncation behavior is a separate concern that would deserve its own chip if anyone ever sees the truncation in the wild.

## Non-functional requirements

- **No new public API.** Internal-only behavior change.
- **No new tests.** Existing tests pin exit codes via `spawnSync`; those continue to work.
- **`make check` green.** Typecheck, lint, format:check, full unit/scenario suite (420 tests) pass.
- **`make integration` green.** All 15 integration tests pass — they exercise the exact `bin.ts` paths being changed.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Pattern | `process.exitCode = code; return;` | `process.stderr.write(msg, () => process.exit(code))` (callback flush) | The exitCode + drain pattern is more idiomatic in modern Node and doesn't depend on `stderr.write`'s callback being reliably invoked under all stream states. |
| Test pinning | Rely on existing exit-code matchers in integration tests | Add a long-stderr regression test now | Current tests already exercise both `.exit` paths; the switch only changes flush ordering, not the exit code value. Adding a long-stderr test deserves its own chip if truncation is ever observed. |

## Engineering decisions

### ED-1 — `return` after setting `exitCode`

The `return;` after `process.exitCode = code;` is non-optional. Without it, subsequent statements run (e.g., the rest of the `.catch` body), which could produce additional output or override the exitCode. With `return`, the function exits cleanly, the event loop drains, and Node exits with the set code.

### ED-2 — No changes to `CliExit` or its throw helper

`CliExit` is a sentinel class thrown by command handlers; the binary's top-level `.catch` converts it to `process.exitCode`. The class itself doesn't need touching — only its consumer (the `.catch` block) changes from `process.exit(err.code)` to `process.exitCode = err.code; return;`.

### ED-3 — Order of `process.stderr.write` and `process.exitCode` doesn't matter

`process.exitCode` is just a property set on `process`. Setting it before, after, or interleaved with `stderr.write` produces the same exit value (Node reads it when the event loop drains, after all pending I/O completes). Keep the stderr.write first for readability: error message visible → set exit code → return.

## Validation plan

- `make check` from repo root — typecheck + lint + format:check + 420 tests pass.
- `make integration` from repo root — 15 integration tests pass; pay attention to:
  - `cli-binary.integration.test.ts` — every test that asserts `r.status` on a `spawnSync` result.
  - `mcp-server.integration.test.ts` — the missing-CURSOR_API_KEY preflight + the empty-string preflight tests both assert exit code 1.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `process.exitCode` doesn't flush in time on Windows in some edge case | Same as before, no worse | The change is strictly defensive — old behavior risked truncation on long messages; new behavior at worst matches the old. Integration tests confirm short messages still work. |
| Forgetting the `return;` after `exitCode = code;` | Subsequent code runs unexpectedly | Lint already flags missing returns in some configs; manual review catches it. The change is small enough to eyeball. |

## Out of scope

- Adding a long-stderr truncation regression test (separate chip if needed).
- Refactoring `CliExit` or the error-mapping helpers.
- Changing how `CommanderError` propagates.
- Touching any other `process.exit` calls outside the two `bin.ts` files (there shouldn't be any — `grep -rn "process\.exit" packages/` will confirm).

## Implementation plan

The agent should:

1. `grep -rn "process\.exit" packages/` to enumerate every callsite (sanity check; should only find the bin.ts entries listed in F1).
2. Edit `packages/cli/src/bin.ts:24-37` — replace each `process.exit(code)` with `process.exitCode = code; return;`.
3. Edit `packages/mcp-server/src/bin.ts` — same change at lines ~38 (preflight) and ~86-89 (top-level `.catch`).
4. Run `make check` from repo root; iterate on any failures.
5. Run `make integration` from repo root; iterate on any failures.
6. Final commit message: `fix(bins): switch process.exit to process.exitCode in both cli + mcp-server top-level catch (#XX)`.

Single PR. No sub-task docs. No new tests. No new behavior.
