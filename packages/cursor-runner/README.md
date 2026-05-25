# `@ship/cursor-runner`

## What this package owns

The sole package that imports `@cursor/sdk` directly — **ED-2 SDK isolation**. Implements the `CursorRunner` interface for local worktree runs (`LocalCursorRunner`) and Cursor cloud runs (`CloudCursorRunner`). Every other package reaches SDK types through re-exports here; `test/sdk-import-isolation.test.ts` fails if any sibling names `@cursor/sdk`.

## Public surface

- **`CursorRunner`** — `run(input)` starts a new agent; `attach(input)` resumes an existing cloud run.
- **`LocalCursorRunner`** — `Agent.create({ local: { cwd } })`; rejects cloud runtime; `attach` throws `LocalResumeNotSupportedError`.
- **`CloudCursorRunner`** — `Agent.create({ cloud: ... })`; supports `attach` for resume; passes through `autoCreatePR` and env vars.
- **`CloudRunSpec`** — single-repo cloud tuple (URL, branch, env) carried on `ShipInput.cloud`.
- **`CursorRunInput` / `CursorRunResult` / `CursorRunHandle`** — run lifecycle shapes shared with `@ship/core`.
- **SDK re-exports** — `AgentDefinition`, `McpServerConfig`, `SDKMessage` for prompt/MCP wiring without a direct SDK dep elsewhere.
- **`FakeCursorRunner`** — scriptable test double at `@ship/cursor-runner/test/fake` (not in the main barrel).

## How it composes

Leaf runtime adapter consumed by `@ship/core` via `createDefaultShipService`. Core's `selectRunner` picks `LocalCursorRunner` vs `CloudCursorRunner` from `ShipInput.runtime`. `@ship/test-harness` injects `FakeCursorRunner` for deterministic L1/L2/L3 tests. Depends on `@ship/workflow` only for `ModelSelection` typing.

## When to swap it

Replace this package to change the agent runtime — Claude Code SDK, a subprocess wrapper, or a mock for offline dev. The `CursorRunner` interface is the seam: core, store, and MCP layers stay stable as long as `run`/`attach` semantics are preserved. Cloud resume (`attach`) is cloud-only; local resume is explicitly unsupported.

## Develop / test

```bash
pnpm --filter @ship/cursor-runner test
```

Set `CURSOR_API_KEY` for live SDK calls in manual runs. All unit tests use `FakeCursorRunner` or harness wiring — no keys required in CI.
