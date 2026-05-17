# Cursor SDK leverage — analysis + roadmap

> Companion to [docs/cursor-sdk-typescript.md](cursor-sdk-typescript.md). What Ship uses today, what it deliberately skips, and what's worth picking up next.

Date: 2026-05-16

## Why this exists

V1's cursor-runner is intentionally narrow — `Agent.create` + `agent.send` + `run.stream/wait/cancel` and not much else. That was the right shape for V1: prove the workflow mechanics, defer everything optional.

After V1 shipped (2026-05-10) the question reopens: what else in `@cursor/sdk` would meaningfully improve Ship, and what's unused for principled reasons? This doc captures the audit + a tiered menu of follow-on work. It is **not** a per-feature spec — when we commit to one of the proposals below, it gets its own `docs/features/<feature>/spec.md`.

## Proposals

### Tier 1 — clear value, low effort

#### 1. Populate `mcpServers` in default wiring

The `mcpServers` hook is plumbed end-to-end ([service.ts:288](../packages/core/src/service.ts), [local-runner.ts:52](../packages/cursor-runner/src/local-runner.ts)) but [default-wiring.ts](../packages/core/src/default-wiring.ts) never populates it. Wire Ship's own MCP server (and optionally dossier + tower) into every cursor agent at create time. The agent can then call back into the system that spawned it: `dossier.task.update`, `ship.get_workflow_run`, `tower.list_worktrees`, etc. This is the comm-layer thesis from the original spec ([cursor-sdk-typescript.md § What this means for Ship's design item 4](cursor-sdk-typescript.md)).

- **Where:** `packages/core/src/default-wiring.ts` — pass `mcpServers` through to `createShipService({ config: { mcpServers } })`.
- **Open Q (decide first):** which servers, and where does config live?
  - Inline (Ship hardcodes its own MCP server URL) — but Ship's MCP server is stdio today, so the agent can't dial in.
  - Env-var / dedicated config file (`SHIP_MCP_SERVERS_JSON`).
  - File-based via `.cursor/mcp.json` in the worktree — matches SDK loading precedence and survives a hypothetical future `Agent.resume`.
- **Dependency:** Ship's MCP transport story. Today stdio-only; for an agent to connect, Ship needs an http/sse transport OR the agent invokes Ship via stdio spawned with the right cwd. Resolve before scoping.
- **Estimate:** ~50 LOC + tests once the transport question is answered.

#### 2. Token-usage tracking via `onDelta`

The SDK's `turn-ended` `InteractionUpdate` carries `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`. Persist a running total on `cursor_runs`. Unlocks per-workflow cost reporting without an external billing pipeline.

- **Where:**
  - `packages/cursor-runner/src/runner.ts` — add optional `onDelta` to `CursorRunInput`, mirror the existing `onEvent` swallow semantics (sync throws + async rejections silently dropped per ED-4).
  - `packages/cursor-runner/src/local-runner.ts` — pass to `agent.send(prompt, { onDelta })`.
  - `packages/store` — schema bump: `cursor_runs.token_usage_json` column (or four typed columns).
  - `packages/core/src/service.ts` — accumulate, persist on terminal alongside `durationMs`.
- **Estimate:** ~80 src + ~120 test = ~140 weighted (inside "amazing").
- **Note:** `onDelta` is a per-`send` option, structurally same shape as today's `onEvent` callback.

#### 3. `ship doctor` CLI subcommand

`Cursor.me` for auth (returns `apiKeyName`, `userEmail`), `Cursor.models.list` for available models + variants, surface the resolved default model + any wired `mcpServers`. Removes a class of "key isn't working" / "what models can I use" support questions.

- **Where:** `packages/cli/src/commands/doctor.ts` (new), wired via `packages/cli/src/index.ts`.
- **Note on ED-2:** today only `cursor-runner` imports `@cursor/sdk`. Two ways to keep the seam clean:
  - Re-export `Cursor.me` / `Cursor.models.list` from `@ship/cursor-runner` (preferred; the seam stays single-package).
  - Widen ED-2 to allow `cli` to import `@cursor/sdk` directly (worse — it makes the seam an exception list).
- **Estimate:** ~60 src + ~80 test.

### Tier 2 — design first, then ship

#### 4. Subagent layer for the V2 review-cycle phase

The most interesting one. V2's review-cycle phase (not yet designed; follows phase 02 `open_pr`) has two possible shapes:

- **Outer-loop in Ship:** `implement → external-review → fix` as three workflow phases. Today's mental model. Mirrors how a human runs the loop with `@claude review` / `@codex review` PR comments.
- **Inner-loop via SDK subagents:** the implement phase passes `agents: { "code-reviewer": {...}, "test-writer": {...} }` to `Agent.create`; the agent self-reviews via the built-in `Agent` tool before declaring done. Some review work collapses into implement.

These compose, they don't replace each other. But the boundary deserves explicit thought before phase 03's spec is written. The SDK doc explicitly flags subagents as the inner-loop primitive vs Ship's outer recipes ([cursor-sdk-typescript.md § Subagents](cursor-sdk-typescript.md)).

Open questions for the design doc:
- Inline (`agents:` on `Agent.create`) vs file-based (`.cursor/agents/*.md` in the worktree) vs both?
- Does Ship curate a default subagent set, or does the user define them per-repo?
- How does subagent output surface in Ship's artifacts? Today's `events.ndjson` captures the parent agent's `tool_call` events but the SDK reference doesn't fully spell out subagent invocation streaming.
- If subagents handle the inner review, is the outer-loop "external review by a different model family (Claude / Codex)" still wanted? Probably yes for cross-model triangulation, but that's a separate fork.

**Dogfood it.** The Ship repo commits its own `.cursor/agents/*.md` set so every `ship.ship` run against this repo exercises the subagent path. Encodes standards already captured in CLAUDE.md + memory as enforceable subagent reviewers, and turns "does subagent passthrough work end-to-end?" into something a Ship-on-Ship run can't avoid noticing if it breaks. Candidate subagents to seed:

- `code-reviewer` — pre-PR self-review; catches what `@claude review` / `@codex review` would flag in cycle 1
- `pr-budgeter` — checks the diff against the <500 / <700 / <1000 weighted-LOC budget from CLAUDE.md, flags overruns before commit
- `naming-cop` — catches `And`/`Or` in function/method names, `Impl` suffix, generic `shared`/`utils`/`helpers` package names (encodes feedback_naming_no_and_or, feedback_naming_no_impl_suffix, feedback_naming)
- `samurai-sword-checker` — flags scope creep, unnecessary abstractions, half-finished implementations (feedback_samurai_sword)
- `doc-first-enforcer` — checks that non-trivial work has a phase doc with the standard sections before code lands (feedback_doc_first)

Side benefit: pragmatically resolves the inline-vs-file-based fork. Repo-curated set lives in `.cursor/agents/`; the inline path stays for cross-repo defaults Ship's wiring might ship later.

#### 5. Multimodal task docs (`images:`)

Let task doc front-matter reference image files; Ship reads them, base64-encodes, and passes via `agent.send({ text: prompt, images: [...] })`. Unlocks "fix this UI bug, here's a screenshot" coherently with the doc-first model — the doc remains source of truth, images are referenced attachments.

- **Where:**
  - `packages/core/src/validate.ts` — extend front-matter schema with `images?: string[]` (paths relative to the doc).
  - `packages/core/src/artifacts/prompt-template.ts` — read + base64-encode + mime-type detect.
  - `packages/cursor-runner/src/runner.ts` — `CursorRunInput` grows `images?: Array<{ data: string; mimeType: string }>`.
  - `packages/cursor-runner/src/local-runner.ts` — pass to `agent.send({ text, images })`.
- **Open Q:** image-size cap, mime-type allowlist, what cloud runtime does (where images may need separate upload).
- **Estimate:** ~100 src + ~150 test = ~175 weighted.

### Tier 3 — speculative, park

#### 6. Agent reuse across phases via `Agent.resume` + follow-up `agent.send`

Cheaper than spawning a fresh agent for "fix CI failures" — preserves conversation, skips re-priming the codebase context. But local SDK agents die with the Ship process; resume only matters for cloud runtime. Park until cloud lands.

#### 7. Cloud runtime

Already on the V2 backlog ([ship-v2/spec.md:27](features/ship-v2/spec.md)). Highest leverage long-term — collapses Tier 1 #1's transport question (cloud agents have full http access), enables `cloud.autoCreatePR` (collapses `open_pr` to a no-op for cloud runs), unlocks parallel disconnect-survivable runs and GUI testing via the cloud VM. Out of scope for this doc; gets its own V2 phase when prioritized.

## What Ship uses today

Confined to [packages/cursor-runner/src/local-runner.ts](../packages/cursor-runner/src/local-runner.ts) per ED-2 ([phases/05-cursor-runner.md](features/ship-v1/phases/05-cursor-runner.md)). The import-isolation test ([test/sdk-import-isolation.test.ts](../packages/cursor-runner/test/sdk-import-isolation.test.ts)) enforces this.

| SDK surface | Where |
|---|---|
| `Agent.create({ apiKey, model, local.cwd, mcpServers?, name? })` | local-runner.ts:41 |
| `agent.send(prompt)` | local-runner.ts:55 |
| `run.stream()` | local-runner.ts:178 |
| `run.wait()` | local-runner.ts:201 |
| `run.cancel()` | local-runner.ts:101 |
| `agent[Symbol.asyncDispose]()` | local-runner.ts:213 |
| `RunResult.{status, result, durationMs, model, git.branches}` | mapped via `mapRunResult` |
| `SDKMessage` envelope (opaque, persisted as NDJSON) | `events.ndjson` writer |
| `ModelSelection` typecheck mirror | [model-selection-compat.test.ts](../packages/cursor-runner/src/model-selection-compat.test.ts) |

Hooks plumbed but unused at runtime: `mcpServers`, `agentName`. Both wire from `ShipServiceConfig` ([service.ts:288](../packages/core/src/service.ts)) but `default-wiring.ts` never populates them. (See Tier 1 #1.)

## Unused SDK surface — categorized

### A) Principled non-use — don't adopt

| SDK surface | Why we skip it |
|---|---|
| `Agent.list` / `Agent.get` / `Agent.getRun` / `Agent.resume` | Ship owns durability via SQLite + workflow IDs. SDK catalog would split state — two answers to "what's the status of run X." |
| `Agent.prompt` (one-shot) | Ship's wrapper does create+send+wait+dispose with proper signal/cancel/dispose handling. Pure sugar. |
| `run.onDidChangeStatus` | Redundant with `status` events already on the event stream. |
| `run.supports` / `run.unsupportedReason` | Capability negotiation moot for one-runtime-at-a-time. |
| `agent.reload` | Useful only if Ship reused agents. Today: one agent per run, dispose after. |
| `run.conversation()` | `RunResult.result` already gives the final assistant text; `events.ndjson` covers the rest. |
| Cursor-side PR creation (`cloud.autoCreatePR`) replacing Ship's `GhClient` | V2 phase 02 explicitly chose `gh` shell-out via `GhClient` ([phases/02-open-pr.md](features/ship-v2/phases/02-open-pr.md)); cloud-only and doesn't change the local-first calculus. |

### B) Bound to a thing not yet shipped

| SDK surface | Becomes useful when |
|---|---|
| All `cloud:` options + `result.git.branches` (populated) + `agent.listArtifacts` / `downloadArtifact` | Cloud runtime lands. Deferred per [ship-v2/spec.md:27](features/ship-v2/spec.md). |
| `Agent.resume` + per-send `model` + follow-up `agent.send` | Ship adopts agent reuse across phases. Local agents die with the process so this only really pays off after cloud. |

## Design forks worth flagging

### Subagents reshape the V2 review-cycle (Tier 2 #4)

Restated for emphasis. The SDK's subagent system isn't just "another feature we could use" — it's a fork in V2's design. Resolve before phase 03's spec starts; otherwise we ship the outer-loop shape by default and only retrofit subagents later.

### `mcpServers` config source (Tier 1 #1)

Three places config could live: env var, dedicated config file, `.cursor/mcp.json` in the worktree. The latter aligns with the SDK's own loading precedence and future-proofs against `Agent.resume`. Probably the right call but worth an explicit decision.

### `cursor-runner` re-export vs widening ED-2 (Tier 1 #3)

Re-exporting `Cursor.me` / `Cursor.models.list` from `@ship/cursor-runner` keeps the SDK seam single-package. Widening ED-2 to allow `cli` to import `@cursor/sdk` makes the seam an exception list. Prefer the re-export but worth flagging.

## Explicit non-goals

- **Replacing Ship's store with the SDK's catalog.** Two state systems, one wins. Ship's wins.
- **Pre-cloud `Agent.resume`.** Pointless for local; defer to whatever cloud-runtime phase tackles cross-process state.
- **An `@octokit/*` dependency for git/PR.** V2 phase 02 already chose `gh` shell-out; the SDK's git surface is cloud-only and doesn't change that.
- **Live UI for in-flight runs.** `onDelta` is for token/cost tracking, not for driving a real-time view. Ship's contract is poll-based via `get_workflow_run`.

## References

- SDK reference (single source of truth for SDK shape): [docs/cursor-sdk-typescript.md](cursor-sdk-typescript.md)
- V1 cursor-runner phase doc: [docs/features/ship-v1/phases/05-cursor-runner.md](features/ship-v1/phases/05-cursor-runner.md)
- V2 plan + open phases: [docs/features/ship-v2/spec.md](features/ship-v2/spec.md)
- V2 phase 02 (`open_pr`, the GhClient choice): [docs/features/ship-v2/phases/02-open-pr.md](features/ship-v2/phases/02-open-pr.md)
