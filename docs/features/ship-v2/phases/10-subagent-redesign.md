# Phase 10 — Subagent set redesign (Cursor-aligned)

Status: design draft
Owner: ship (cursor)
Date: 2026-05-23

> Predecessor: [03-subagent-passthrough.md](03-subagent-passthrough.md) (introduced subagents) + [05-subagent-followup-commit.md](05-subagent-followup-commit.md) (rule 8 → rule 7 follow-up commit). Trigger: empirical audit of 6 firing ship runs (code-reviewer 2/2 P0/P1 bot-match rate; scope-tracker 0 P0/P1 ever; test-author + ci-checker never fired) cross-referenced with [Cursor's official subagent docs](https://cursor.com/docs/context/subagents) + [Cursor's agent best practices (Jan 9, 2026)](https://cursor.com/blog/agent-best-practices).

## Scope

**Weighted LOC budget — ~200, "amazing" band in 1 PR.**

Files this phase touches:

- `.cursor/agents/scope-tracker.md` — **DELETE** (rubber-stamp per audit).
- `.cursor/agents/ci-checker.md` — **DELETE** (dead surface, never invoked).
- `.cursor/agents/verifier.md` — **NEW** (Cursor's recommended Verifier pattern; complements `validator`).
- `.cursor/agents/debugger.md` — **NEW** (Cursor's recommended Debugger pattern; manual `/debugger` invocation).
- `.cursor/agents/security-auditor.md` — **NEW** (Cursor's recommended specialty for auth/payments/secrets).
- `.cursor/agents/code-reviewer.md` — keep, no content change.
- `.cursor/agents/naming-critic.md` — add explicit `model: composer-2-fast` (multi-model cost optimization).
- `.cursor/agents/validator.md` — add explicit `model: composer-2-fast`.
- `.cursor/agents/test-author.md` — add explicit `model: composer-2-fast`.
- `packages/core/src/artifacts/prompt-template.ts` — rewrite rule 7 with the new set + proactive language ("use proactively" / "always use for"); note Cursor's built-in Explore/Bash/Browser.
- `packages/core/src/artifacts/prompt-template.test.ts` — pin the new subagent enumeration.
- `CLAUDE.md` — add a short note about Cursor's built-in subagents (Explore, Bash, Browser) so contributors know what's "free."
- `~/.claude/skills/subagent-scaffold/templates/agents/` — sync deletes + new files (operator-side, not in Ship PR).

## Summary

Phase 03 shipped subagents based on a hypothesis: inner-loop quality checks via cursor's subagent surface reduces outer-loop bot-review thrash. Phase 05 hardened the follow-up-commit rule. Two empirical signals now tell us where the set succeeded and where it didn't:

1. **Audit data** (6 firing ship runs):
   - `code-reviewer` — **2/2 P0/P1 raised matched what bots later flagged** + 4 unique-value catches bots missed. **High signal.**
   - `validator` — 1 TS2367 pre-push catch + 4 correctly green. **Medium-high signal at low fire rate.**
   - `scope-tracker` — **0 P0/P1 raised across 6 runs**; every report was "Approve, all in-scope". **Rubber-stamp; net-zero value.**
   - `test-author` — never fired (overcautious conditional gate). **Dead surface.**
   - `ci-checker` — never in prompt template; never fires. **Dead surface.**

2. **Cursor's official guidance** (post-research, 2026-05-23):
   - Recommended specialty subagents: **Verifier, Debugger, Test Runner, Security Auditor**.
   - Built-in subagents (auto-loaded, no `.cursor/agents/` file needed): **Explore, Bash, Browser** — context-isolation for heavy ops.
   - Anti-patterns Cursor explicitly names: dozens of generic subagents, vague descriptions ("helps with coding"), 2000+ word prompts, conditional triggers cursor never judges true.
   - Best practices: write descriptions like job listings ("use proactively for X" / "always use for Y") to bias toward auto-dispatch.
   - Multi-model assignment per subagent is supported and recommended (community pattern: cheap models for mechanical checks, expensive for deep reasoning).

This phase reshapes the set to match what works: **retire dead/rubber-stamp surface, add Cursor's recommended specialty patterns, rewrite descriptions for proactive dispatch, assign cost-appropriate models per subagent.**

## Functional requirements

### F1 — Retire `scope-tracker`

Delete `.cursor/agents/scope-tracker.md`. Remove the `subagent_type \`scope-tracker\`` line from `prompt-template.ts` rule 7.

Rationale: empirical 0/6 P0/P1 rate; every report rubber-stamped. Cursor's docs warn against this anti-pattern explicitly. Operator's tight phase-doc discipline means scope drift is rare; when it happens, `code-reviewer` catches it (e.g. it caught the `cloud-fix-arc` URL sweep doc corruption in `wf_01KS6NM9`).

Acceptance: next ship run shows no `scope-tracker` task tool_call events; `make check` green; CLAUDE.md "## Agent commit trailers" / dev-workbench sections unchanged.

### F2 — Retire `ci-checker`

Delete `.cursor/agents/ci-checker.md`. (Already absent from `prompt-template.ts` rule 7 — no template change needed.)

Rationale: never invoked across all 6 audited runs; its purpose (CI repair) is better served by the deferred V2 "CI-repair phase" (separate top-level phase, not a subagent). If we want a Test Runner-style proactive runner per Cursor's recommendation, `validator` already covers that — no separate ci-checker needed.

Acceptance: file deleted; no test or prompt-template references remain.

### F3 — Add `verifier` subagent (Cursor pattern)

New `.cursor/agents/verifier.md`. Distinct from `validator`:

- **`validator`** runs the repo's check commands (typecheck/lint/test) and reports mechanical pass/fail. Cheap, deterministic.
- **`verifier`** reads the task doc's F1-Fn functional requirements + the actual diff, then asks: "does this implementation actually satisfy the contract the doc documents?" Reasoning-heavy; reads spec; cross-references with code.

Trigger: proactive, "always use for end-of-implementation verification before producing the structured summary."

Model: `opus-high` (or `inherit` if opus isn't on plan) — this subagent reads + reasons across spec + impl, not just runs commands.

Acceptance: verifier fires on a normal impl run; output references specific F-ids from the spec doc; finding format is `{F-id, satisfied: yes/no, evidence}`.

### F4 — Add `debugger` subagent (Cursor pattern)

New `.cursor/agents/debugger.md`. Root-cause analysis specialist for errors encountered during implementation.

Trigger: **manual `/debugger` invocation** (not auto-dispatched). When the parent agent hits an error it can't immediately diagnose, the operator (or the parent's own judgment) fires `/debugger` explicitly.

Model: `opus-high` — debugging benefits from deep reasoning.

Acceptance: documented in rule 7 with explicit `/debugger` invocation example. Fires correctly when invoked manually.

### F5 — Add `security-auditor` subagent (Cursor pattern)

New `.cursor/agents/security-auditor.md`. Specialty distinct from `code-reviewer`'s generalist beat: focused on auth flows, payment paths, secret handling, env-var leakage, SQL injection / XSS surfaces, deserialization, third-party API trust boundaries.

Trigger: proactive, "always use for diffs touching authentication, payments, secrets, env vars, or third-party API calls."

Model: `opus-high` — security findings are high-stakes; false negatives are expensive.

Acceptance: fires on any diff that adds/modifies files matching the trigger heuristic; output highlights vulnerability class + remediation; deliberately silent (no false-positive nits) when nothing in the diff touches the specialty.

### F6 — Multi-model assignment per subagent

Add explicit `model:` frontmatter to each subagent:

| Subagent | Model | Rationale |
|---|---|---|
| `code-reviewer` | `inherit` | High-signal generalist; quality justifies parent's model cost |
| `naming-critic` | `composer-2-fast` | Pattern-matching against 5 fixed rules; cheap model suffices |
| `validator` | `composer-2-fast` | Runs commands, reports pass/fail; mechanical |
| `test-author` | `composer-2-fast` | Drafts tests per detected convention; structured output |
| `verifier` | `opus-high` (fallback `inherit`) | Reasoning-heavy; reads spec + diff |
| `debugger` | `opus-high` (fallback `inherit`) | Root-cause analysis benefits from depth |
| `security-auditor` | `opus-high` (fallback `inherit`) | High stakes; can't miss |

Falls back to `inherit` cleanly if the configured model isn't on the operator's plan or is blocked by team admin.

Acceptance: subagent file frontmatter parsed correctly; events.ndjson `task` tool_call events show the dispatched model is the one configured.

### F7 — Rewrite `prompt-template.ts` rule 7

Replace conditional-gate language with **proactive language** per Cursor's recommendation. Drop the "only if you did X" qualifications; describe the natural dispatch trigger as a job description.

Rough shape:

```
7. As you implement, dispatch to the repo's registered subagents at the natural points. Use `task` with subagent_type:
   - `code-reviewer` — always use before producing the structured summary. Pass the diff.
   - `naming-critic` — always use when the diff adds or renames symbols. Specialist for operator naming opinions.
   - `verifier` — always use before producing the structured summary. Reads the task doc's F1-Fn against the diff.
   - `validator` — always use before producing the structured summary. Runs the repo's check commands.
   - `test-author` — use proactively when the diff adds a new exported function / method / type in any language.
   - `security-auditor` — use proactively when the diff touches auth, payments, secrets, env vars, or third-party API calls.
   - `debugger` — invoke manually via `/debugger` when you hit an error you can't immediately diagnose. Not auto-dispatched.

   Note: Cursor provides built-in subagents (`Explore`, `Bash`, `Browser`) for context-heavy operations — codebase search, shell command isolation, browser-DOM filtering. These load automatically; do not redefine them.

   [followed by the existing P0/P1 follow-up commit clause, unchanged]
```

Acceptance: prompt-template.test.ts pins each new subagent name; old `scope-tracker` reference removed; existing follow-up-commit clause unchanged.

### F8 — CLAUDE.md note on Cursor's built-in subagents

Short paragraph in the dev-workbench section under `### ship — workflow execution` (or a new sibling subsection) noting that Cursor's `Explore` / `Bash` / `Browser` are available implicitly — contributors don't need to redefine them in `.cursor/agents/`.

Acceptance: paragraph lands; renders cleanly on the diff.

### F9 — Sync to `/subagent-scaffold` templates

Operator-side:
- Delete `~/.claude/skills/subagent-scaffold/templates/agents/scope-tracker.md`
- Delete `~/.claude/skills/subagent-scaffold/templates/agents/ci-checker.md`
- Add `verifier.md`, `debugger.md`, `security-auditor.md` (copies of ship's new files)
- Update `code-reviewer.md`, `naming-critic.md`, `validator.md`, `test-author.md` with the new model frontmatter

So future re-seeds into portfolio repos carry the redesigned set by default.

Not in the Ship PR (skill files aren't in the Ship repo). Tracked here for cross-cut completion.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Subagent count after retire+add | **7** (code-reviewer, naming-critic, validator, test-author, verifier, debugger, security-auditor) | 5 (keep the existing minus retirees, don't add Cursor patterns) / 10+ (add pr-budgeter, doc-first-enforcer, samurai-sword-checker per leverage doc) | 7 matches Cursor's "specialized over many generic" principle without flirting with the "50 is too many" warning. Adding more without empirical fire-rate data is premature. |
| Verifier vs validator separation | **Two distinct subagents** | One unified "checker" subagent | Different cognitive load: validator is mechanical (run commands), verifier reasons over spec satisfaction. Combining them = a bloated prompt covering both. |
| Debugger trigger | **Manual `/debugger` only** | Auto-dispatch on first error | Auto-dispatching on every error would burn tokens on transient/network errors; the operator's judgment (or the parent's, via the SDK's manual invocation surface) is the right filter. |
| Multi-model assignment | **Per-subagent `model:` frontmatter** | All on `inherit` (current state) | Cursor's docs + community pattern: ~5× token cost difference between cheap and expensive models per subagent invocation. Routine checks should run cheap; reasoning-heavy + high-stakes should run expensive. |
| Browser-driver subagent | **NOT in this phase — Cursor's built-in `Browser` covers it** | Build our own `web-driver` subagent | Cursor explicitly ships `Browser` as a built-in for DOM-snapshot filtering. Building our own would duplicate + compete. The experiment to validate `Browser` adequacy is tracked separately (`tsk_01KS9BVAKPV59BX91KJJZQ2S10`). |
| Retiring `ci-checker` | **DELETE the file** | Keep but unwired, in case the CI-repair phase wants to wire it later | Dead files rot. The CI-repair phase will design its own subagent shape when picked up; recreating from spec is cheaper than maintaining a never-used file. |
| Conditional triggers in rule 7 | **DROP all conditionals** | Keep "only if you did X" gates | Cursor's docs explicitly call out conditional triggers as the reason subagents don't fire. Proactive language ("use proactively for X") fires more reliably. |

## Engineering decisions

### ED-1 — Cursor's built-in subagents stay implicit

`Explore`, `Bash`, `Browser` are part of Cursor's harness; loaded automatically. We don't redefine them in `.cursor/agents/`. The prompt template's rule 7 just mentions they exist so cursor agents don't think they need to build equivalents themselves.

### ED-2 — Manual `/debugger` invocation, not auto-dispatch

Cursor supports both auto-dispatch (description-driven) and manual `/name` invocation. `debugger` is the one subagent where manual is correct: auto-dispatching on every error event would amplify noise. The operator (or the parent's explicit decision) is the right filter.

### ED-3 — Model fallback to `inherit`

If a configured non-inherit model is blocked (team admin, plan limit, deprecated), the subagent falls back to `inherit`. This is Cursor's documented behavior; no special handling needed in our config. Document in CLAUDE.md so contributors don't panic when a multi-model spec degrades to inherit on a different plan.

### ED-4 — Audit framework remains the empirical truth

Phase 03 introduced the subagent set hypothetically. Phase 10 retires/adds based on the empirical audit run during this session. **Phase 11 (when warranted)** should re-run the audit framework on the next 5-10 firing ship runs after phase 10 lands and adjust the set again. The audit framework is our primary signal — opinions inform, data decides.

## Validation plan

- **Unit (`@ship/core`)** — `prompt-template.test.ts`:
  - Asserts the new subagent enumeration in rule 7 (`code-reviewer`, `naming-critic`, `verifier`, `validator`, `test-author`, `security-auditor`, `debugger`).
  - Asserts `scope-tracker` is NOT in the prompt (negative test pins the retire).
  - Asserts the "Cursor's built-in" note is present.
  - Existing rule-7-follow-up-commit assertions stay green.
- **`make check`** + `pnpm run coverage` both green.
- **Empirical follow-up (out of PR scope, into phase 11 territory):** re-run the audit framework on the next ~5 firing ship runs after this lands. Compare:
  - New subagent fire rates per dispatch trigger.
  - Signal rate of new specialty subagents (verifier, security-auditor) — do their P0/P1 findings match what bots later flag?
  - Cost delta from multi-model assignment (parent model tokens saved vs cheap-model tokens spent).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| New subagents don't fire (descriptions don't trigger cursor's heuristic) | Verifier / security-auditor become new dead surface | Proactive language ("always use for X") matches Cursor's documented trigger pattern. Re-audit after 5 runs; iterate descriptions if fire rate < 50% on triggering diffs. |
| Multi-model fallback to inherit silently | Cost optimization doesn't materialize | Document in CLAUDE.md; operators on plans without opus see the fallback in events.ndjson `task` tool_call args. No silent failure mode. |
| Deletes break re-seeds into portfolio repos | tower/dossier/huddle/roxiq chip PRs (still open) become out-of-date | The chip PRs already have the OLD set committed. If we re-run `/subagent-scaffold` against those repos post-merge, the skill's idempotent diff-prompt UX will offer to update. Operator-driven cleanup. |
| Verifier overlaps with `code-reviewer` enough to be redundant | New dead surface | Different beat: code-reviewer checks correctness/security/conventions; verifier checks spec-satisfaction. If audit shows overlap, fold or remove. |
| `/debugger` manual invocation is awkward in current Ship flow | Operators forget it exists | Document in CLAUDE.md and in rule 7's explicit example. Worth a follow-up to make ship.ship's structured summary report unmet error states that could have used `/debugger`. |

## Out of scope

- **More subagents** (pr-budgeter, doc-first-enforcer, samurai-sword-checker per [cursor-sdk-leverage.md § Tier 2 #4](../../cursor-sdk-leverage.md#4-subagent-layer-for-the-v2-review-cycle-phase)). Adding more without data on how the redesigned 7 perform = premature optimization. Phase 11 territory if signal emerges.
- **Building our own browser-driver subagent.** Cursor's built-in `Browser` is the primary path; the experiment to validate it is filed as `tsk_01KS9BVAKPV59BX91KJJZQ2S10`.
- **CI-repair as a subagent.** The deferred V2 "CI-repair phase" gets its own design when prioritized; not a subagent.
- **Subagent invocation analytics** (a queryable view of which subagents fire on which diffs). Belongs to a separate observability phase.
- **Re-seeding portfolio repos** with the new set. Operator-paced after this merges; not a Ship task.

## Implementation plan

One PR, amazing-band budget. Step list = commit boundaries.

1. **Delete dead surface.** `git rm .cursor/agents/scope-tracker.md .cursor/agents/ci-checker.md`. Update prompt-template.ts to remove `scope-tracker` enumeration. **Validation:** `pnpm --filter @ship/core test prompt-template` green.

2. **Add Verifier + Debugger + Security Auditor.** Three new `.cursor/agents/*.md` files following the same shape (frontmatter: `name`, `description`, `model`; body: instructions + structured output format). **Validation:** files lint/format clean.

3. **Multi-model frontmatter on existing.** Add `model:` line to code-reviewer.md (`inherit` — explicit), naming-critic.md (`composer-2-fast`), validator.md (`composer-2-fast`), test-author.md (`composer-2-fast`). **Validation:** no behavior change today; documents intent.

4. **Rewrite rule 7.** Update `prompt-template.ts` + `prompt-template.test.ts` per F7. **Validation:** prompt-template tests green; render the rendered prompt manually + read it through.

5. **CLAUDE.md note on built-ins.** Per F8. **Validation:** markdown renders cleanly on the PR diff.

6. **`/subagent-scaffold` template sync** (operator-side, not in Ship PR). Document at the end of the PR description so operator-side update is tracked.

## Cross-refs

- Predecessor: [phase 03](03-subagent-passthrough.md) — introduced subagents.
- Predecessor: [phase 05](05-subagent-followup-commit.md) — rule 7's follow-up commit clause.
- Sibling: PR #68 (`feat/naming-critic-subagent`) — already added `naming-critic`; phase 10 picks up its multi-model frontmatter.
- Backlog: [cursor-sdk-leverage.md § Tier 2 #4](../../cursor-sdk-leverage.md) — proposed seed set (pr-budgeter, naming-cop, samurai-sword-checker, doc-first-enforcer); phase 10 ships only the Cursor-recommended subset; the rest defer to phase 11+.
- Cursor docs: [Subagents](https://cursor.com/docs/context/subagents), [Best practices for coding with agents](https://cursor.com/blog/agent-best-practices), [Cursor 2.4 changelog](https://cursor.com/changelog/2-4).
- Community: [Artemonim's subagent list v2](https://forum.cursor.com/t/my-subagent-list-v2/151930) — multi-model pattern reference.
- Memory: `feedback_subagent_findings.md` — predicted-bot-flag pattern (validated empirically in audit; phase 10 doubles down on the specialty pattern that produces it).
- Audit data: 6 firing ship runs (`wf_01KS6NM9...`, `wf_01KS0B0J...`, `wf_01KRWW0R...`, `wf_01KRWHHY...`, `wf_01KRWFWR...`, `wf_01KRW6YHC...`) — finding counts, signal rates per subagent.

## Open questions

1. **Verifier prompt depth** — how much should it know about the spec doc's section structure (F1, F2, ED-1, etc.) vs treating the spec as opaque text? Inclined toward "knows the standard sections" since every ship phase doc uses the same shape, but worth verifying after first fire.
2. **`/debugger` workflow integration** — should `ship.ship`'s structured summary auto-suggest `/debugger` invocation when a run hits an error it didn't resolve? Possibly; out of scope for this phase.
3. **Security Auditor false-positive rate** — opus-tier reasoning on every auth-touching diff could produce a lot of "consider X" warnings on routine code. Re-audit to see if the description's "deliberately silent when nothing specialty applies" instruction holds.
