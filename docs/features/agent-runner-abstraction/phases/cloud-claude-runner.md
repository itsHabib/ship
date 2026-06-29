# Phase 3a — `@ship/claude-runner`: CloudClaudeRunner (Managed Agents)

**Status:** ready to ship
**Owner:** human:mh (driven by claude-code:michael)
**Date:** 2026-06-27
**Dossier:** project `ship`, phase `agent-runner-claude-cloud`, task `cloud-claude-runner` (`tsk_01KW3NSF0K5S1PGXWM1S2N8FHW`)
**Design:** [`docs/features/agent-runner-abstraction/spec.md`](../spec.md) — §4 D5, §6, §7 Flow E, §8 (cloud terminal/failure), §9 Phase 3, §10.9–13, §11 (Phase 3 gate)

## Scope

| Bucket | Files | Weighted |
|---|---|---|
| Production | `packages/claude-runner/src/cloud-runner.ts` (the runner + pipeline, ~320 raw), `packages/claude-runner/src/cloud-session.ts` (SDK calls: client build, ensure-agent/env, create-session, dispatch, stream, archive — ~180), `packages/claude-runner/src/cloud-terminal-map.ts` (stream → terminal `AgentRunResult`, ~140), `packages/claude-runner/src/errors.ts` (+`CloudSessionError`), `packages/claude-runner/src/index.ts` (+`CloudClaudeRunner` export) | ~640 |
| Tests (0.5×) | `packages/claude-runner/src/{cloud-runner,cloud-session,cloud-terminal-map}.test.ts` (mocked SDK; happy path + every failure mode + attach/dedup), `test/sdk-import-isolation.test.ts` (extend for `@anthropic-ai/sdk`) | ~360 raw → ~180 |
| Config/docs (0×) | `packages/claude-runner/package.json` (+`@anthropic-ai/sdk`), root `pnpm-lock.yaml`, this doc | 0 |
| **Total** | | **~820** |

Band: **stretch** (`< 1000`). Justified no-split: the runner, the SDK-call seam, and the terminal mapper are one tightly-coupled cloud adapter — the runner is dead code without the session calls and the terminal map, and the terminal map's failure taxonomy can't be tested without the runner's pipeline. Branch/PR **reconstruction** is the natural fault line and is split out to **3b** (`cloud-claude-branch-reconstruction`); the **selector/schema/wiring** is **3c** (`cloud-claude-selector`). This PR delivers a fully-tested-in-isolation runner that no selector yet reaches (mirrors how 2a shipped `LocalClaudeRunner` ahead of the 2b selector). If it busts stretch, split `cloud-session.ts` (ensure-agent/env + create + dispatch) into its own PR ahead of the pipeline and note the gap; do **not** split the terminal mapper from the runner.

## Context

Phase 2 (merged, #153/#154) shipped `LocalClaudeRunner` + the `(claude, local)` selector wiring. `@ship/claude-runner` owns the Claude provider; it depends on `@anthropic-ai/claude-agent-sdk` (local, `query()`) for the local runner. This task adds the **cloud** runtime to the same package: a `CloudClaudeRunner` over **Claude Managed Agents** — a *different SDK* (`@anthropic-ai/sdk`, the base Anthropic SDK, `client.beta.sessions.*`), not the agent SDK.

`CloudCursorRunner` ([cursor-runner/src/cloud-runner.ts](../../../../packages/cursor-runner/src/cloud-runner.ts)) is the **structural reference** — the dispatch → stream-to-terminal → finalize → `attach()` pipeline, the `createSdkRunHandleState` + `buildSdkRunHandle` reuse, the `safelyEmit` / bounded-event-capture mechanism, and the redact-secrets-in-debug-logging pattern. Mirror its shape; only the SDK surface differs.

**Why this is more than wiring** (spec §4 D5): Managed Agents is gateway-routable (the SDK honors `baseURL`) — the edge over Cursor cloud, which can't be proxied. And it has **no native branch/PR result** + a **session-status terminal signal** (no `succeeded` status) that is structurally unlike the local SDK's `result` message.

**The provider plumbing already exists from Phases 1–2** — do not re-add: `agentProviderSchema` includes `claude`; the `provider`-keyed sentinel/trailer/watch-url helpers handle claude (default-skip); `store.recordCursorRun({ provider })` persists it. This task **consumes** them; **3c** wires the selector/schema that routes `(claude, cloud)` to this runner.

## SDK contract (confirmed against the installed `@anthropic-ai/sdk@0.106.0` types)

`client.beta.sessions.*` is the dispatch surface. `sessions.create` **requires** an `agent` (id) and an `environment_id` — so an agent + environment are prerequisites (the sessions-vs-agents question resolves to: **sessions for dispatch, agents + environments are referenced config**, per §10.11).

- **Client** — `new Anthropic({ apiKey, baseURL })` (`@anthropic-ai/sdk`). `baseURL` is the gateway-routability seam (honored). Per-run construction, no global mutation (concurrency-safe). Beta header: pass `betas: ["managed-agents-2026-04-01"]` per call (or a default `anthropic-beta` header on the client). Auth: `ANTHROPIC_API_KEY` (→ `x-api-key`) or `ANTHROPIC_AUTH_TOKEN` (→ Bearer), env-only.
- **Environment** — `client.beta.environments.create({ name, config: { type: "cloud", networking?, packages? } })` → `{ id }`. `type: "cloud"` = **Anthropic-hosted** (the agent's bash/edit tools run server-side); NOT `self_hosted` (which routes tools back to the client). `networking` must permit egress for `git push` + the GitHub MCP host (3b) — `BetaUnrestrictedNetwork` for the L4 fixture, `BetaLimitedNetwork { allow_mcp_servers, allowed_hosts:[github.com,…] }` for hardened deployments.
- **Agent** — `client.beta.agents.create({ model, name, system?, tools?, mcp_servers? })` → `{ id, version }`. `tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: <always-allow> }, configs: [] }]` enables bash/edit/read/write/glob/grep with **auto-approve** (the cloud analog of local `bypassPermissions`). `mcp_servers` (remote URL transport) carries the GitHub MCP in 3b. **Verify the exact `tools`/`permission_policy` param shapes against the installed types** (the always-allow policy type name + the toolset-params variant) — build the mock from the real types.
- **Session** — `client.beta.sessions.create({ agent: agentId, environment_id, resources, title?, metadata?, betas })` → `BetaManagedAgentsSession { id, status, … }`. Repo mount: `resources: [{ type: "github_repository", url, authorization_token: <GH PAT>, checkout: { type: "branch", name: startingRef } }]`.
- **Dispatch** — `client.beta.sessions.events.send(sessionId, { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }], betas })`.
- **Stream** — `await client.beta.sessions.events.stream(sessionId, { betas })` → `Stream<BetaManagedAgentsStreamSessionEvents>` (async-iterable; `for await`). Each event carries a unique `id` + a `type` discriminator.
- **History (attach dedup)** — `client.beta.sessions.events.list(sessionId, { betas })` → paginated `BetaManagedAgentsSessionEvent`s.
- **Cancel / cleanup** — `events.send(sessionId, { events: [{ type: "user.interrupt" }] })` then `client.beta.sessions.archive(sessionId)` (cannot delete a `running` session; archive after idle/terminated).

### Terminal detection — read session status off the stream, NOT the classify projection (§7 Flow E "Option C")

The cloud SSE shapes differ structurally from local `SDKMessage`s, and terminal state is a top-level *session status*, not a classified event. The `classify-failure`/`EventProjection` seam stays **local-only**. Reconcile the spec drift: `session.status_idle.stop_reason` is one of `end_turn` | `requires_action` | `retries_exhausted` — there is **NO `max_tokens`** stop_reason in the cloud API (that was the local SDK). Terminal map:

| Stream signal | Outcome |
|---|---|
| `session.status_idle`, `stop_reason.type === "end_turn"` | **succeeded** (turn done naturally) |
| `session.status_idle`, `stop_reason.type === "retries_exhausted"` | **failed** → `budget-exceeded` |
| `session.status_idle`, `stop_reason.type === "requires_action"` | **failed** (unattended can't satisfy a tool-confirmation; record `event_ids`) — should not occur with an all-`always_allow` toolset |
| `session.status_terminated` (event) / session `status === "terminated"` | **failed** → category from the last `session.error` seen, else `unknown` |
| stream ends / `session.deleted` with no terminal seen | **failed** → `sdk-throw` ("stream ended without a terminal session status") |

`session.error` is **not itself terminal** — it carries `retry_status` (`retrying` = transient, keep consuming; `exhausted` = turn dies → expect a following `status_idle`; `terminal` = session dies → expect `status_terminated`). Capture the **last** `session.error` as failure context for the terminal mapper; never finalize on it directly.

## Functional requirements

- **FR1 — `CloudClaudeRunner implements AgentRunner`** (`packages/claude-runner/src/cloud-runner.ts`). `run(input)` validates `input.runtime === "cloud"` (else `WrongRunnerError`), validates `input.cloud` is present with a single repo (`MissingCloudSpecError` / `InvalidCloudReposError` — mirror `CloudCursorRunner`'s runtime guard for non-TS callers), reads `ANTHROPIC_API_KEY` (`MissingApiKeyError` naming `ANTHROPIC_API_KEY`), then drives the cloud pipeline. Reuses `createSdkRunHandleState` + `buildSdkRunHandle` verbatim — **no new state machine.** Holds no per-run state (construct once, reuse across runs).
- **FR2 — `cloud-session.ts` SDK seam** (the only file that imports `@anthropic-ai/sdk`). Pure mechanism, no policy:
  - `buildClient(apiKey, baseUrl?)` → `new Anthropic({ apiKey, ...(baseUrl && { baseURL: baseUrl }) })`. `baseUrl`/auth read from `process.env` (`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`) — the gateway-routability path (D6, §10.9). No global mutation.
  - `ensureEnvironment(client, spec)` → reuse `spec.environmentId` if provided, else `environments.create({ name: "ship/<runId>", config: { type: "cloud", networking } })`. Returns the env id + an `ownedEnv` flag (created-by-us → archive on cleanup).
  - `ensureAgent(client, { model, system, tools, mcpServers, spec })` → reuse `spec.agentId` if provided, else `agents.create({ model: input.model.id, name: "ship/<runId>", system, tools: <always-allow toolset>, mcp_servers })`. **Create per-run** so a per-run `ModelSelection` is honored with no staleness (§10.11); returns id + `ownedAgent`.
  - `createSession(client, { agentId, environmentId, repo, prBranch, pat })` → `sessions.create({ … resources … })`.
  - `dispatch(client, sessionId, prompt)` → `events.send(...)`.
  - `openStream(client, sessionId)` → `events.stream(...)`; `listEvents(client, sessionId)` → `events.list(...)`.
  - `interruptAndArchive(client, sessionId)` + `archiveOwned(client, { sessionId, agentId?, environmentId? })` — best-effort cleanup (swallow secondary errors, like cursor's `asyncDispose`).
- **FR3 — pipeline** (mirror `CloudCursorRunner.#runPipeline`). After `run()` resolves the handle: `for await (ev of stream)` → `recordEvent(ev)` (bounded tail, `MAX_CLASSIFICATION_EVENTS`) + `safelyEmit(ev)` (pass-through to `onEvent`/ndjson, swallowing sync throws + async rejections). On each event, feed the **terminal detector** (cloud-terminal-map); the **first** terminal session-status signal finalizes the run. `finally`: best-effort cleanup of owned session/agent/env + `detachSignalListener()`. Events pass through **opaquely** — no projection on the cloud path.
- **FR4 — terminal mapping** (`cloud-terminal-map.ts`, provider-local). A small reducer over the stream events producing an `AgentRunResult`:
  - **succeeded**: `{ status: "succeeded", summary: <concatenated `agent.message` text, last turn>, durationMs, branches: [] }` (branches filled by 3b; this PR leaves `branches: []` and the prescribed-branch instruction is 3b's).
  - **failed**: `{ status: "failed", errorMessage, durationMs, sdkTerminalStatus: <"status_idle:retries_exhausted" | "status_terminated" | "session.error:<type>" | "stream-throw">, failureCategory, failureDetail, classificationEvents: <bounded tail> }`.
  - `durationMs`: from the session `stats.duration_seconds`/`active_seconds` (×1000) when available on a final `sessions.retrieve`, else wall-clock measured in the runner. (No `duration_ms` on the idle event.)
- **FR5 — failure model** (spec §8):
  - **Failures are values, not throws.** **Pre-dispatch** failures (env/agent/session create throw, missing key) **reject `run()`** wrapped in `AgentRunFailedError` (core's `runToTerminal` catch → `finalizeFailure`), mirroring `CloudCursorRunner.#startAgent`. **Post-dispatch** failures (stream throw, terminal failed-status) **resolve `handle.result`** with `status: "failed"`.
  - **Mid-stream transport throw** (the gateway-down race): the `events.stream()` await or the `for await` can throw before any terminal session status. Catch it and **finalize a failed `AgentRunResult`** (classified `gateway-unreachable` for connection/gateway shapes — `ECONNREFUSED`/`ENOTFOUND`/`fetch failed`/4xx-5xx/beta-header-stripped 400 — else `sdk-throw`); never let it escape (no rejected handle, no orphaned `running` row).
  - **Cloud failure → `FailureCategory`** (cloud-specific table; reviewer judgment on category choice, but each must be sensible + carry a clear `errorMessage`): `retries_exhausted` → `budget-exceeded`; `session.error` `billing_error` → `budget-exceeded`; `model_overloaded_error`/`model_rate_limited_error`/`model_request_failed_error`/`credential_host_unreachable_error` → `gateway-unreachable`; `mcp_connection_failed_error`/`mcp_authentication_failed_error` → `gateway-unreachable` (the MCP host is unreachable/unauthorized); `unknown_error` / no-terminal-stream-end → `sdk-throw`/`unknown`. Reuse the existing `gateway-unreachable` + `budget-exceeded` literals from Phase 2 — **no new `FailureCategory` literals** needed.
- **FR6 — `attach()`** (`AgentRunAttachInput`). The cloud-orphan-resume path (§10.12). Re-open `events.stream(input.agentId)` and **dedup** replayed history against the live stream by event `id` (a `Set<string>` of seen ids; the SDK replays prior events on re-stream + `events.list` gives the authoritative history). Resolves on the same terminal detection. **id-mapping decision:** the handle's `agentId` AND `runId` are both the **session id** (`sesn_…`) — Managed Agents has a single session id, no separate run id (§10.12). `attach()` reads `input.agentId` as the session id. Emit a synthetic `ship.resumed` event first (mirror cursor) so downstream sees the re-attach.
- **FR7 — `@anthropic-ai/sdk` import-isolation** (`packages/claude-runner/test/sdk-import-isolation.test.ts`). The existing test asserts `@anthropic-ai/claude-agent-sdk` is imported only in `@ship/claude-runner`. **Extend it** to also assert `@anthropic-ai/sdk` is imported only in `@ship/claude-runner` (same walker; a second module-specifier assertion) and that `cloud-session.ts` is the only file naming it inside the package (a focused intra-package check, optional but tidy). Add `@anthropic-ai/sdk` to the package `dependencies` (pin `0.106.0`); `pnpm install`.
- **FR8 — secret redaction.** The GH PAT (`authorization_token`) + the API key never reach argv or logs. Any debug dump of the session-create payload redacts `authorization_token` (mirror `loggableCloudOptions`); the key is built in `cloud-session.ts` and never logged.

## Engineering decisions

- **ED-1 — mirror `CloudCursorRunner`, don't invent.** Same pipeline skeleton (`#runPipeline`/`safelyEmit`/`recordEvent`/`finalizeOk`/`finalizeError`), same `createSdkRunHandleState`/`buildSdkRunHandle` reuse, same redact-and-dump-on-start-failure diagnostics. Only the SDK calls change.
- **ED-2 — isolate the SDK in one file** (`cloud-session.ts`). The pipeline + terminal map import only neutral types + the thin seam, so they're testable with a fake seam and the SDK mock lives in one place. Keeps the import-isolation surface a single file.
- **ED-3 — create agent per-run, reuse-or-create environment** (§10.11). The agent pins model+system+tools, so a per-run agent honors `input.model` with zero staleness; the environment is model-independent container config and may be reused from wiring (`spec.environmentId`). Both owned-by-us ids are archived best-effort after terminal. Accept pre-made `agentId`/`environmentId` from the cloud spec for the cached path.
- **ED-4 — terminal detection is a reducer, not the classifier** (§7 Flow E). `cloud-terminal-map.ts` reads `session.*` statuses directly. The neutral `classify-failure` + `EventProjection` are NOT used on the cloud path (they read local message shapes). This keeps cursor + local-claude classification untouched.
- **ED-5 — `agentId = runId = sessionId`** (§10.12). One session id maps to both handle fields; attach re-streams it. The per-run MA agent/env ids live only in the run-process closure for cleanup; on crash-resume they're not recovered (minor archivable leak — Risk).
- **ED-6 — `betas` on every call.** Pass `["managed-agents-2026-04-01"]` to create/send/stream/list/archive. A gateway that strips the header → a 400 the mid-stream/pre-dispatch catch surfaces as `gateway-unreachable` with a clear message (§10.9).

## Validation

- **L3 (CI, no external services) — the gate.** A mocked `@anthropic-ai/sdk` (fake `beta.environments`/`beta.agents`/`beta.sessions` returning canned ids + a canned SSE async-iterable) drives `run()` → ensure-env → ensure-agent → create-session → dispatch → stream → `session.status_idle{end_turn}` → resolves `succeeded`. Build the mock from the **real installed types**.
- **L2 (failure paths).** Each mode → `status: "failed"` + the mapped category: `retries_exhausted` → `budget-exceeded`; `session.status_terminated` after a `session.error` (`model_overloaded`/`billing`/`mcp_connection_failed`) → the mapped category; mid-stream throw → `gateway-unreachable`; stream-ends-without-terminal → `sdk-throw`; pre-dispatch `sessions.create` throw → `run()` rejects `AgentRunFailedError`; missing `ANTHROPIC_API_KEY` → `MissingApiKeyError`; wrong runtime / multi-repo → `WrongRunnerError`/`InvalidCloudReposError`.
- **attach/dedup (FR6).** A canned `events.list` history + a re-stream that replays an overlapping prefix → events dedup by `id`, the `ship.resumed` event emits first, terminal resolves once.
- **Coverage + check.** `make check` green **ubuntu + windows** incl. the coverage gate (claude-runner ≥ 90/85/90/90 — branch-cover every failure mode, not just happy path; cf. `feedback_run_full_coverage_gate`). The new `@anthropic-ai/sdk` import-isolation assertion passes.
- **L4 (live, gated — NOT default CI).** A real Managed Agents session against a fixture repo resolves `succeeded` (branch reconstruction is 3b's L4). Plus the §10.9 **gateway-path probe**: confirm the gateway forwards `/v1/environments` + `/v1/agents` + `/v1/sessions*` + the SSE `events/stream` (un-buffered) + the `anthropic-beta` header un-stripped. Operator-verified; record governed-vs-direct.

## Risks

- **SDK shape drift.** Param shapes for `tools`/`permission_policy` and the exact `agent_toolset_20260401` create-params variant were not all read in full — **verify against the installed `0.106.0` types** and build the mock from them, not from this doc. A wrong field is a runtime failure the L2 mock catches only if the mock mirrors the real shape.
- **`session.error` transience.** Treating `session.error` as terminal would mis-finalize a `retrying` error. The reducer must wait for `status_idle`/`status_terminated` and only use the last `session.error` as context (FR-terminal table).
- **Cleanup leak on crash-resume** (ED-5). A resumed run can't archive the per-run MA agent/env (ids lost). Minor + archivable later; note in the runner. Optionally stash the agent/env ids in session `metadata` at create time so a resume can recover + clean them (nice-to-have; defer).
- **Gateway buffering SSE** (§10.9). A buffer-to-complete proxy makes a long session look hung. The duration cap (core `runWithDurationCap`) bounds it; the gateway probe is the real check (L4).
- **`environments`/`agents` quota.** Per-run agent creation adds 1–2 control-plane calls + objects per run. Cheap vs a multi-minute session; archived after terminal. If quota bites, switch to the cached-from-wiring path (already supported via `spec.agentId`/`environmentId`).

## Out of scope

- **Branch/PR reconstruction** — the GitHub-MCP inject, the prescribed-branch dispatch instruction, and `create_pull_request`-result parsing / `gh` fallback are **3b** (`cloud-claude-branch-reconstruction`). This PR leaves `branches: []` and a plain prompt.
- **The `(claude, cloud)` selector + `cloudClaude` wiring + MCP/CLI schema + `CloudRunSpec` extension** — **3c** (`cloud-claude-selector`). No selector reaches this runner yet.
- **Orphan-resume routing by provider** (core must call `CloudClaudeRunner.attach()` for a claude-cloud row, not `CloudCursorRunner.attach()`) — verified/handled in **3c**.
- Rooms (Phase 4); the SDK `/bridge` (Claude Code Remote) surface; subscription/OAuth auth.
- Capturing `usage`/token cost (bonus; the seam shouldn't preclude it — `session.usage` is available — but don't wire it).

## Implementation plan (PR boundary = this whole task)

1. `package.json` += `@anthropic-ai/sdk@0.106.0`; `pnpm install`; confirm the workspace typechecks.
2. `cloud-session.ts` — the SDK seam (client build, ensure-env/agent, create-session, dispatch, stream, list, interrupt/archive). Verify every param shape against the installed types.
3. `cloud-terminal-map.ts` — the stream-event reducer → `AgentRunResult` (success + the failure table) + the cloud failure-category mapping.
4. `cloud-runner.ts` — `run()`/`attach()` + `#runPipeline` (mirror `CloudCursorRunner`), the AbortController/cancel bridge via `createSdkRunHandleState`, the mid-stream-throw catch, best-effort cleanup. `errors.ts` += `CloudSessionError`; `index.ts` exports `CloudClaudeRunner`.
5. Tests: `cloud-session` (mocked SDK), `cloud-terminal-map` (every terminal/failure shape), `cloud-runner` (L3 happy path, L2 failures, attach/dedup). Build mocks from real installed types.
6. Extend `test/sdk-import-isolation.test.ts` for `@anthropic-ai/sdk`.
7. `make check` green (ubuntu + windows incl. coverage). Run the `code-reviewer` + `validator` subagents before the structured summary.
