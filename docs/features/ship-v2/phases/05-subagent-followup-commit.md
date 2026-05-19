# Phase 05 — prompt-template: follow-up commit on subagent P0/P1 findings

Status: ready for impl
Owner: ship (cursor)
Date: 2026-05-19

> Predecessor: [03-subagent-passthrough.md](03-subagent-passthrough.md) — introduced subagent dispatch via cursor's `task` tool. This phase closes the loop between "subagent flagged a bug" and "bug fixed before PR opens."

## Scope

**Weighted LOC budget — ~15, "amazing" band.**

- `packages/core/src/artifacts/prompt-template.ts` — extend rule 8 with a follow-up-commit clause for P0/P1 subagent findings.
- `packages/core/src/artifacts/prompt-template.test.ts` — pin the new wording via additional `toContain` assertions in the existing "renders the full template" test.

## Summary

Phase 03 wired subagent dispatch into the implementation prompt (rule 8). PR #53's events.ndjson shows the regression: `code-reviewer` flagged the exact P1 (`--runtime cloud` without `--cloud-repo`/`--cloud <path>` slipping past CLI validation) that codex + claude later raised on the open PR. The finding existed in the run log. The main cursor agent saw it. Nothing happened because rule 8 says "consider invoking the subagents" but never says "act on what they return."

This phase plugs that gap. Rule 8 gets a closing clause: if any subagent returns a P0/P1, the agent fixes the finding, makes a second commit (`fix(...)` or `refactor(...)`, also Co-authored-by Cursor), then proceeds to the structured summary. P2/P3 findings continue to surface in the summary's risks section per the existing `.cursor/rules/use-subagents.mdc` contract.

The multi-commit pattern is deliberate (operator preference 2026-05-18): the follow-up commit is a separate, reviewable diff visible in the PR. No `--amend` dance, no squashing rule-7's commit into rule-8's fix.

## Functional requirements

### F1 — Rule 8 names the act-on-findings step

Render `renderImplementationPrompt(...)` and assert the output contains wording equivalent to:

> If any subagent returned a P0 or P1 finding, address it in the code, then make a second commit (`fix(...)` or `refactor(...)`, also `Co-authored-by: Cursor <cursoragent@cursor.com>`). Multiple commits per run are expected and fine — the follow-up commit should be separately reviewable. Surface P2/P3 findings in the structured summary's risks section instead.

The exact bytes don't matter (the test pins shape, not bytes per the file header). What matters is that the cursor agent reading the prompt unambiguously knows: (a) which severities trigger a fix, (b) that a new commit is required (not an amend), (c) which commit prefixes are appropriate, (d) where P2/P3 goes instead.

### F2 — Rule 8's existing guards still hold

The new clause must compose with rule 8's existing skip guards:

- "Skip this rule entirely if rule 7 was skipped" — if no original commit, no subagent invocation, no follow-up commit.
- "If the `task` tool's subagent_type enum only lists `generalPurpose | cursor-guide | best-of-n-runner` (no repo-registered subagents)" — also skip; no findings to act on.
- "If `task` returns an error … write `task-error: <verbatim error message>`" — the error path still surfaces to the blockers section; no fabricated follow-up commit.

### F3 — Test pins the new wording strictly enough to catch removal, loosely enough to survive minor rewording

Add `toContain` assertions to the existing "renders the full template" test in `prompt-template.test.ts` (around lines 47-57 where rule-8 assertions already live):

- A substring proving P0/P1 trigger a fix step.
- A substring proving the fix lands as a "second commit" (or equivalent) — not an amend.
- A substring proving `fix(...)` and/or `refactor(...)` commit prefix guidance is present.
- A substring proving P2/P3 routes to the structured-summary risks section.

Keep assertions sentence-fragments, not full sentences, so a copyedit on punctuation doesn't break the test.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Where the new clause lives | Inside rule 8 | New rule 9 (shift summary to rule 10) | The new step is a continuation of rule 8's subagent dispatch — same conditional, same skip guards. A separate rule would duplicate the guards and make rule 8 feel orphaned. |
| Multi-commit vs amend | Multi-commit (`fix(...)`) | `--amend` rule-7's commit to fold the fix in | Operator preference 2026-05-18: separate, reviewable diff per the PR-boundaries memory. Amend hides the subagent's contribution. |
| Severity threshold | P0 + P1 act, P2 + P3 surface | All findings act / All findings surface | Matches the existing `.cursor/rules/use-subagents.mdc` contract verbatim. Lower threshold burns cycles on nits; higher misses the bugs the subagents are deployed to catch. |
| Test strictness | Sentence-fragments via `toContain` | Snapshot or full-template equality | File header says "Pins shape, not exact bytes" — preserving that posture. Snapshot would churn on every copyedit. |

## Engineering decisions

### ED-1 — The clause lives at the end of rule 8, before the `task-error` fallback

Order: subagent dispatch instruction → enumerate subagents → skip guards → **act-on-findings** → task-error fallback. The act-on-findings step is what to do on the success path; the task-error fallback is the abort path. Success-path comes first in the prose.

### ED-2 — No changes to the subagent invocation order, count, or naming

Out of scope for this phase: re-ordering subagents to fire before commit, adding new subagents, changing subagent return shape. The change is purely "what the parent agent does with what subagents already return."

### ED-3 — No `CursorRunInput` interface changes

The prompt-template function's signature stays the same. No new fields in `RenderImplementationPromptInput`. The behavior change is entirely inside the rendered string.

## Validation

- `pnpm run check` green (lint + typecheck + format).
- `pnpm run coverage` green (unit tests + coverage thresholds).
- `prompt-template.test.ts` covers the new clause via the new `toContain` assertions in F3.
- Manual: read the rendered prompt output and confirm the rule-8 text reads naturally end-to-end.

## Risks

| Risk | Mitigation |
|---|---|
| Cursor reads the new clause as license to commit-spam (one commit per finding) | Wording explicitly says "a second commit" (singular), "multiple commits per run are expected and fine" — frames as a small N, not unbounded. Subagents return aggregated finding lists, not per-finding callbacks. |
| Rule 8 grows past readability | Current rule 8 is ~7 lines of TS array elements. New clause adds ~1-2 lines. Still well under any prose-density threshold. If it later balloons, split into rule 9 (separate guards become a problem) — not this phase. |
| Test assertions too strict, every rewording breaks the test | Assertions use sentence-fragments per ED in F3. Pinning "second commit" + "fix(...)" + "P0" + "P2/P3" + "risks section" tolerates copyedits. |
| Cloud cursor runner has different prompt-following fidelity than local | Out of scope to instrument. Per phase 04 design, both runners receive the same prompt via the `CursorRunner` interface. If cloud reliability diverges in practice, file a follow-up. |

## Out of scope

- Reordering subagents to fire *before* the rule-7 commit (operator explicitly prefers multi-commit).
- Adding new subagents or changing what existing subagents return.
- Driver-side (claude-code) habit of grepping `events.ndjson` for findings before opening a PR — that's a memory-level change, not a prompt-template change.
- Programmatic enforcement (Ship core inspecting events.ndjson and refusing PR open on unaddressed P0/P1) — out of scope; the prompt-level fix is the lighter-weight first step.

## Implementation plan

1. Edit `packages/core/src/artifacts/prompt-template.ts` — extend rule 8 with the follow-up-commit clause per F1. Keep wording sentence-clear; mention P0/P1 explicitly; name the commit prefixes `fix(...)` / `refactor(...)`; reference the `Co-authored-by` trailer; route P2/P3 to the structured-summary risks section.
2. Edit `packages/core/src/artifacts/prompt-template.test.ts` — add the `toContain` assertions per F3 inside the existing "renders the full template" test. Match the surrounding style: short comment above the assertions explaining what they pin.
3. `pnpm run check`.
4. `pnpm run coverage`.
5. Commit as `feat(prompt-template): follow-up commit on subagent P0/P1 findings` with the Cursor co-author trailer.

## Cross-refs

- Source events for the missed-finding incident: `wf_01KRWW0R9MK1R4QNEGP9KDS72S` (PR #53) events.ndjson — the `code-reviewer` `task` call's last `assistantMessage.text`.
- Predecessor: phase 03 ([03-subagent-passthrough.md](03-subagent-passthrough.md)).
- Subagent contract: `.cursor/rules/use-subagents.mdc`.
- Dossier task: `tsk_01KRXTRG0XGEW5C8NGFZ6R0SVX`.
