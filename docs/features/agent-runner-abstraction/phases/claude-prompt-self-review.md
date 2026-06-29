# Phase 2 follow-up — Claude prompt: self-review rule (drop phantom subagent dispatch)

**Status:** ready to ship
**Owner:** human:mh (driven by claude-code:michael) — **implemented by `codex` (provider dogfood / live-test)**
**Date:** 2026-06-28
**Dossier:** project `ship`, phase `agent-runner-claude-local`, task `claude-prompt-self-review`
**Design:** [`docs/features/agent-runner-abstraction/spec.md`](../spec.md) §6/§9 (Phase 2 prompt contract); follow-up to [`claude-local-runner.md`](./claude-local-runner.md) FR10.

## Scope

| Bucket | Files | Weighted |
|---|---|---|
| Production | `packages/core/src/artifacts/prompt-template.ts` — rewrite `claudeSubagentDispatchRules()` body + its doc comment (~12 changed) | ~12 |
| Tests (0.5×) | `packages/core/src/artifacts/prompt-template.test.ts` — rewrite the one `provider: "claude"` rule-7 test (~20 raw → ~10) | ~10 |
| Config/docs (0×) | this doc | 0 |
| **Total** | | **~22** |

Band: **amazing** (`< 500`). Pure prompt-string change in one function + its test. One PR; no split.

## Problem (found in live e2e testing)

A real `provider:"claude", runtime:"local"` smoke succeeded but logged blocker lines:
`subagent-error: Agent type 'code-reviewer' not found` / `'validator' not found` (run
`wf_01KW83KVD59FACC0JW58N91V79`, `claude-sonnet-4-6`).

Root cause: `claudeSubagentDispatchRules()` ([prompt-template.ts](../../../../packages/core/src/artifacts/prompt-template.ts) L53–63) instructs the agent to dispatch to the repo's registered subagents **"passed via the SDK `agents` option."** But nothing populates `input.agents` for a claude run — `core` never reads the repo's `.cursor/agents/*` for claude, and the Claude Agent SDK only auto-discovers `.claude/agents/*` (which the repo does not have). So the agent goes looking for `code-reviewer`/`validator`/`security-auditor`, they are not in its tool catalog, and it records `subagent-error` blockers. The run still succeeds; the blockers are noise from a promise the runner never fulfills.

This is a copy-paste artifact: the cursor prompt can promise those subagents because the cursor SDK loads `.cursor/agents/*` off disk via `local.settingSources: ["project"]` ([cursor-runner/src/local-runner.ts:64](../../../../packages/cursor-runner/src/local-runner.ts)). The claude rule was written the same way without the population side. Claude is, in fact, in the **same position as codex**: no repo review-subagents available in-run.

## Decision

Align Claude's rule 7 with the **codex self-review** pattern (`codexSubagentDispatchRules()` L65–69): the agent self-reviews (re-read the diff for conventions + run the repo's checks) before the structured summary, and does **not** attempt to dispatch the repo's registered review subagents or fabricate subagent output. This makes the prompt honest — it stops promising subagents the runner never wires.

**Not in this change:** actually wiring `.cursor/agents/*` → the Claude SDK `agents` option (translate the cursor `AgentDefinition` shape → Claude SDK agents and populate `input.agents`). That is the larger "real fix" and is deferred as its own scoped decision (cf. operator guidance to keep subagent loading provider-specific until ≥2 providers prove a unified API). Claude loses in-loop `code-reviewer`/`validator` coverage — the same as codex today; acceptable.

## Functional requirements

- **FR1 — rewrite `claudeSubagentDispatchRules()`** ([prompt-template.ts](../../../../packages/core/src/artifacts/prompt-template.ts) L53–63). Replace the multi-line subagent-dispatch body with a **single** rule-7 self-review line, faithful to claude (the surface exists but is not wired this run). Use this body verbatim:

  ```ts
  function claudeSubagentDispatchRules(): string[] {
    return [
      "7. Before producing the structured summary, self-review your work: re-read the diff for the operator's conventions and run the repo's check commands (`make check` or the equivalent detected from the repo). This run does not wire the repo's registered review subagents (code-reviewer / validator / security-auditor) into Claude's subagent surface — do not attempt to dispatch them or fabricate subagent output.",
    ];
  }
  ```

- **FR2 — update the function's doc comment** (the comment block immediately above `claudeSubagentDispatchRules`, currently L49–52, which explains the missing `followUpTrailerClause`). Rewrite it to state the new purpose: claude self-reviews like codex because the repo's review subagents are not wired into the Claude SDK `agents` surface in this run; the Claude Agent SDK auto-emits its own `Co-Authored-By: Claude` trailer, so there is still no prompt-instructed follow-up trailer to thread (hence no `followUpTrailerClause` parameter). Keep it short (≤4 lines), `//` comments, no JSDoc.

- **FR3 — keep the switch unchanged.** `subagentDispatchRules()` (L71–75) still routes `claude → claudeSubagentDispatchRules()`, `codex → codexSubagentDispatchRules()`, default → cursor. Do **not** collapse claude into the codex function — keep it its own function so the wording stays faithful per-provider (claude's surface exists-but-unwired; codex genuinely has none).

- **FR4 — rewrite the claude rule-7 test** ([prompt-template.test.ts](../../../../packages/core/src/artifacts/prompt-template.test.ts), the test currently titled `"claude provider uses SDK agents dispatch contract without Cursor task tool"`, ~L119–135). It asserts the **old buggy** contract (`registered subagents (passed via the SDK `agents` option)`, `Invoke them by name:`, `- \`code-reviewer\``, `subagent-error: <verbatim error message>`). Replace its body to assert the new self-review contract. Use:

  ```ts
  test("claude provider uses self-review rule without phantom subagent dispatch", () => {
    const out = renderImplementationPrompt({
      taskDoc: "minimal",
      repo: "x",
      worktreePath: "/w",
      provider: "claude",
    });
    expect(out).toContain("self-review your work");
    expect(out).toContain("run the repo's check commands");
    expect(out).toContain("do not attempt to dispatch them or fabricate subagent output");
    // The phantom-subagent contract (subagents promised but never wired) is gone —
    // these are the exact strings the buggy claude rule emitted.
    expect(out).not.toContain("registered subagents (passed via the SDK `agents` option)");
    expect(out).not.toContain("Invoke them by name:");
    expect(out).not.toContain("subagent-error: <verbatim error message>");
    // And it never adopts cursor's task-tool protocol.
    expect(out).not.toContain("Use `task` with subagent_type:");
    expect(out).not.toContain("built-in subagents (`Explore`, `Bash`, `Browser`)");
    expect(out).not.toContain("Co-authored-by: Cursor");
  });
  ```

  Leave every other test in the file unchanged (cursor and codex cases, and the claude-trailer test, must still pass).

## Tradeoffs

- Claude runs no longer get an in-loop `code-reviewer`/`validator` pass. They did not get a working one before (they errored instead), and codex already runs this way. The external review triad (Copilot/@codex/@claude on the PR) is unaffected.
- Wiring the real subagents would restore the in-loop pass but is a larger, separately-scoped change. Out of scope here on purpose.

## Engineering decisions

- **ED-1 — keep `claudeSubagentDispatchRules` as its own function.** Routing claude → `codexSubagentDispatchRules` would couple claude's prompt to a codex-named function (naming smell) and force one wording to cover two different truths. A 1-line function per provider is clearer and keeps each prompt faithful.
- **ED-2 — faithful wording.** Claude's SDK *does* expose a subagent surface; it is simply not wired with the repo's review agents in this run. Say exactly that ("does not wire … into Claude's subagent surface"), not codex's "has no inline subagent dispatch surface."

## Validation

- `make check` green (typecheck + lint + format + the `@ship/core` prompt-template tests). The rule-7 test rewrite is the behavioral gate.
- Self-review per rule 7 before the structured summary (re-read the diff; run the checks).
- Downstream proof (run by the operator after merge, not part of this PR): a fresh `provider:"claude", runtime:"local"` smoke whose result summary has **no** `subagent-error` blockers.

## Risks

- None material — a pure prompt-string change in one function and its unit test. No runtime/behavioral code path changes. If a stray assertion elsewhere references the old claude wording, update it to match (none expected beyond FR4).

## Out of scope

- Wiring `.cursor/agents/*` → the Claude SDK `agents` option (the larger "real fix"; deferred).
- Any change to the cursor or codex rule-7 blocks, or to `subagentDispatchRules`'s routing.
- The in-flight cloud-claude work (PR #161 / `cloud-claude-runner`) — do not touch.

## Implementation plan (PR boundary = this whole task)

1. Edit `claudeSubagentDispatchRules()` body + its doc comment (FR1, FR2).
2. Rewrite the claude rule-7 test (FR4).
3. Run `make check` (typecheck + lint + format + test); fix any fallout (none expected outside the two files).
4. Commit (Conventional Commit, e.g. `fix(core): claude prompt self-reviews instead of dispatching unwired subagents`).
