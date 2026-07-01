# Agent Runner Abstraction — Technical Design Document

**Status:** draft / proposal — NOT a build commitment. The artifact we decide from.
**Owner:** @michael (human:mh)
**Date:** 2026-06-19
**Related:** [`packages/cursor-runner/src/runner.ts`](../../../packages/cursor-runner/src/runner.ts) (the `CursorRunner` contract being generalized), [`docs/features/rooms-backend/spec.md`](../rooms-backend/spec.md) (the rooms substrate Claude reuses for parity), [`docs/features/ship-v2/phases/03-subagent-passthrough.md`](../ship-v2/phases/03-subagent-passthrough.md) (where runner generalization was first deferred), dossier project `ship`.

> **Reviewers — focus areas:**
> - **§4 D1** (provider as an orthogonal axis vs. a new `runtime` value) — the load-bearing structural call.
> - **§4 D2** (event-projection seam vs. translating Claude messages into `SDKMessage` shape) — determines how clean the classifier stays.
> - **§7 Flow B** + **§8** (Claude failure mapping — the error-variant `result`-text gap, and the gateway-down path).
> - **§10** the open questions — note the Windows-binary gate is now **resolved** by a de-risk spike (see the §10 update); the remaining calls are design preferences.

**Update — 2026-06-19 de-risk spike (SDK `@anthropic-ai/claude-agent-sdk@0.3.183`):** the gating unknown is cleared. The package ships a real `claude.exe` (225 MB) via a `-win32-x64` optional dep that installs cleanly on a Windows host; `options.env` is **replace**-semantics (spread `process.env`); the error result variant carries a structured `errors: string[]`. Details folded into §6, §7, §8, §10.

**Update — v3 (2026-06-20, review responses):** folded in the Copilot + @codex + @claude design review (all items accepted). Material changes: `cursorAgentId` is **additive, not renamed** (§5); the neutral package defines its own `McpServerConfig`/`AgentDefinition` interfaces rather than re-exporting cursor's (§6); `EventProjection` gains `toolCallId` + an enforced normalization contract + `resultText`/`terminalStatus` preconditions (§6); the `AbortSignal`→`AbortController` bridge and the required `allowDangerouslySkipPermissions` flag are specified (§6); a mid-stream gateway-throw catch path + `gateway-unreachable` category + `attach()` `OperationNotSupportedError` are added (§8); the equivalence-test gate asserts classifier output over real golden fixtures (§11).

**Update — v4 (2026-06-20):** corrected the cloud story — **Claude has a cloud path: Claude Managed Agents** (Anthropic's hosted agent product); it's a real cell (§4 D1/D5), not absent. Reworded §1's motivation to state it as a Ship capability (gateway-routed execution) rather than any deployment/adoption context.

**Update — v5 (2026-06-20):** added **Claude Managed Agents** as the `claude × cloud` cell (§9 Phase 3) — `provider:"claude", runtime:"cloud"` → a `CloudClaudeRunner` over the Managed Agents REST API (`/v1/sessions` + SSE, `x-api-key`). Researched the real surface: no native branch/PR result (reconstruct from GitHub after a prescribed-branch push via GitHub MCP — §7 Flow E, §10.10), and gateway-routability needs the gateway to forward `/v1/sessions*` + SSE + the beta header (§10.9). Clarified that the SDK's `/bridge` (`createCodeSession`) functions are a *separate* `@alpha`/OAuth "Claude Code Remote" surface we do **not** use. Rooms is the `claude × rooms` cell (Phase 4). **All four phases are planned, in dependency order** (no committed/deferred split — the only gate is Phase 1's zero-regression checkpoint).

**Update — v6 (2026-06-20, adversarial review folded):** ran a 5-lens review (+ verify stage) over the v5 doc; folded the confirmed findings. Material: the terminal-error **mapper is provider-local, not shared mechanism** (§3, §6, seam-extract ED-4); **`core/service.ts` is a third event reader** the "two files" premise missed (§3, ED-5); the classify call site in core is a **real logic change, not "names only"** (seam-extract step 4); the projection-equivalence gate needs a **committed pre-refactor baseline** (seam-extract Validation); the `Co-authored-by` trailer appears **twice** + the `provider` column touches the **`.strict()` `cursorRunRefSchema` in `@ship/workflow`** (decursor-identity); a **Phase-2 prompt-template provider-awareness** task (§9 2a — the rendered prompt bakes the Cursor `task`-enum/subagent protocol into core); a **Phase-3 GH-PAT secret class** (§2, §10.14); and cloud **`attach()` id-mapping + cancel-idempotency** open questions (§10.12–13).

**Update — v7 (2026-06-20, re-review folded):** all three bots re-reviewed the current HEAD; confirmed findings folded. Cloud terminal detection reads **session status directly, not the classify projection** (§7 Flow E "Option C"); `stop_reason` is an **object** (`stop_reason.type === "end_turn"`; `max_tokens` → failed); **`prBranch` is schema-required** for `claude × cloud` (§6); the `create_pull_request` tool-result is the **primary** PR source (§10.10); the gateway caveat adds **`/v1/environments` + SSE-no-buffering + beta-header pass-through** (§10.9); the GitHub MCP for a hosted MA session needs a **remote transport, not local stdio** (§10.15); the live Phase 2/3 gates are **L4** with L3 fake/mocked CI paths (§11); **`cli`** added as a rename touchpoint (seam-extract.md + driver.md); `FakeCursorRunner` clarified as type-only-SDK, not zero-dependency.

---

## 1. Problem & hypothesis

**The forcing function.** Ship hard-binds to a single provider (Cursor) today. To support **governed, gateway-routed execution** — running agent traffic through a self-hosted **LLM gateway** (virtual keys, budgets, rate limits, and request/cost observability) — Ship needs a runner the gateway can actually sit in front of.

**Cursor breaks the model.** Cursor's coding agent (Composer) routes through Cursor's own managed backend and exposes no supported "send my traffic to an arbitrary Anthropic/OpenAI-compatible gateway" knob. The "Override OpenAI Base URL" setting is chat-panel-only (not honored by the agent), and even there it posts a non-standard, Responses-API-shaped body that generic OpenAI-compatible proxies reject. There is **no `ANTHROPIC_BASE_URL` equivalent for the Cursor agent**. So no gateway can sit in front of the Cursor agent — its traffic can't be routed through one at all.

**The bet.** Ship deliberately owns the "drive an agent against a workdir + persist what happened" layer, behind a runner seam (`CursorRunner`). The hypothesis:

1. That seam is *already* shallow enough that a second provider slots in behind it without rippling into `core`/`store`/`workflow`/`mcp`/`cli` — a ground-truth code map confirms consumers read **almost no** event fields (one exception: core's `get_workflow_run` diagnostics re-derives `sdkTerminalStatus` from `events.ndjson`, handled in Phase 1 — §3), `onEvent` is pure pass-through, `ModelSelection` is already a neutral type, and `FakeCursorRunner` exercises the full contract with no *runtime* SDK use (§3).
2. The **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) is *gateway-native* exactly where Cursor isn't: it honors `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` via per-run env and sends standard Messages-API traffic — so a gateway can sit in front of Claude where it cannot with Cursor.

This is also the moment that earns a generalization Ship deliberately deferred: "keep the runner cursor-specific until ≥2 providers prove the API shape." **Claude is that second provider.**

**Non-goals (and why):**
- **The SDK's `/bridge` (Claude Code Remote) surface.** The Agent SDK ships `@alpha` `/bridge` functions (`createCodeSession` → `/v1/code/sessions`, `fetchRemoteCredentials`) for claude.ai remote-control — OAuth-based and on an independent breaking-change track. We do **not** build on it. Claude *cloud* execution targets the **Claude Managed Agents REST API** (`/v1/sessions`, `x-api-key`) instead — a planned phase (§4 D1, §9 Phase 3).
- **Subscription / OAuth auth.** Anthropic prohibits third-party products from using claude.ai subscription auth unless pre-approved. We use API-key / gateway auth only — which is also exactly what gateway routing implies.
- **Replacing the Cursor runner.** This is *additive*. Cursor stays the default and keeps `local` / `cloud` / `rooms`.
- **The full provider × runtime matrix.** We legalize only the cells that exist (§4 D1), not every combination for its own sake.

## 2. Functional & non-functional requirements

**Functional:**
- **FR1** — A `provider: "cursor" | "claude"` selector on the ship surface. Default `"cursor"`; an input omitting `provider` behaves byte-for-byte as today.
- **FR2** — `provider: "claude", runtime: "local"` drives a Claude Agent SDK run against a workdir: streams messages to `onEvent`, persists the same terminal-row shape as a cursor run, and classifies failures.
- **FR3** — Gateway routing: when a gateway is configured, the Claude runner injects `ANTHROPIC_BASE_URL` + auth into the SDK's per-run env. With no gateway configured it talks to the Anthropic API directly (same code path, different env).
- **FR4** — The runner seam is neutralized (`AgentRunner`) with provider-specific event decoding behind a projection. **Cursor behavior is unchanged** — same classification, same persisted fields, same tests.
- **FR5** — `provider: "claude", runtime: "cloud"` drives **Claude Managed Agents** (create session → dispatch a `user.message` → SSE stream → idle/`end_turn` terminal) and reconstructs `branches[]`/`prUrl` from GitHub after a prescribed-branch push (Phase 3).
- **FR6** — `provider: "claude", runtime: "rooms"` drives `rooms run --runner claude` inside a Ship-hosted microVM (Phase 4).
- **FR7** — Provider × runtime cells not yet legal (a claude cell before its phase lands, or an unconfigured runner slot) are rejected at the schema/selector boundary with a clear error.

**Non-functional:**

| Dimension | Target |
|---|---|
| Backward compatibility | 100% — every existing cursor caller (no `provider` field) is unaffected; enforced by the existing test suite passing unmodified + a projection-equivalence test (§11). |
| SDK isolation | Each provider SDK is confined to its own package with a per-package import-isolation test (cursor's ED-2 pattern); no other package names a provider SDK. |
| Auth | API-key / gateway only. No subscription/OAuth code path exists. Gateway/Anthropic key handled like `CURSOR_API_KEY` today — env only, never argv, never logged. **Phase 3 introduces a new secret class:** a repo-write **GitHub PAT** passed into a Managed Agents session (for clone + the GitHub-MCP push/PR) — broader than anything Ship holds today (cursor uses Cursor's own GitHub integration; Ship never holds a raw PAT). Source = wiring config (D6); minimum scopes; env-only; **redacted in session-create logging** (mirror `loggableCloudOptions`). See §5. |
| Platform | Must pass `make check` (incl. the coverage gate) on **ubuntu + windows**. Windows is **confirmed** (the SDK ships a `-win32-x64` `claude.exe`, installs on a Windows host — §10.1). |
| Concurrency | Concurrent Claude runs with distinct gateway keys must not interfere — per-run env, no global `process.env` mutation. |
| Observability (bonus) | Claude's terminal message carries `total_cost_usd` / `usage` / `num_turns`. Capturing it is optional and deferred — but the seam shouldn't preclude it. |

## 3. Architecture overview

**The seam today.** `CursorRunner` ([runner.ts](../../../packages/cursor-runner/src/runner.ts)) is the interface every consumer codes against: `run()` / `attach()` / optional `downloadArtifact?()`, with an `onEvent: (event: SDKMessage) => void` callback. A prior ground-truth map established the coupling is **shallow and asymmetric**:

- `core` / `store` / `workflow` / `mcp` read **zero** `SDKMessage` fields. The `onEvent` callback `core` installs is pure pass-through — `ndjson.write(ev)` + a heartbeat ([service.ts](../../../packages/core/src/service.ts)).
- Event-structure inspection lives mostly in **two files inside `cursor-runner`** — [`_shared.ts`](../../../packages/cursor-runner/src/_shared.ts) and [`classify-failure.ts`](../../../packages/cursor-runner/src/classify-failure.ts) — both duck-typing a loose `Record<string, unknown>` via `eventRecord(ev)`. **One more reader exists** (review): `core/service.ts` re-derives `sdkTerminalStatus` from `events.ndjson` on disk for the diagnostics view — Phase 1 handles it too (§9 / seam-extract.md ED-5). So "two files" is the runner-package count, not the whole story.
- `ModelSelection` is **already neutral** — a `@ship/workflow` zod type, not an SDK re-export.
- `FakeCursorRunner` implements the full `CursorRunInput`/`CursorRunResult` contract with **no runtime SDK use** (a type-only `SDKMessage` import remains — neutralized by the `AgentEvent` rename in Phase 1) — proof the contract types port.

The cursor-coupled surface in `local-runner.ts` is exactly six SDK touchpoints (`Agent.create`, `agent.send`, `sdkRun.stream()`, `sdkRun.wait()`, `sdkRun.cancel()`, `asyncDispose`) plus id accessors. Everything else — the handle/promise/cancellation state machine, `safelyEmit`, bounded event-tail capture, the `FailureCategory` taxonomy + classification *policy*, duration formatters, the error-class structure — is reusable mechanism.

**The change — three moves:**

```
                         ┌──────────────────────────────────────────┐
                         │ @ship/agent-runner  (NEW, neutral)        │
                         │  • AgentRunner interface (was CursorRunner)│
                         │  • handle/promise/cancel state machine     │
                         │  • FailureCategory policy + classify logic │
                         │  • EventProjection interface (the seam)    │
                         │  • FakeAgentRunner                         │
                         └───────────────┬───────────────┬───────────┘
                          depends-on     │               │  depends-on
                   ┌────────────────────-┘               └───────────────────┐
        ┌──────────┴───────────┐                          ┌──────────────────┴────────┐
        │ @ship/cursor-runner  │                          │ @ship/claude-runner  (NEW) │
        │  isolates @cursor/sdk │                          │  isolates                  │
        │  CursorEventProjection│                          │  @anthropic-ai/claude-...   │
        │  Local/Cloud/Room     │                          │  ClaudeRunner (local)      │
        └──────────────────────┘                          │  ClaudeEventProjection     │
                                                           └────────────────────────────┘
                         core selects by (provider, runtime) → an AgentRunner
```

1. **Generalize the interface + extract shared mechanism.** Rename `CursorRunner` → `AgentRunner` and lift the provider-neutral mechanism (state machine, classification policy, error taxonomy, fake) into a new `@ship/agent-runner` package. `@ship/cursor-runner` keeps the `@cursor/sdk` isolation and becomes "the cursor implementation"; `@ship/claude-runner` is the new sibling. Dependencies flow one way: providers → `@ship/agent-runner`.

2. **Event-projection seam.** Introduce an `EventProjection` — the accessors the **classifier** needs (`eventKind`, `toolCallId`, `toolCallStatus`, `toolCallName`, `commandArg`, `timestamp`, `statusMessage`, `resultText`, `terminalStatus`). `classify-failure.ts` calls the projection instead of bracket-indexing a raw record. Cursor supplies a `CursorEventProjection` (normalizing today's accessors); Claude supplies its own. The `FailureCategory` *output* vocabulary is already neutral — only the *input* decoding moves behind the projection. **Note (review):** the terminal-error *mapper* (`mapErrorResult`/`buildTerminalErrorMessage`, ~130 cursor-specific lines) is **provider-local**, NOT lifted to the neutral package — only the classifier + state machine + taxonomy + fake are shared (§6, seam-extract.md ED-4).

3. **De-cursor the leaked identity surface.** Cursor identity bled past the runner package into three code spots (the `cursor.com` watch-URL builder; the `Co-authored-by: Cursor` trailer in `prompt-template` — **two occurrences**; the `agent-not-created` sentinel) plus the MCP `cursorAgentId` output field; each is parameterized or made additive by provider (§5, §6). *(Phase 1 is cursor-only/additive; the deeper prompt-contract coupling — the Cursor `task`-tool enum + subagent names in the rendered prompt — is Phase 2, §9.)*

**Selection.** Today there is one factory ([default-wiring.ts](../../../packages/core/src/default-wiring.ts)) and one switch (`selectRunner` in [service.ts](../../../packages/core/src/service.ts)), both keyed on `runtime` only. We add a `provider` axis (§4 D1).

## 4. Key decisions & trade-offs

**D1 — `provider` as an orthogonal axis, but only legalize cells that exist.**
The chosen model: `provider ∈ {cursor, claude}` is independent of `runtime ∈ {local, cloud, rooms}`, but selection legalizes only the cells that actually exist:

| | local | cloud | rooms |
|---|:---:|:---:|:---:|
| **cursor** | ✓ | ✓ | ✓ |
| **claude** | ✓ (Phase 2) | ✓ (Phase 3 — Claude Managed Agents) | ✓ (Phase 4 — rooms) |

*Alternative rejected:* making `"claude"` a new `runtime` value. That conflates *who runs* with *where it runs* and collapses the moment Claude has `local`, `cloud`, and `rooms` — you'd need `claude-local` / `claude-cloud` / `claude-rooms` runtime strings, the orthogonal axis wearing a disguise. The matrix makes each provider's cloud its own *cell* — cursor → `CloudCursorRunner` (Cursor's backend); claude → `CloudClaudeRunner` (Claude Managed Agents) — same `runtime: "cloud"` selector, different per-provider adapter.

**D2 — Event-projection seam, not "translate Claude messages into `SDKMessage` shape".**
*Chosen:* a provider-supplied `EventProjection`. *Alternative:* have the Claude runner synthesize records carrying cursor's keys (`{ type: "tool_call", status, … }`) so the existing classifier "just works." That's cheaper for a day and leaks the next: the classifier hard-codes cursor's enum spellings (uppercase `ERROR`/`EXPIRED` status events vs. lowercase `error`/`failed` tool-call statuses) and a `database is locked` regex. Faking those shapes for a non-cursor provider is exactly the kind of mechanism-leaking-into-policy this codebase avoids. The projection lets Claude supply its own predicates (`error_max_turns`, `error_max_budget_usd`, gateway errors) without forking `classify-failure.ts`.

**D3 — Extract a neutral `@ship/agent-runner` package vs. duplicate mechanism.**
*Chosen:* extract. The handle state machine, classification policy, error taxonomy, and fake are pure mechanism with no SDK dependency; one home keeps the two providers from drifting and matches the composition-of-single-responsibility-layers principle. *Alternative (copy into each runner):* guarantees drift and double-maintenance.

**D4 — Gateway routing via per-run `options.env`, not global `process.env`.**
*Chosen:* inject `ANTHROPIC_BASE_URL` + auth through the SDK's per-call `env` option. Keeps routing per-run (concurrent runs with different gateways/keys are safe) and avoids global mutation. *Resolved (spike):* `options.env` *replaces* `process.env`, so the runner spreads `{ ...process.env, … }` to keep `PATH`/`HOME` (§10.2).

**D5 — Claude has two hosted paths: Managed Agents (`cloud`, Phase 3) and rooms (Ship substrate, Phase 4).**
The `cloud` *runtime* is per-provider: cursor → Cursor's managed backend; **claude → Claude Managed Agents** (Anthropic's hosted REST product — `POST /v1/sessions` + SSE, `x-api-key`, driven via the Anthropic SDK's `client.beta.sessions.*`). It's **Phase 3** — a new `CloudClaudeRunner`, all ship-side, and *architecturally gateway-routable* (the Anthropic SDK honors `base_url`, so the gateway can sit in front), a real edge over Cursor cloud, which can't be proxied at all. Two things make it more than wiring (§6, §7 Flow E): Managed Agents has **no native branch/PR result** (the agent pushes via the GitHub MCP server; the runner prescribes the branch name + reconstructs `branches[]`/`prUrl` from GitHub), and the gateway must forward `/v1/sessions*` + SSE + the beta header (must-verify, §10.9). *Rooms* (Phase 4) is a *separate* path — Ship-owned microVM substrate where the local Claude binary runs in-VM and emits the existing artifact contract; tiny ship-side lift, plus cross-repo guest-image work. Two distinct cloud-ish paths, not competitors: Managed Agents = Anthropic-hosted; rooms = Ship-hosted.

**D6 — Gateway config lives at the wiring/service layer, not on the per-task ship input.**
*Chosen:* base-URL + auth source are operator/deployment config (`ShipServiceConfig` / `default-wiring`), injected by the Claude runner — not a field every `ship.ship` call must pass. A per-run `envVars` override remains possible (mirrors the cloud spec's `envVars`). Routing is an environment concern, not a per-task one.

**D7 — Rename `CursorRunner` → `AgentRunner` now (Phase 1), not lazily when Claude lands.**
*Chosen:* now. It's the deferred generalization this work earns, and doing it as its own no-behavior-change phase (with the cursor projection proving equivalence) de-risks Phase 2 — Claude lands against a seam that's already neutral and already green.

## 5. Data model

- **`cursor_runs` table** — already stores `runtime`, `agent_id`, `run_id`, `model`, `branches`, `failure_category`, etc. **Add a `provider` column**, defaulting to `'cursor'` for backfill and for rows written by cursor callers. No other schema change; `ModelSelection` persistence is unchanged (already neutral).
- **Table rename (`cursor_runs` → `agent_runs`)** — *deferred, out of scope.* It's an internal name; a rename is a migration + store-symbol churn with no functional payoff now. Adding the `provider` column captures the semantics; the rename is optional later hygiene (noted §10).
- **MCP output schema** — **additive in Phase 1**: add `agentId` (provider-neutral) + `provider` alongside the existing `cursorAgentId`, which is **kept** (cloud-only, `optional()`) as a deprecated cursor alias. This preserves the zero-behavior-change gate — Phase 1 only *adds* fields, never removes one. Renaming/removing `cursorAgentId` is a later deprecation, out of scope here. (Review: all three bots flagged a bare rename as a breaking wire change — [mcp.ts:241](../../../packages/mcp/src/mcp.ts), [service.ts:357](../../../packages/core/src/service.ts), consumed by `get-workflow-run` + the `ship://runs` resource + tests.)
- **No new persistent entities.** Sessions/resume state for Claude (if ever wired) live in the SDK's own JSONL on disk, not in Ship's store.

## 6. API contract

**The neutral interface** (`@ship/agent-runner`, renamed from `CursorRunner`; methods unchanged):

```ts
interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunHandle>;
  attach(input: AgentRunAttachInput): Promise<AgentRunHandle>;
  downloadArtifact?(agentId: string, path: string): Promise<Buffer>; // capability-optional, unchanged
}
```

`AgentRunInput` is today's `CursorRunInput` with the event type generalized:

```ts
interface AgentRunInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly model: ModelSelection;            // already neutral (@ship/workflow)
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly agents?: Record<string, AgentDefinition>;
  readonly agentName?: string;               // "ship/<workflowRunId>" — already provider-neutral
  readonly signal?: AbortSignal;
  readonly onEvent: (event: AgentEvent) => void | Promise<void>;  // was SDKMessage
  readonly runtime?: "local" | "cloud" | "rooms";
  readonly cloud?: CloudRunSpec;             // cursor-only
  readonly room?: RoomRunSpec;
  readonly maxRunDurationMs?: number;
  readonly log?: Logger;
}
```

`AgentEvent` is the union of provider event types (each provider's raw message passes through opaquely to `onEvent`/ndjson; structure is only ever read via the projection).

`McpServerConfig` / `AgentDefinition` come from `@cursor/sdk` **today** ([runner.ts](../../../packages/cursor-runner/src/runner.ts) re-exports them), so the neutral `@ship/agent-runner` package **cannot** re-export them without pulling a cursor SDK dependency — that would defeat the isolation goal (Copilot + Claude both flagged this). Phase 1 therefore defines **neutral structural interfaces** for these in `@ship/agent-runner` (the MCP-stdio/http config shape + the subagent-definition shape are provider-agnostic); `@ship/cursor-runner` maps cursor's SDK types to/from them. Consumers never destructure them, so the neutral shapes are a thin re-typing, not a behavior change. **Phase 2 caveat:** `ClaudeRunner` passes these into `query()`, whose `McpServerConfig` is `{ type?: "stdio", command, args?, env? }` (verified, 0.3.183) — close to cursor's but **field-by-field compatibility must be checked, with a translation shim if needed** (2a checklist).

**The projection seam** (the one new interface that makes the classifier provider-agnostic):

```ts
// Canonical normalized vocabularies are the projection IMPLEMENTOR's contract:
// each projection MUST map its provider's raw spellings to these. The classifier
// only ever sees normalized values (cursor's uppercase ERROR/EXPIRED, Claude's
// error subtypes, etc. are folded HERE — never in classify-failure.ts).
type ToolCallStatus = "running" | "completed" | "error" | "failed" | undefined;

interface EventProjection {
  eventKind(ev: AgentEvent): "tool_call" | "status" | "other";
  toolCallId(ev: AgentEvent): string | undefined;        // reconciles a `running` event once a later
                                                         // event for the same call completes/errors
  toolCallStatus(ev: AgentEvent): ToolCallStatus;        // normalized — see the note above
  toolCallName(ev: AgentEvent): string | undefined;
  commandArg(ev: AgentEvent): string | undefined;
  timestamp(ev: AgentEvent): number | undefined;
  statusMessage(ev: AgentEvent): string | undefined;
  resultText(ev: AgentEvent): string | undefined;        // terminal summary/error text (provider-neutral)
  terminalStatus(ev: AgentEvent): string | undefined;    // precondition: returns undefined on non-terminal events
}
```

`CursorEventProjection` is the existing `_shared.ts` accessors verbatim. `ClaudeEventProjection` reads Claude message shapes (`assistant` / `user` / `system` / `result`, tool blocks nested in `assistant.message.content`).

**Ship MCP input** — add to `shipInputSchema`:

```ts
provider: z.enum(["cursor", "claude"]).default("cursor"),
```

Cross-field refinement: `provider === "claude"` ⇒ `runtime` must be `"local"` (Phase 2); `"cloud"` legalized in Phase 3 (Managed Agents); `"rooms"` in Phase 4. Cells not yet legal are rejected with a clear message. For `claude × cloud`, **`cloud.repos[*].prBranch` is required** (the branch the agent must push, for reconstruction — a missing value is a schema error, not a runtime "branch not found"; review).

**Selection** — generalize the switch to a `(provider, runtime)` lookup (a `Record<provider, Partial<Record<runtime, AgentRunner>>>` capability map collapses `selectRunner` + `resolvePersistedRuntime` + the config triple), throwing a typed `RunnerNotConfiguredError` / `IllegalProviderRuntimeError` on an unconfigured or illegal cell.

**`ClaudeRunner` construction → Claude Agent SDK `query()` options** (signatures confirmed against `@anthropic-ai/claude-agent-sdk@0.3.183`): `cwd ← input.cwd`; `model ← input.model.id` (+ optional `fallbackModel`); `mcpServers ← input.mcpServers`; `agents ← input.agents`; for unattended auto-approve **`permissionMode: "bypassPermissions"` AND `allowDangerouslySkipPermissions: true`** — the SDK requires the paired flag (verified: the type doc states *"`bypassPermissions` … requires `allowDangerouslySkipPermissions`"*; Codex P1), else option validation fails at startup; **`env: { ...process.env, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY }`** (from wiring config, D6 — `env` is replace-semantics, so spread `process.env` to keep `PATH`/`HOME`). Cancellation: Ship's input carries a `signal: AbortSignal`, but `query()` takes an `abortController: AbortController` — the runner **owns an internal `AbortController` and aborts it when `input.signal` fires** (the `AbortSignal`→`AbortController` bridge; Copilot). Terminal `SDKResultMessage` (`SDKResultSuccess | SDKResultError`) → `AgentRunResult`: `status ← subtype` (`success` vs. `error_*`) / `is_error`; on success `summary ← result`; on error `errorMessage ← errors[]` (joined) + `terminal_reason`; `durationMs ← duration_ms` (bonus available: `total_cost_usd`, `usage`, `num_turns`, `permission_denials`).

## 7. Key flows

**Flow A — Claude local dispatch (happy path).**
1. `ship.ship { provider: "claude", runtime: "local", workdir, docPath }` → schema validates the cell.
2. `selectRunner("claude", "local")` → the `ClaudeRunner`.
3. `ClaudeRunner.run` builds `query({ prompt, options: { cwd, model, env, permissionMode, mcpServers, agents, abortController } })`.
4. `for await (msg of query())` → each message passed to `onEvent` (pass-through: ndjson write + heartbeat, exactly as cursor).
5. Terminal `result` message (`subtype: "success"`) → map to `AgentRunResult { status: "succeeded", summary: result, durationMs: duration_ms }` → persisted.

**Flow B — Claude failure mapping (the gap to mind).**
- Error subtypes (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`) → `status: "failed"`.
- The error variant (`SDKResultError`) has no `result` text field, **but** (confirmed against 0.3.183) it carries a structured **`errors: string[]`** plus `terminal_reason` and `permission_denials`. So `errorMessage ← errors.join(...)` (with `terminal_reason` as detail), and the `subtype` is the category signal — *not* a synthesis from the last assistant message (that's only a fallback if `errors` is empty). For `error_during_execution` specifically (where the cause lives inside tool output, not a top-level field), the projection scans the event tail backward for the last assistant message carrying a tool result with `is_error: true`, rather than the last assistant message blindly (Claude review). The `ClaudeEventProjection` feeds `classify-failure.ts` with Claude-native predicates so categories are meaningful (e.g. `error_max_turns` → a budget/turn category, not cursor's `contention`).

**Flow C — Cancellation.**
- `handle.cancel()` / a fired `input.signal` → the runner aborts its **internal** `AbortController` (passed to `query()` as `options.abortController`) for a hard stop, optionally `query.interrupt()` for a graceful mid-turn stop. The idempotent cancel state machine (`terminated` / `cancelInitiated` guards, retry-on-transient) is reused verbatim from `@ship/agent-runner`.

**Flow D — Gateway routing.**
- The runner injects `ANTHROPIC_BASE_URL` + the virtual key (`ANTHROPIC_API_KEY` → `x-api-key`, or `ANTHROPIC_AUTH_TOKEN` → `Bearer`) into `options.env` per run.
- Gateway validates the key, meters/caps spend, forwards upstream. A gateway 4xx/5xx surfaces as an SDK error → `status: "failed"` with the gateway message folded into `errorMessage` (§8).

**Flow E — Claude Managed Agents cloud dispatch (Phase 3).**
1. `ship.ship { provider: "claude", runtime: "cloud", cloud: { repos: [{ url, startingRef, prBranch }] } }` → `selectRunner("claude","cloud")` → `CloudClaudeRunner`.
2. Ensure an **agent** (`POST /v1/agents` — model, system, tools incl. the GitHub MCP server) and a cloud **environment** (`POST /v1/environments`) exist (created once + cached, or per wiring config).
3. **Create session** (`POST /v1/sessions`) with `resources[] = [{ type: "github_repository", url, checkout: { type:"branch", name: startingRef }, authorization_token: <GH PAT> }]`.
4. **Dispatch:** open the SSE stream (`GET /v1/sessions/{id}/events/stream`), then `POST /v1/sessions/{id}/events` a `user.message` carrying the rendered prompt **plus an instruction to commit to a prescribed branch `prBranch` and open a PR via the GitHub MCP** (there's no `autoCreatePR` flag).
5. **Stream → `onEvent` (pass-through) + session-status terminal detection.** Forward each MA event (`agent.message`, `agent.tool_use`, `session.status_idle`, `session.error`, …) to `onEvent`/ndjson unchanged. **Cloud terminal detection does NOT go through the `EventProjection` classify loop** (review — "Option C"): MA's `session.*` SSE shapes differ structurally from local SDK messages, and terminal state is a top-level *session status*, not a classified event. `CloudClaudeRunner` reads it directly — success = `session.status_idle` with **`stop_reason.type === "end_turn"`** (`stop_reason` is an *object*, not the string `"end_turn"`); `terminated` / `session.error` → failed; `status_idle` with `stop_reason.type` = `max_tokens`/budget → **failed** (task may be unfinished → `budget-exceeded`); `requires_action` → needs a tool-confirmation turn, not done. The `classify-failure` seam stays **local-only**.
6. **Reconstruct the result:** MA returns no branch/PR. **Primary:** parse the GitHub-MCP `create_pull_request` tool-call result off the stream — it carries the PR URL + branch directly (exact payload confirmed in the 3a spike). **Fallback:** `gh` lookup-by-head-branch for the prescribed `prBranch` (covers a missing/malformed tool-result; races with PR-creation timing). Fill `AgentRunResult.branches[] = [{ repoUrl, branch: prBranch, prUrl }]` — the `CloudCursorRunner` shape. `attach()` re-opens the SSE stream (+ dedup against `GET /events`); the id-mapping + replay contract are open (§10.12).

**Flow F — Claude in rooms (Phase 4).**
- `ship.ship { provider: "claude", runtime: "rooms" }` → `RoomAgentRunner` spawns `sudo -E rooms run --runner claude --image agent-alpine-claude.ext4 …` with `ANTHROPIC_BASE_URL` added to `buildRoomsEnv()`.
- Reads the *same* artifact contract (`events.ndjson` / `result.json` / `summary.md`) → `AgentRunResult` with the pushed branch in `branches[]`. The bulk of the work is rooms-repo-side (bake a `claude-runner.js` guest emitting the contract); the ship-side change is parameterizing `--runner` and the env. Rooms already sidesteps the event-shape classifier (it reads `result.json` status directly), so this path is *cleaner* than local.

## 8. Concurrency / consistency / failure model

- **Per-run env isolation.** Gateway base-URL + key go through `options.env`, never a global mutation, so N concurrent Claude runs with distinct keys don't interfere.
- **Failures are values, not throws** (cursor's invariant, preserved). Pre-run failures (`query()` construction throws, missing key) reject `handle.result` wrapped in a `RunFailedError`; post-run failures resolve `handle.result` with `status: "failed"`. The `MissingApiKeyError` precondition reads `ANTHROPIC_API_KEY` (not `CURSOR_API_KEY`) and carries a Claude-specific message.
- **Mid-stream transport throw (the gateway-down race).** The SDK can throw from the `query()` async iterator **before any terminal `result` message** — so there's no event for the projection to read (Codex P2). The run pipeline wraps the for-await in an explicit catch that **finalizes a failed `AgentRunResult`** (classified `gateway-unreachable`, falling back to `sdk-throw`) instead of letting the throw escape — preserving the "post-run failures resolve as failed" invariant and preventing a rejected handle / orphaned `running` row. Classification here does **not** depend on `EventProjection`.
- **`attach()` on `ClaudeRunner`.** Throws a typed `OperationNotSupportedError` with a clear message ("Claude local runner does not support attach; use run()"), not an abstract-method crash — the `@ship/agent-runner` state machine accounts for it explicitly (Claude review).
- The cursor-specific `contention` / SQLite-lock category does *not* apply to Claude; the projection is what keeps that policy from mis-firing. A new `gateway-unreachable` `FailureCategory` is added (§10.5) so operators can tell "gateway misconfigured" from "agent crashed."
- **Managed Agents cloud terminal/failure (Phase 3).** No `succeeded` status — success = `session.status_idle` with **`stop_reason.type === "end_turn"`** (an object, not the string); failure = `terminated` status, `session.error`, or `status_idle` with `stop_reason.type` = `max_tokens`/budget (task may be unfinished). Terminal detection is read from session status directly, **not** via the classify projection (§7 Flow E, "Option C"). The branch/PR reconstruction (§7 Flow E) can itself fail (the agent didn't push, or used a different branch) — a **distinct** failure the runner surfaces (`status: "failed"`, `errorMessage` = "expected branch `<prBranch>` not found"), not a silent empty `branches[]`. Cancellation = a `user.interrupt` event then `archive`/`delete` (can't delete a `running` session).
- **Windows — confirmed (§10.1).** The SDK ships the Claude Code binary as a platform optional-dep; `@anthropic-ai/claude-agent-sdk-win32-x64` (a 225 MB `claude.exe`, `os: ["win32"], cpu: ["x64"]`) installed cleanly on a Windows host during the de-risk spike. CI's Windows matrix is therefore supported. (Defensive fallback retained: if a future pinned version drops the Windows binary, the `ClaudeRunner` should still fail fast with a clear "unsupported platform" error rather than a confusing SDK crash — the cursor path is unaffected regardless.)

## 9. Rollout / implementation plan

Scope bands are weighted-LOC per the repo budget (production 1.0×, tests 0.5×, docs/config 0×). Each row is a PR boundary or a small group.

| Phase | Goal | High-level tasks | Depends-on | Scope | Gate |
|---|---|---|---|---|---|
| **1 — Seam neutralization** | Generalize the runner seam with **zero behavior change** for cursor (additive only — no field removals). | **1a** Rename `CursorRunner`→`AgentRunner` (checklist: `grep -r "instanceof CursorRunner"` — duck-typed today, but one missed `instanceof` passes `tsc` and fails at runtime); extract `@ship/agent-runner` (interface, handle state machine, classification policy, error taxonomy, fake, `EventProjection` incl. `toolCallId` + neutral `McpServerConfig`/`AgentDefinition` interfaces); `@ship/cursor-runner` supplies `CursorEventProjection` (normalizing cursor's raw spellings to the canonical vocabularies). **1b** De-cursor the identity surface (watch-URL builder, trailer param in `prompt-template`, `agent-not-created` sentinel); **add** `agentId`+`provider` to the MCP output alongside the kept `cursorAgentId`; add `provider` column (default `cursor`). | — | 1a ~ideal (mechanical moves + re-fixtured imports); 1b ~amazing–ideal | **VALIDATION GATE** (§11): full `make check` green ubuntu+windows, cursor tests unchanged, projection-equivalence test (classifier OUTPUT over **real golden `events.ndjson`**) passes. |
| **2 — Claude local runner** | `provider:"claude", runtime:"local"` ships real work through the gateway. | **2a** `@ship/claude-runner` — `ClaudeRunner` (local), terminal mapping, `ClaudeEventProjection`, `@anthropic-ai/claude-agent-sdk` import-isolation test, gateway env injection, fake reuse. 2a checklist: `bypassPermissions` + `allowDangerouslySkipPermissions:true`; `gateway-unreachable` category + mid-stream-throw catch path; `UnsupportedPlatformError` (constructor-time binary check) in public exports; verify `McpServerConfig` field-compat with `query()` (shim if needed); a `PATH`-injection test confirming `env` replace-merge handling; **provider-aware prompt rendering** — `prompt-template.ts` (rendered in `core`, the provider-agnostic layer) hardcodes the Cursor subagent-dispatch protocol (the `task`-tool `subagent_type` enum, `Explore`/`Bash`/`Browser`, the Cursor trailer); Claude has no such `task` tool, so render a Claude prompt contract (parameterize the dispatch block by provider, or move rendering behind the runner) — this is a different prompt contract, not a parameter swap (review). **2b** Generalize `selectRunner` to `(provider,runtime)` + capability map; add `claude` config slot to `default-wiring`; thread `provider` through MCP/CLI schema + cross-field refinement (claude→local). | Phase 1 (gate) | 2a ~ideal; 2b ~amazing | L3: a real Claude-local run through a (local/mock) gateway edits a fixture repo and resolves `succeeded` (§11). |
| **3 — Claude Managed Agents (cloud)** | `provider:"claude", runtime:"cloud"` drives Claude Managed Agents (Anthropic-hosted). | **3a** `CloudClaudeRunner` over the Managed Agents REST API (`/v1/sessions` create → `user.message` dispatch → SSE stream → `status_idle`/`stop_reason.type` terminal **read from session status, not the classify projection** — §7 Flow E); events pass through to `onEvent` opaquely; `attach()` = re-open SSE + dedup. **3b** branch/PR reconstruction — inject the GitHub MCP (**remote/HTTP transport — not local stdio**, §10.15) + a prescribed-branch push/PR instruction; parse the `create_pull_request` result (primary) / `gh` lookup (fallback). **3c** extend `CloudRunSpec` (repo resources incl. **required `prBranch`**, agent/env ids, the GH PAT) + legalize `(claude, cloud)`. | Phase 2 (gate) | 3a ~ideal; 3b ~amazing; 3c ~amazing | L3 mocked-MA in CI + L4 live MA→fixture push + reconstruct (§11). |
| **4 — Claude in rooms** | `provider:"claude", runtime:"rooms"` — Ship-hosted microVM runtime. | **ship:** parameterize `RoomAgentRunner --runner {cursor,claude}` + inject `ANTHROPIC_BASE_URL` into `buildRoomsEnv`. **rooms-repo (separate):** bake `claude-runner.js` guest + `agent-alpine-claude.ext4` image emitting the artifact contract (the bulk). | Phase 2 (gate) | ship side ~amazing; rooms side cross-repo (separate budget) | L3: a microVM run pushes a branch via `--runner claude` to a fixture repo, returning it in `branches[]` (§11). |

**Sequencing.** All four phases are planned; they run in **dependency order**: Phase 1 (the neutral seam) → Phase 2 (the Claude provider) → Phases 3 and 4 (Claude's `cloud` and `rooms` runtimes — both build on the provider, are independent of each other, so either order / in parallel). Phase 1 carries a hard **validation gate**: it must land green with zero cursor regression (§11) before anything builds on the renamed seam — that's an engineering checkpoint, not a scope hedge. Phase 4's rooms-repo guest-image work is cross-repo (its own budget).

## 10. Open questions

1. ~~**Windows binary (gates Phase 2).**~~ **RESOLVED (spike, 2026-06-19, SDK 0.3.183).** `@anthropic-ai/claude-agent-sdk-win32-x64` ships a 225 MB `claude.exe` (`os: ["win32"], cpu: ["x64"]`) and installed cleanly on a Windows host; `-win32-arm64` is also published. Windows is supported — Phase 2 is unblocked on this axis. Pin a known-good version and keep a fail-fast platform guard as defense.
2. ~~**`options.env` merge vs. replace.**~~ **RESOLVED (spike).** `options.env` is **replace**, not merge (the SDK's own doc example spreads `...process.env`). The runner injects `env: { ...process.env, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY }`.
3. **`cursor_runs` table rename.** Add `provider` column + leave the name (proposed), or migrate to `agent_runs`? → Proposed: leave; revisit as hygiene.
4. **Gateway config surface.** `ShipServiceConfig`/wiring default (proposed, D6) with an optional per-run `envVars` override — confirm the override is wanted in v1 or deferred.
5. ~~**Claude failure taxonomy.**~~ **DECIDED (review):** add a **`gateway-unreachable`** category (the gateway is first-class; distinguishable from `sdk-throw`); `budget-exceeded` maps from the `error_max_budget_usd` subtype. Wired in 2a.
6. **Neutral package boundary.** New `@ship/agent-runner` (proposed, D3) vs. folding the neutral mechanism into a renamed `cursor-runner`. → Proposed: new package, cleanest SDK isolation.
7. ~~**Claude resume.**~~ **DECIDED:** defer wiring; `ClaudeRunner.attach()` throws `OperationNotSupportedError` (§8). Claude's Phase 2 surface is local-only (cloud lands in Phase 3, §4 D1); even cursor-local `attach()` is unsupported.
8. **`options.env` semantics — final verification (2a).** The de-risk spike read replace-semantics from the SDK's own doc example; confirm definitively with the `PATH`-injection test (§9, 2a) — type signatures don't capture merge-vs-replace (Claude review).
9. **Gateway forwards the Managed Agents paths? (Phase 3's gateway story).** A gateway must proxy `/v1/sessions*` + `/v1/agents` + **`/v1/environments*`** (review — Flow E creates/refreshes an environment) + the SSE `/events/stream` path; **stream SSE without buffering** (a buffer-to-complete proxy makes long sessions appear hung — a separate test dimension from path-routing); and **pass the `anthropic-beta: managed-agents-2026-04-01` header un-stripped** (stripping → 400 / standard-API fallthrough the runner must surface as a clear error, not an opaque SDK one). Most gateways are tuned for `/v1/messages` only. Managed Agents is *architecturally* routable (plain Anthropic-SDK HTTP honoring `base_url`), but this needs a **live probe** before the cloud path counts as gateway-governed. If it can't, Phase 3 still works against `api.anthropic.com` directly (just ungoverned).
10. ~~**Branch/PR reconstruction (Phase 3b).**~~ **DECIDED (review):** parse the GitHub-MCP `create_pull_request` tool-call result off the stream as the **primary** path (direct PR URL + branch; exact payload confirmed in the 3a spike), with `gh` lookup-by-head-branch as **fallback** (the earlier "gh is more robust" framing was backwards — `gh` races with PR-creation timing).
11. **Managed Agents beta + agent/env lifecycle.** The API is public beta (`managed-agents-2026-04-01`); the SDK's `/bridge` surface is `@alpha` on an independent break track (we avoid it — Phase 3 uses the REST API directly). Decide: create the agent/environment per-run vs. reuse a cached one from wiring config — **note the staleness risk on the cached path** (a cached agent pins a model + system prompt, so a later run with a different `ModelSelection` silently uses the wrong model; key the cache on a model+prompt hash, or create per-run + destroy: one extra API call, no staleness).
12. **Cloud `attach()` id-mapping + SSE replay (Phase 3).** `AgentRunAttachInput` requires `agentId` AND `runId`; Managed Agents has a single `sessionId` (no separate run id / `getRun`). Decide: map `sessionId` → both, or add a sessionId-keyed attach variant. Also specify the SSE replay contract (full replay vs. resume-from-offset / `Last-Event-ID`) + the dedup key — §7 Flow E's "dedup against `GET /events`" depends on it. (Distinct from §10.7, which covers only *local* attach.)
13. **Cloud cancel idempotency (Phase 3).** §8's cancel is a two-step `user.interrupt` → `archive`/`delete`, but the reused `@ship/agent-runner` state machine guards a single `cancel()`. Spec which step retries on transient failure, what happens if the session goes `idle` between the steps (the "can't delete a running session" precondition flips), and whether a failed `archive` leaves an orphaned/billable session.
14. **GH PAT secret class (Phase 3).** A repo-write GitHub PAT is shipped into a Managed Agents session (§2 Auth, §7 Flow E) — Ship holds no raw PAT today. Confirm source (wiring config), minimum scopes, env-only handling, and redaction in session-create logging.
15. **GitHub MCP transport for Managed Agents (Phase 3b, review).** The neutral `McpServerConfig` expresses only a *local stdio* subprocess; a **hosted** MA session can't reach a local stdio process on the caller's machine. The GitHub MCP for MA must be a remote/HTTP MCP endpoint. Decide: extend `McpServerConfig` with an `http`/`{url}` transport (and have `CloudClaudeRunner` pass it to the session's tools config), or source a dedicated remote GitHub-MCP config from wiring (separate from `AgentRunInput.mcpServers`).

## 11. Validation plan

- **Phase 1 gate (binary go/no-go).** Full `make check` (incl. coverage) green on **ubuntu + windows** after the rename + projection extraction, **with the existing cursor runner/classifier tests passing unmodified**, plus a new **projection-equivalence test**: assert the **classifier OUTPUT** (`FailureCategory` + detail — not merely the projection's return values) is identical pre- and post-refactor over a corpus of **real `events.ndjson` checked in as golden fixtures** (synthetic events miss the failure-taxonomy edges the classifier was built around — the `database is locked` → `contention` path, `EXPIRED`, the `call_id` running-tool reconciliation). Zero behavior change = go.
- **Phase 2 gate.** **L3 (CI, no external services):** `ship.ship { provider:"claude", runtime:"local" }` against a fixture repo with a **`FakeAgentRunner`** (or a mocked SDK) asserts the dispatch → event pass-through → terminal-mapping wiring; an **L2** failure-path test asserts each error `subtype` → `status: "failed"` + a sensible `FailureCategory`. **L4 (live, gated, not in default CI):** a real Claude Agent SDK run through a local gateway edits a file and resolves `succeeded`. The Windows-binary question (§10.1) is resolved (binary confirmed, or the runner platform-gated with a passing test).
- **Phase 3 gate.** **L3 (CI):** a **mocked Managed Agents transport** (fake session-create + canned SSE) asserts create → dispatch → terminal (`status_idle`/`stop_reason.type`) → branch/PR reconstruction → `branches[]`, plus the branch-not-found `failed` path and `attach()` re-stream — no live Anthropic/GitHub creds. **L4 (live, gated):** a real MA session against a fixture repo pushes the prescribed branch via the GitHub MCP and the runner reconstructs `branches[0]` + the PR. (The repo's taxonomy keeps L3 fake/in-memory; the live MA + GitHub path is **L4**, not L3 — review.) Record the §10.9 gateway-path probe as governed-vs-direct.
- **Phase 4 gate (rooms).** An L3 microVM run pushing a branch via `--runner claude` to a fixture repo, returning the pushed branch in `branches[]`; plus the rooms-repo guest-image build (cross-repo).
