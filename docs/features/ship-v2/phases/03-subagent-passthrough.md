# Phase 03 — subagent passthrough

Status: design draft, revision 2 (2026-05-17). Cycle-1 review addressed; awaiting merge.
Owner: itsHabib
Date: 2026-05-16

> **Companion docs.** [spec.md](../spec.md) § Planned V2 phases originally seeded this slot as "review-cycle phase"; this doc reframes it and the spec.md amendment lands in the same PR. [docs/cursor-sdk-leverage.md](../../../cursor-sdk-leverage.md) § Tier 2 #4 ("Subagent layer for the V2 review-cycle phase") is the source-of-record for the reframing. [docs/cursor-sdk-typescript.md](../../../cursor-sdk-typescript.md) § Subagents is the SDK reference. [phases/02-open-pr.md](02-open-pr.md) is the immediate predecessor V2 phase + template for this doc's shape.

## Scope

**Weighted-LOC budget — doc-only this PR. 0×.** Amazing trivially.

Follow-up implementation PR's preliminary budget: ~25 src (`CursorRunInput` field + `LocalCursorRunner` plumb + re-export) + ~80 tests (0.5×) + ~30 LOC of committed `.cursor/agents/*.md` (0×) = **~65 weighted LOC**. Trivially amazing.

## Summary

The V2 spec originally planned phase 03 as a "review-cycle phase" — a new `Phase.kind = "review"` driving a separate review agent against an open PR. The qe-sdet parallel-driver session (friction #13 in the operator's parallel-driver corpus — kept outside this repo, summarized inline below) surfaced that the costly part of the review loop isn't running another AI reviewer — bot reviewers (Codex / Claude / Copilot) already do that for free — it's the driver thrashing context across N PRs during cycle-1 fixes.

Cursor's SDK already exposes the primitive that addresses the actual gap: **subagents**. A parent agent can delegate `code-reviewer` / `test-writer` / etc. inside the implement phase via the built-in `Agent` tool, catching issues *before* the PR opens. Ship's `LocalCursorRunner` doesn't currently pass `agents` or `local.settingSources` to `Agent.create`, so the primitive is inaccessible to anyone running through Ship.

This phase plumbs the SDK's subagent surface end-to-end:

1. `LocalCursorRunner` unconditionally passes `local.settingSources: ["project"]`. The SDK then auto-loads `.cursor/agents/*.md` (and `.cursor/mcp.json`) from the workdir.
2. `CursorRunInput` grows an optional `agents` field. `LocalCursorRunner` passes it through inline. Per SDK precedence, inline definitions override file-based ones with the same name.
3. The Ship repo commits `.cursor/agents/code-reviewer.md` to start dogfooding. Sibling subagents (`pr-budgeter`, `naming-cop`, `samurai-sword-checker`) land via follow-up PRs as evidence of utility accrues.

What this phase explicitly **does not** do:

- It does not add a new `Phase.kind`. Subagents fire inside the existing implement phase; no new state machine.
- It does not add a new MCP tool. The `ship.ship` input schema is unchanged.
- It does not orchestrate the *outer* review loop (bot reviewer requests, comment fetching, cycle counting). That ritual remains in the `parallel-driver` skill + `CLAUDE.md § Shipping Features`.
- It does not introduce cloud-runtime support — that's phase 04 ([04-cursor-cloud-runner.md](04-cursor-cloud-runner.md)).

The originally-planned phase 03 ("review-cycle phase") is **dissolved**. Phase 05 (CI-repair) shape is revisited separately when its design doc is written.

## Functional requirements

### F1 — `LocalCursorRunner` enables project-level setting sources

`LocalCursorRunner.run` passes `local.settingSources: ["project"]` to every `Agent.create` call. The SDK then auto-loads:

- `.cursor/agents/*.md` — subagent definitions (per SDK doc § Subagents § file-based).
- `.cursor/mcp.json` — MCP server configs (per SDK doc § MCP servers § local loading precedence).

Only `"project"` is included. `"user"` and `"plugins"` are intentionally excluded — they make agent behavior non-reproducible across machines and CI, which violates V1's "every run is replayable from the recorded inputs" posture.

The change is unconditional (no flag). A workdir without `.cursor/agents/` simply has no file-based subagents to load; the SDK no-ops cleanly per the reference.

### F2 — `CursorRunInput.agents` plumbs inline subagents per run

```ts
// packages/cursor-runner/src/runner.ts
export interface CursorRunInput {
  // ...existing fields...
  readonly agents?: Record<string, AgentDefinition>;
}
```

`AgentDefinition` is re-exported from `@ship/cursor-runner` (per ED-3) so callers in `@ship/core` / `@ship/cli` / `@ship/mcp-server` can construct it without importing `@cursor/sdk` directly. `LocalCursorRunner` passes the value through to `Agent.create({ agents })`.

When both `agents` (inline) and `.cursor/agents/*.md` (file-based) are present, inline wins for any same-named key — matching the SDK's documented precedence.

If `input.agents` is undefined, the field is omitted from `Agent.create` entirely (no `agents: {}` empty-object call). Default for V1 callers is unchanged.

### F3 — Ship repo dogfoods `code-reviewer` from day one

`.cursor/agents/code-reviewer.md` is committed to the repo in the impl PR. Frontmatter shape per the SDK reference:

```markdown
---
name: code-reviewer
description: Pre-PR self-review. Catches what @claude/@codex/Copilot would flag in cycle 1.
model: inherit
---

Review the diff for bugs, security issues, edge cases, and adherence to
`CLAUDE.md` + the memory pointers (samurai-sword, no And/Or in names, no
Impl suffix, doc-first, PR sizing budget). Output a structured list of
findings ordered P0 → P3. Note any concerns about test coverage or
public-API breaks separately.
```

Every Ship-on-Ship run from then on exercises the file-based subagent path. If the SDK's subagent invocation breaks (e.g. SDK upgrade), Ship-on-Ship dogfood notices.

Sibling subagents (`pr-budgeter`, `naming-cop`, `samurai-sword-checker`, `doc-first-enforcer`) are **out of scope for this phase** — see Out-of-scope. They land as separate small PRs once `code-reviewer`'s utility is proven on a real run.

### F4 — Observability is a validation question, not a built feature

Whether subagent invocations surface in `events.ndjson` as `tool_call` events (or in some other shape) is **an SDK contract this phase validates, not changes**. The validation plan asserts what we observe. If observability is missing or partial:

1. File a chip via `mcp__ccd_session__spawn_task` capturing the gap.
2. Update the phase doc's Validation section with the observed shape.
3. Ship the feature anyway — the prompt-level subagent reasoning still helps even when the events stream doesn't capture the sub-run's internals.

### F5 — `mcpServers` from project loads at the same time

`local.settingSources: ["project"]` activates two file-based loaders in one switch: subagents AND MCP servers (`.cursor/mcp.json`). Both come for free with the same line.

This closes [docs/cursor-sdk-leverage.md § Tier 1 #1](../../../cursor-sdk-leverage.md) — the unpopulated `mcpServers` hook — without a separate phase. A workdir with `.cursor/mcp.json` will now have its servers passed through. Ship does not curate or seed `.cursor/mcp.json` for users; that's repo-level config.

**Precedence** between inline `CursorRunInput.mcpServers` and file-based `.cursor/mcp.json` follows the SDK's documented rule: inline overrides file-based at any colliding server-name key (per [docs/cursor-sdk-typescript.md § MCP servers § Local loading precedence](../../../cursor-sdk-typescript.md)). The behavior is symmetric with F2's `agents` rule — same inline-wins semantics, just one switch (`settingSources: ["project"]`) flips both file-based loaders on.

## Non-functional requirements

- **Backwards-compatible at every layer.** No SQL schema changes. No new MCP tools. `CursorRunInput.agents` is optional; existing callers unchanged. The unconditional `settingSources: ["project"]` is a behavior change for workdirs that already contain a `.cursor/` directory — documented in the impl PR's changelog.
- **No new SDK dependency.** `@cursor/sdk` is already a direct dep of `@ship/cursor-runner`. `AgentDefinition` is re-exported through the runner per ED-2 of V1 phase 05.
- **Workspace-agnostic posture preserved.** No Tower dependency. Subagent loading is keyed off the workdir Ship was already handed.
- **Strict TS + lint matching the rest of the repo.** No relaxations.
- **Tests at every changed layer.** `LocalCursorRunner` tests assert the new `Agent.create` args; one new L3 scenario (opt-in via `SHIP_LIVE=1`) validates the subagent fires + the observed event shape.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Default subagent loading source | File-based (`.cursor/agents/*.md` via `settingSources: ["project"]`) | Ship-curated defaults baked into the runner | Repo-curated keeps Ship out of opinion-creep land (samurai-sword from `feedback_samurai_sword.md`). Each repo evolves its own reviewer set; Ship just plumbs the SDK. Cross-repo standards live in `CLAUDE.md` already, not in a Ship-shipped subagent template. |
| Inline `agents` on `CursorRunInput` | Include | Skip — only file-based | Some callers (impl `ship.ship` doc that explicitly says "use this specific reviewer") want per-run override. Plumbing is ~5 LOC; deferring would require another design doc later. Inline overrides file-based at same key per SDK precedence — additive, no conflict. |
| `settingSources` values | `["project"]` only | `["project", "user"]` or `["all"]` | User-level subagents in `~/.cursor/agents/*.md` make agent behavior depend on the operator's local config, which breaks "every run is replayable from the recorded inputs" (V1 posture). Project-only keeps everything checked-in. |
| Dogfood scope this phase | One subagent (`code-reviewer`) | Full set (`code-reviewer` + 4 siblings) | One subagent is enough to validate the path end-to-end. Adding 5 at once couples the runner-change PR to the full reviewer-set design (which CLAUDE.md / memory-pointer phrasing matters for, and which reviewers will care about). Siblings ship one at a time as small follow-up PRs. |
| MCP `ship` input schema extension | NO inline `agents` exposed via MCP this phase | Yes — let agent callers override per-run via MCP input | Power-user knob, unclear value before we have one example of an agent wanting to override. Add later via a backward-compatible field if dogfood proves the need. Strict-mode schemas accept additive optional fields cleanly. |
| Cancellation behavior with subagents | Inherit existing `controller.signal` flow | Special-case subagent cancellation | Subagents share the parent run's `Run.cancel` per SDK design. `LocalCursorRunner`'s existing cancel path covers it; no special-case needed. Risk callout below for the (untested) case where a subagent is mid-execution at cancel time. |

## Engineering decisions

### ED-1 — `LocalCursorRunner` is the only layer that changes

`packages/cursor-runner/src/local-runner.ts` is the sole code edit. The `Agent.create` call grows two fields:

```ts
agent = await Agent.create({
  apiKey,
  model: { /* ... */ },
  local: {
    cwd: input.cwd,
    settingSources: ["project"],   // NEW — file-based subagents + mcpServers
  },
  ...(input.agents !== undefined && { agents: input.agents }),  // NEW — inline override
  ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
  ...(input.agentName !== undefined && { name: input.agentName }),
});
```

No other production file changes shape. `default-wiring.ts` doesn't need to plumb `agents` through — file-based loading is the default path. Callers that want inline override (mostly tests, possibly future MCP-input fields) construct `CursorRunInput.agents` directly.

### ED-2 — `CursorRunInput.agents` is the only public-API surface added

`packages/cursor-runner/src/runner.ts` gains one optional field:

```ts
export interface CursorRunInput {
  // ...existing fields...
  readonly agents?: Record<string, AgentDefinition>;
}
```

No other interfaces change. `ShipServiceConfig` doesn't need it; the active-run handle doesn't carry it; the store doesn't persist it (per ED-4).

### ED-3 — `AgentDefinition` is re-exported from `@ship/cursor-runner`

Per V1 phase 05 ED-2, only `@ship/cursor-runner` imports `@cursor/sdk`. To let `@ship/core` / `@ship/cli` / `@ship/mcp-server` construct `CursorRunInput.agents` without violating that boundary, `@ship/cursor-runner` re-exports the SDK's `AgentDefinition`:

```ts
// packages/cursor-runner/src/index.ts
export type { AgentDefinition } from "@cursor/sdk";
```

The import-isolation test (`test/sdk-import-isolation.test.ts`) is amended to allow this single re-export. The re-export is a type-only export; no runtime dependency leaks.

### ED-4 — Subagent definitions are NOT persisted on the run record

`CursorRunInput.agents` is per-run input. It does not get written to `cursor_runs` or `phases`. Reasons:

- File-based subagents live in the worktree (`.cursor/agents/*.md`) — checked in, replayable from the commit SHA. The SHA is already part of the run record.
- Inline `agents` is a power-user knob expected to be rare. Persisting it would duplicate prompt content (the SDK's `prompt` field on `AgentDefinition` is verbose) without clear consumer.
- If we later need replay-with-inline-agents, add a `cursor_runs.inline_agents_json` column then. Cheaper to add than to remove.

### ED-5 — Repo commits `code-reviewer.md` + cross-link from `CLAUDE.md`

The impl PR commits `.cursor/agents/code-reviewer.md` with the body shown in F3. `CLAUDE.md` grows a single line near the "Develop" section linking to it: "Subagents live in `.cursor/agents/`. See `docs/features/ship-v2/phases/03-subagent-passthrough.md` for the rationale."

No CLAUDE.md restructure beyond that one line. Heavy guidance about subagent style belongs in the subagent's own `.md` file, not in CLAUDE.md.

### ED-6 — Cancellation: subagents inherit parent `Run.cancel`

Per the SDK reference, subagents spawned via the built-in `Agent` tool share their parent run's lifecycle. `Run.cancel` propagates. `LocalCursorRunner`'s existing cancel pipeline (lines 97–107 of `local-runner.ts` today) needs no change.

Edge case acknowledged in Risks: if cancellation lands while a subagent is mid-execution, the SDK's documented behavior is to propagate — we don't independently verify this in unit tests. The existing L3 cancel scenario can be extended in a follow-up if needed.

## Validation plan

### Unit tests (Vitest)

- `cursor-runner`: `LocalCursorRunner.run` calls `Agent.create` with `local.settingSources: ["project"]` always.
- `cursor-runner`: `LocalCursorRunner.run` passes `agents` field when `input.agents` is set; omits the field entirely when undefined.
- `cursor-runner`: inline `agents` overrides file-based at same key (assert via mock that the inline value reaches `Agent.create`; SDK precedence is the SDK's responsibility).
- `cursor-runner`: import-isolation test amended to permit `AgentDefinition` re-export.
- `cursor-runner`: existing tests still pass (no regression in cancel / dispose / event-stream paths).

### Integration tests

None new at L2. The existing integration suite exercises `LocalCursorRunner` against a `FakeCursor` substitute, which doesn't need to change because the assertion is on the args passed *to* `Agent.create`, not on the SDK's behavior.

### L3 (live e2e, opt-in via `SHIP_LIVE=1`)

One new scenario under `e2e/scenarios/subagent-invocation.e2e.test.ts`:

1. Create a temp workdir with `.cursor/agents/code-reviewer.md` (frontmatter + prompt) and a tiny task doc that instructs the parent to invoke `code-reviewer`.
2. Fire `ship.ship` against the workdir.
3. Assert one of:
   - `events.ndjson` contains a `tool_call` event whose payload references `code-reviewer` (the optimistic shape).
   - `events.ndjson` lacks any subagent reference but the run completes successfully (the degraded-observability shape — still valid, just file a chip).
4. The test's assertion is permissive on the exact event shape; it asserts at minimum that the run reaches `succeeded` with `agents` configured.

The L3 test is the **load-bearing validation** for this phase. F4's chip path fires if the test surfaces a gap.

### Acceptance for the phase

- This PR (design doc + spec.md amendment) merged on main via inline review.
- Impl PR follows; merges with `make check` green on ubuntu + windows CI.
- L3 scenario added; reports observed subagent event shape in the impl PR description (informs whether F4's chip fires).
- `.cursor/agents/code-reviewer.md` committed; one subsequent Ship-on-Ship run validates the file is picked up.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Subagent invocations don't surface in `events.ndjson` | Driver loses visibility into what the parent delegated; review-the-review becomes opaque | F4: file a chip with the observed gap. Phase ships anyway — prompt-level review still helps. Future phase can enrich `events.ndjson` capture if it matters. |
| `local.settingSources: ["project"]` unconditional change surprises a workdir with stale `.cursor/agents/` | A repo with old / wrong subagent definitions silently changes parent-agent behavior | Documented in the impl PR's changelog. Workdirs that don't intentionally maintain `.cursor/agents/` simply don't have files to load — no surprise. |
| Subagent SDK invocations cost extra tokens / time per run | Ship-on-Ship runs become measurably slower / more expensive | One subagent (`code-reviewer`) initially keeps the cost bounded. The leverage doc Tier 1 #2 (token-usage tracking via `onDelta`) lands separately and gives us the data to budget against. |
| Cancellation during subagent execution leaves a partial state | Subagent may leave uncommitted edits in the worktree if cancel lands mid-execution; the parent run completes (or fails) without the subagent's changes being committed, so an operator inspecting the workdir post-cancel sees stale edits with no PR trail | SDK propagates cancel to subagents per the reference. No special-case in `LocalCursorRunner`. If dogfood surfaces a real bug here, file a chip and extend the L3 cancel scenario. |
| Inline `agents` API drifts when SDK adds new `AgentDefinition` fields | Type re-export stays accurate, but runtime behavior could shift | `AgentDefinition` is type-only re-exported — SDK changes propagate at compile time. Runtime field additions are non-breaking for current callers; new fields require explicit opt-in. |
| `.cursor/mcp.json` auto-loading from F5 surprises a workdir | A repo with a stale `.cursor/mcp.json` silently changes the agent's MCP server set | Same mitigation as the `settingSources` risk above — documented + repo-controlled. Ship is forwarding the SDK's existing convention; no new ground claimed. |

## Out of scope

- **Curated default subagent set baked into Ship.** Each repo curates its own per ED-1 / tradeoff #1. A future "starter pack" PR could add an opt-in `ship doctor --init-subagents` or similar, but it doesn't gate this phase.
- **MCP `ship` input schema extension to accept `agents` per call.** Power-user knob; add only if dogfood proves the need. Strict schemas admit additive optional fields backward-compatibly.
- **Sibling subagents (`pr-budgeter`, `naming-cop`, `samurai-sword-checker`, `doc-first-enforcer`).** Land as separate small PRs once `code-reviewer` proves the path. The Tier 2 #4 leverage doc seeds the names; each gets a one-line CLAUDE.md cross-link when it lands.
- **Cloud-runtime support for subagents.** Cloud has its own subagent loading path (`mcpServers` precedence section in SDK doc); same logic applies but lands when the cloud-runtime phase does.
- **Token-usage tracking via `onDelta`.** Leverage doc Tier 1 #2 — separate small phase.
- **Reading subagent definitions from task-doc front-matter.** Could be a clean per-doc override mechanism but adds parsing surface to validate.ts. Defer until concrete demand.
- **Restructuring `CLAUDE.md` to document subagent style standards.** One-line cross-link only; deeper guidance lives in the subagent's own `.md` file.

## Open questions

1. **Should the impl PR commit only `code-reviewer.md`, or also `pr-budgeter.md`?** Default: only `code-reviewer.md`. Smaller PR; second one validates the multi-subagent path with real evidence rather than speculation. Reconsider if Tier 2 #4's seed list is judged ship-ready as a unit.
2. **Should `settingSources` also include `"user"` behind an opt-in flag?** Default: no. The "every run is replayable from the recorded inputs" posture rules out non-checked-in config affecting runs. Operators who want user-level agents can symlink them into a repo's `.cursor/agents/` if they really need it.
3. **What's the exact `tool_call` event shape when the parent invokes a subagent?** Unknown; F4 says the L3 test answers this empirically. The phase doesn't gate on a specific shape — it gates on the run succeeding with subagents configured.
4. **Do subagents inherit the parent's tool set, or do they need an explicit `tools` declaration to read files / inspect diffs?** SDK reference is silent on this point. The F3 frontmatter snippet declares only `description` / `prompt` / `model` — if subagents need an explicit `tools` grant to be useful, that draft produces hollow reviews. L3 test should empirically observe the review's content quality; if hollow, the snippet grows a `tools` field and the SDK's actual schema is captured in the impl PR's changelog.
5. **Does the SDK error hard, or warning-and-skip, on a malformed `.cursor/agents/*.md` file?** F1 claims clean no-op on absent files, but the malformed case is unverified. If hard-error, the unconditional `settingSources: ["project"]` change could break Ship runs in repos with any `.cursor/` cruft. L3 test should include one malformed-agent fixture to observe the SDK's posture; if it hard-errors, F1 needs a recoverable-error story and Risks gains a row.
6. **Should the impl PR's L3 test be gated on `SHIP_LIVE=1` only, or also wired into the nightly CI matrix?** Default: opt-in only this phase. Promoting to nightly couples Ship's CI cost to subagent SDK billing. Revisit after qe-sdet phase 02 (mutation testing) lands its own nightly-only model.

## Implementation plan

After this doc is reviewed and merged:

1. **Extend `CursorRunInput` with optional `agents` field.** `packages/cursor-runner/src/runner.ts`. Re-export `AgentDefinition` from `packages/cursor-runner/src/index.ts`.
2. **Update import-isolation test.** Permit the `AgentDefinition` re-export; reject every other SDK re-export.
3. **Plumb `local-runner.ts`.** Add `settingSources: ["project"]` unconditionally; pass `agents:` through when `input.agents !== undefined`.
4. **Unit tests.** New cases per Validation § Unit tests. Use the existing `FakeCursor` substitute pattern.
5. **L3 scenario.** New file under `e2e/scenarios/subagent-invocation.e2e.test.ts` per Validation § L3. `SHIP_LIVE=1` gate.
6. **Commit `.cursor/agents/code-reviewer.md`.** Frontmatter + body per F3.
7. **Update `CLAUDE.md`.** One-line cross-link to subagent rationale.
8. **Land as one PR.** Estimated weighted budget ~65 weighted LOC. Trivially amazing-band.
