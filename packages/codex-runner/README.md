# `@ship/codex-runner`

## What this package owns

The sole package that imports `@openai/codex-sdk` (and transitively `@openai/codex`) directly — **SDK isolation** mirroring `@ship/claude-runner`'s ED-2 pattern. Implements `CodexRunner` for local worktree runs via `startThread()` + `runStreamed()`. Every other package reaches SDK types through re-exports here; `test/sdk-import-isolation.test.ts` fails if any sibling names `@openai/codex-sdk` or `@openai/codex`.

## Public surface

- **`CodexRunner`** — drives `Codex` with per-run gateway config (`baseUrl`, `model_providers`, env injection); rejects non-local runtime; `attach` throws `OperationNotSupportedError`.
- **`classifyFailure` / `buildFailureDetail`** — Codex-bound failure classification over the bounded event window.
- **`codexEventProjection`** — normalizes Codex `ThreadEvent` items to the neutral `EventProjection` vocabulary.
- **SDK re-export** — `ThreadEvent` type-only for consumers without a direct SDK dep.

## How it composes

Leaf runtime adapter consumed by `@ship/core` via the `(provider, runtime)` selector (`codex-selector` wires the slot). Downstream tests drive `FakeAgentRunner` from `@ship/agent-runner` — no `FakeCodexRunner`.

## When to swap it

Swap this package to drive a different OpenAI Codex execution surface behind the same `AgentRunner` seam. Because it's a leaf adapter — `@ship/core` reaches it only through the `(provider, runtime)` selector and the neutral `AgentRunResult` / `EventProjection` contracts — a replacement need only implement `AgentRunner` and supply its own `EventProjection`; nothing upstream changes.

**Codex capability gaps (0.142.3):** `input.mcpServers` and `input.agents` are no-ops — MCP servers are configured via Codex's own `~/.codex/config.toml`, and Codex has no inline subagent dispatch. Do not thread those fields into the SDK call.

## Develop / test

```bash
pnpm --filter @ship/codex-runner test
```

All unit tests mock `@openai/codex-sdk` — no `CODEX_API_KEY` or network required in CI.
