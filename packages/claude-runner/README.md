# `@ship/claude-runner`

## What this package owns

The sole package that imports `@anthropic-ai/claude-agent-sdk` directly — **SDK isolation** mirroring `@ship/cursor-runner`'s ED-2 pattern. Implements `LocalClaudeRunner` for local worktree runs via `query()`. Every other package reaches SDK types through re-exports here; `test/sdk-import-isolation.test.ts` fails if any sibling names `@anthropic-ai/claude-agent-sdk`.

## Public surface

- **`LocalClaudeRunner`** — drives `query({ prompt, options })` with Bifrost env injection; rejects non-local runtime; `attach` throws `OperationNotSupportedError`.
- **`classifyFailure` / `buildFailureDetail`** — Claude-bound failure classification over the bounded event window.
- **`claudeEventProjection`** — normalizes Claude SDK messages to the neutral `EventProjection` vocabulary.
- **SDK re-export** — `SDKMessage` type-only for consumers without a direct SDK dep.

## How it composes

Leaf runtime adapter consumed by `@ship/core` via the `(provider, runtime)` selector (Phase 2b). Downstream tests drive `FakeAgentRunner` from `@ship/agent-runner` — no `FakeClaudeRunner`.

## Develop / test

```bash
pnpm --filter @ship/claude-runner test
```

All unit tests mock `@anthropic-ai/claude-agent-sdk` — no `ANTHROPIC_API_KEY` or network required in CI.
