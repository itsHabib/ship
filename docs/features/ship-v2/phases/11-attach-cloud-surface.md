# Phase 11 — `CursorRunner.attach` cloud surface

Status: design ready
Owner: ship (cursor)
Date: 2026-05-23

> First of 3 sequential PRs implementing the phase 08 design. This PR ships the **attach surface** — the interface, the error classes, the cloud-runner implementation that re-attaches to an in-flight cloud agent, and the local-runner negative path. Spike findings already incorporated into [phase 08](08-agent-resume.md) via PR #74. Dossier task: `tsk_01KSBJ2Z2QQEQZTWBD6FQE0PCY` (`phase-8a-cloud-attach-surface`).

## Scope

**Weighted LOC budget — ~310, "amazing" band in 1 PR.**

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `cursor-runner/src/runner.ts` (interface) + `cloud-runner.ts` (impl) + `local-runner.ts` (throw) + `errors.ts` (2 new classes) + `fake.ts` (attach mock) | ~200 | 200 |
| Tests | `errors.test.ts` + `cloud-runner.test.ts` (attach paths) + `local-runner.test.ts` (negative) + `fake.test.ts` | ~220 | 110 |
| **Total** | | | **~310** |

Files this phase touches:

- `packages/cursor-runner/src/runner.ts` — **MODIFY**: add `attach(...)` method to the `CursorRunner` interface; add `CursorRunAttachInput` shape.
- `packages/cursor-runner/src/cloud-runner.ts` — **MODIFY**: implement `attach`. Reuses the same post-`agent.send` pipeline as `run` (stream → wait → finalize via `mapCloudRunResult`).
- `packages/cursor-runner/src/local-runner.ts` — **MODIFY**: implement `attach` to throw `LocalResumeNotSupportedError` unconditionally.
- `packages/cursor-runner/src/errors.ts` — **MODIFY**: add `CursorAgentNotFoundError` + `LocalResumeNotSupportedError` classes.
- `packages/cursor-runner/src/fake.ts` — **MODIFY**: add a fake `attach` (resume-able / not-found variants) so downstream callers can unit-test against the surface.
- `packages/cursor-runner/src/cloud-runner.test.ts` — **MODIFY**: assert `attach` succeeds against a fake-SDK resume-able agent (events stream + `wait` resolves); assert `attach` throws `CursorAgentNotFoundError` when the fake SDK rejects resume.
- `packages/cursor-runner/src/local-runner.test.ts` — **MODIFY**: assert `attach` throws `LocalResumeNotSupportedError`.
- `packages/cursor-runner/src/errors.test.ts` — **MODIFY**: pin the new error classes' shape (`agentId` / `runId` / `runtime` fields on `CursorAgentNotFoundError`).
- `packages/cursor-runner/src/fake.test.ts` — **MODIFY**: pin the fake's attach branches.

Out-of-scope files (handled by phase 12 / phase 13):

- `packages/core/src/service.ts` — startup `resumeOrphanedRuns` scan + `activeRuns` idempotency → **phase 12**.
- New event-pump file → **phase 12**.
- `ship.resumed` synthetic event emit → **phase 12**.
- `e2e/scenarios/cloud-resume.e2e.test.ts` → **phase 13**.

## Summary

Today's `CursorRunner` interface admits `run(input)` only. When a cloud cursor agent runs and the Ship process dies mid-run, there's no way to re-attach to that agent from a fresh process. This PR adds `CursorRunner.attach(input)` — the SDK-level primitive that re-attaches by `agentId` + `runId`. The cloud impl uses `Agent.resume(agentId, { apiKey })` + `Agent.getRun(runId, { runtime: "cloud", agentId, apiKey })` (per the spike, both calls need `apiKey` — it is NOT inherited from a prior `resume`). The local impl throws `LocalResumeNotSupportedError` because local agents die with the parent process (the spike's findings explicitly note this — Q4 in `pers/cursor-sdk-resume-spike/findings.md`).

The orchestration around `attach` — Ship's startup auto-resume scan, the event-pump, and the `ship.resumed` synthetic event — is **deferred to phase 12**. This PR only ships the primitive that phase 12 will call.

## Functional requirements

### F1 — `CursorRunner.attach(...)` interface

```ts
interface CursorRunner {
  run(input: CursorRunInput): Promise<CursorRunHandle>;
  // NEW
  attach(input: CursorRunAttachInput): Promise<CursorRunHandle>;
}

interface CursorRunAttachInput {
  readonly agentId: string;
  readonly runId: string;
  // Re-passed because the SDK doesn't carry these across Agent.resume.
  readonly model: ModelSelection;
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly agents?: Record<string, AgentDefinition>;
  readonly cloud?: CloudRunSpec; // required when the cursor_run is runtime: cloud
  readonly onEvent: (event: SDKMessage) => void | Promise<void>;
  readonly signal?: AbortSignal;
}
```

`attach` returns the same `CursorRunHandle` shape as `run`. The downstream caller can't distinguish between "fresh run" and "attached run" at the handle level — both yield events via `onEvent` and resolve `result` on terminal.

### F2 — `CloudCursorRunner.attach` implementation

1. `Agent.resume(input.agentId, { apiKey })` → `SDKAgent`. Map `UnknownAgentError` to `CursorAgentNotFoundError` (see F6).
2. `Agent.getRun(input.runId, { runtime: "cloud", agentId: input.agentId, apiKey })` → `Run`. **Pass `apiKey` explicitly** — the SDK does NOT carry auth context from the prior `Agent.resume` call, even within the same process (verified by phase 08 spike, 2026-05-23). The SDK's normal `CURSOR_API_KEY` env fallback still applies, but auth context from `resume` is not implicit. Map cloud-side HTTP 404 / 410 to `CursorAgentNotFoundError` too.
3. From here the pipeline is identical to `run`'s post-`agent.send` path: stream events via `sdkRun.stream()`, terminal via `sdkRun.wait()`, finalize via `mapCloudRunResult`. The shared helper in `_shared.ts` already handles this; `attach` just wires the resumed `Run` into the same path.

### F6 — Error classes

New in `packages/cursor-runner/src/errors.ts`:

```ts
export class CursorAgentNotFoundError extends Error {
  readonly agentId: string;
  readonly runId: string;
  readonly runtime: "local" | "cloud";
  constructor(args: { agentId: string; runId: string; runtime: "local" | "cloud"; cause?: unknown });
}

export class LocalResumeNotSupportedError extends Error {
  readonly agentId: string;
  constructor(args: { agentId: string });
}
```

`CursorAgentNotFoundError` is the unified type for both SDK-side `UnknownAgentError` AND cloud-side HTTP 404/410. The spike observed both depending on which ID was stale (bad agentId vs terminal-and-purged runId).

`LocalResumeNotSupportedError` is thrown unconditionally by `LocalCursorRunner.attach`. Local agents die with the parent process; pretending to support resume would invite misuse.

## Tradeoffs

(Inherited from [phase 08](08-agent-resume.md#tradeoffs). Slice-specific notes only.)

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Surface shape | Add `attach` method to existing `CursorRunner` (per phase 08 ED-1) | Redesign `CursorRunHandle` to be re-resolvable | Additive; doesn't break existing `run` callers. |
| Local runner support | Throw `LocalResumeNotSupportedError` (per phase 08 ED-2) | Implement local attach via SDK's `Agent.resume` on local agents | Local agents die with the process — there's nothing to resume. Explicit error is honest. |

## Engineering decisions

(Inherited from [phase 08](08-agent-resume.md#engineering-decisions). The relevant EDs for this slice are ED-1 and ED-2; ED-3/4/5 cover phase 12's scope.)

## Validation plan

- **Unit (`cloud-runner.attach`)** — fake-SDK harness exposes a resume-able agent; assert `attach` returns a handle whose `onEvent` receives the streamed events and whose `result` resolves on terminal.
- **Unit (`cloud-runner.attach` negative)** — fake SDK rejects `Agent.resume` with `UnknownAgentError`; assert `attach` throws `CursorAgentNotFoundError` with the right `agentId` / `runId` / `runtime: "cloud"`. Same for fake-SDK rejecting `Agent.getRun` with a 404/410-shaped error.
- **Unit (`local-runner.attach`)** — assert `attach` throws `LocalResumeNotSupportedError` unconditionally; assert the error's `agentId` field round-trips the input.
- **Unit (`errors`)** — pin the new error class shapes (constructor args, public fields, `instanceof Error`).
- **`make check`** — full repo green (typecheck + lint + format-check + 659+ unit tests).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `attach` semantics drift from `run`'s contract (e.g. handle shape mismatch) | Downstream callers (phase 12) need branch logic | Reuse the same `_shared.ts` helper for the post-`agent.send` pipeline; assert in tests that the handle shape is identical. |
| Test-only fake SDK fails to model the SDK's real `Agent.resume` + `Agent.getRun` behavior | Unit tests pass but real cloud breaks | Phase 13's L3 scenario test catches this against real cloud. For this PR, the fake is grounded in the spike's observed behavior (resume → getRun(apiKey) → stream/wait same as run). |
| `CursorAgentNotFoundError` mapping misses a real cloud failure mode | Resume failure surfaces as a generic error, not the typed `CursorAgentNotFoundError` | Mapping covers both SDK `UnknownAgentError` and cloud HTTP 404/410 per spike observations; extend if phase 12's resumeOrphanedRuns or phase 13's L3 scenario uncovers more variants. |

## Out of scope

(This PR ships ONLY the attach primitive. The following are phase-12+ scope:)

- F3 — `ShipService.resumeOrphanedRuns()` startup scan.
- F4 — `events.ndjson` continuity + `ship.resumed` synthetic event.
- F5 — Per-run event-pump heartbeat.
- ED-3 — Eager resume scan at `createShipService`.
- ED-4 — `activeRuns` registry idempotency.
- ED-5 — `mcpServers` / `agents` re-pass from wiring (the *behavior* is part of phase 12; the *interface shape* admits it via `CursorRunAttachInput`'s optional fields landing in this PR).
- L3 — end-to-end scenario test.

## Implementation plan

Single PR. Step list = commit boundaries.

1. **Error classes.** Add `CursorAgentNotFoundError` + `LocalResumeNotSupportedError` to `errors.ts`. Update `errors.test.ts` to pin the shapes. **Validation:** `pnpm --filter @ship/cursor-runner test errors` green.

2. **Interface + types.** Add `attach(input)` to `CursorRunner` interface; add `CursorRunAttachInput` type. No impl yet — both `CloudCursorRunner` and `LocalCursorRunner` get stub throws so the typecheck passes. **Validation:** typecheck green; no test added yet.

3. **CloudCursorRunner.attach impl.** Wire `Agent.resume` + `Agent.getRun({ apiKey })` + pipeline reuse via `_shared.ts`. Error mapping in the `catch` block (both `UnknownAgentError` and HTTP 404/410). Update `fake.ts` with a resume-able variant. **Validation:** `pnpm --filter @ship/cursor-runner test cloud-runner` green; positive + negative paths covered.

4. **LocalCursorRunner.attach impl.** Replace the stub throw with a real `LocalResumeNotSupportedError` throw. Update `local-runner.test.ts` with the negative test. **Validation:** `pnpm --filter @ship/cursor-runner test local-runner` green.

5. **`make check`.** Full repo green. Note any lint/format drift introduced by the changes.

## Cross-refs

- Overall design: [`08-agent-resume.md`](08-agent-resume.md) — F1, F2, F6, ED-1, ED-2.
- Spike findings (external to this repo, lives in the operator's `pers/` tree as a sibling to `pers/ship/`): `pers/cursor-sdk-resume-spike/findings.md` — Q1 ✓ (attach is live), Q2 ✓ (agents survive), Q3 endpoint reachable, Q4 deferred.
- Spike-derived doc tweaks already landed: PR #74 (`docs(phase-8): incorporate SDK resume spike findings`).
- Predecessor: [`04-cursor-cloud-runner.md`](04-cursor-cloud-runner.md) — `CloudCursorRunner` introduced.
- Successor: phase 12 (`12-resume-orchestration.md`) — consumes `attach` to wire ShipService startup scan + event-pump.
- Dossier task: `tsk_01KSBJ2Z2QQEQZTWBD6FQE0PCY` (`phase-8a-cloud-attach-surface`).
