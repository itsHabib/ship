# Phase 09 — Cloud parity

Status: design draft
Owner: ship (cursor)
Date: 2026-05-22

> Predecessor: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md) + [06-cloud-fix-arc.md](06-cloud-fix-arc.md). Supersedes the original [phase 07 design](07-open-pr-cloud-aware.md) (closed; ship doesn't open PRs). Trigger: operator's "cloud should be treated as same priority as local" — Ship's MCP + skill surfaces still feel local-first; cloud is grafted on rather than co-equal.

## Scope

**Weighted LOC budget — ~520, "ideal" band across 1 PR (split to 2 if step 3+4 budget creeps).**

Files this phase touches (cumulative; per-PR file lists in § Implementation plan):

- `packages/mcp/src/mcp.ts` — `workdir` optional when `runtime === "cloud"`; cross-field refinement updated.
- `packages/core/src/service.ts` — `realpathInsideWorkdir` guard gates on runtime; cloud path skips it; `repo` auto-derived from `cloud.repos[0].url` when omitted; synthetic workdir / worktree shape for cloud rows without a real local checkout.
- `packages/cursor-runner/src/cloud-runner.ts` — `cloudAgentOptions` default flips for `autoCreatePR` (becomes `true` when omitted) and confirms `workOnCurrentBranch` default (`false`).
- `packages/workflow/src/workflow.ts` — `worktreeRefSchema` admits a `(cloud)` synthetic value (or makes `worktree` optional on cloud rows — see ED-1).
- `~/.claude/skills/work-driver/SKILL.md` — `--runtime cloud` flag; cloud branch handling; `mcp__tower__` → `/worktree-*` rename overdue.
- `~/.claude/skills/work-driver-prep/SKILL.md` — per-stream `runtime` in the manifest schema; cloud-eligibility heuristic; mixed-runtime batches.
- `CLAUDE.md` — "The loop" section gets a cloud variant called out; dev-workbench cloud parity note.
- Test churn: ~15 references across `packages/mcp/`, `packages/core/`, `packages/cursor-runner/`, plus a new L3 scenario `cloud-no-workdir.e2e.test.ts`.

## Summary

Cloud is grafted onto a local-shaped surface today. Concrete symptoms (audited 2026-05-22 while firing the roxiq smash):

1. `workdir` is required for every `ship.ship` call, including cloud — the cloud VM is the workspace, but Ship insists on a local one.
2. `docPath` must `realpath` inside `workdir`, even for cloud — the doc gets prompt-embedded and the cloud VM never reads it as a file, but Ship's local-first guard fires anyway.
3. Cloud config defaults to the un-ergonomic shape: `autoCreatePR: undefined` (effectively `false`); operators always pass `true` explicitly. `workOnCurrentBranch` is the same shape.
4. `repo` is a free-form string that *must* be supplied but for cloud rows is purely informational — could be auto-derived from `cloud.repos[0].url`.
5. `/work-driver` and `/work-driver-prep` skills assume local worktrees in every step. Cloud has nothing for the pre-flight, the worktree creation, the local format-verify, or the local PR-create to do.

Phase 04 shipped the cloud runtime; phase 06 fixed its first-real-invocation bugs; phase 09 makes it **feel co-equal to local** across the surfaces operators actually touch. No new MCP tools, no new runtimes — just removing local-first assumptions from the existing ones.

## Functional requirements

### F1 — `workdir` optional when `runtime === "cloud"`

MCP `shipInputSchema` cross-field refinement: `workdir` is required unless `runtime === "cloud"`. When omitted on a cloud call, `core` synthesizes a placeholder workdir (the artifacts dir, which exists by the time persistence runs). The `workflow_runs.worktree_json` row records `{ repo, name: "(cloud)", branch: "(cloud)", path: "(cloud)", baseRef }` — see ED-1 for the synthetic shape.

Acceptance: `mcp__ship__ship { docPath, runtime: "cloud", cloud: {...} }` (no `workdir`) succeeds. `workflow_runs` row hydrates cleanly; `list_workflow_runs` filters work unchanged.

### F2 — `docPath` realpath-inside-workdir guard gates on runtime

`core`'s docPath guard fires only when `runtime !== "cloud"`. Cloud calls accept any absolute path readable by the local Ship process — the doc gets read once, rendered into the prompt, and sent to the cloud VM. Local filesystem layout is irrelevant for cloud.

Local runs preserve current behavior verbatim (the guard catches symlink-escape and accidental cross-workdir reads).

Acceptance: cloud `ship.ship` with `docPath` at any operator-readable absolute path (including outside any workdir) succeeds. Local `ship.ship` with `docPath` outside `workdir` still errors with the current `docPath resolves outside workdir` message.

### F3 — Cloud config defaults flip

In `packages/cursor-runner/src/cloud-runner.ts` `cloudAgentOptions`:

- `autoCreatePR` defaults to `true` when omitted (cursor's own default + the common operator case).
- `workOnCurrentBranch` defaults to `false` when omitted (already the runtime default; this just makes it explicit + documented).

Operators who want `autoCreatePR: false` still pass it explicitly. The defaults flip just removes boilerplate for the common path.

Acceptance: `mcp__ship__ship { ..., runtime: "cloud", cloud: { repos: [{ url }] } }` (no `autoCreatePR`, no `workOnCurrentBranch`) runs with cursor opening the PR.

### F4 — `repo` auto-derived from `cloud.repos[0].url` when omitted

`shipInputSchema` makes `repo` optional. When omitted AND `runtime === "cloud"` AND `cloud.repos[0].url` parses, `core` derives `repo` as `<owner>/<name>` from the URL. Explicit-`repo`-wins precedence preserved.

Acceptance: cloud `ship.ship` with `cloud.repos[0].url = "https://github.com/itsHabib/roxiq"` and no `repo` arg → `workflow_runs.repo === "itsHabib/roxiq"`.

### F5 — `/work-driver` cloud-runtime support

`--runtime cloud` arg (default `local`):

- Step 1 (pre-flight worktree fast-forward) → skipped. No local worktree to fast-forward.
- Step 2 (worktree creation via `/worktree-add`) → skipped. Cloud VM is the workspace.
- Step 3 (`mcp__ship__ship` fire) → fires with `runtime: "cloud"`. Per-stream cloud config from the manifest.
- Step 3b ("verify cursor's auto-commit, manual fallback if absent") → skipped for cloud (cursor cloud's commit is in the cloud VM; we don't have a local copy to verify). Trust the terminal `succeeded` status.
- Step 3c ("format + verify locally before push") → skipped for cloud (already pushed by cursor cloud).
- Step 4 (PR open) → cursor cloud already opened it via `autoCreatePR: true`. Skill reads the PR URL from `mcp__ship__get_workflow_run` (which reads `cursor_runs.branches[0].prUrl` once we wire that up — *see § Open questions: minimal `branches_json` persistence*).
- Step 5 (review cycles) → unchanged; same `gh pr` commands work on cloud-opened PRs.
- Step 6 (merge) → unchanged.
- Step 7 (cleanup) → skip `/worktree-remove`; just `gh pr --delete-branch` on the remote (or rely on cursor cloud's archive policy).

Skill also picks up the overdue `mcp__tower__` → `/worktree-*` rename (Phase 09 closes that gap regardless of runtime).

### F6 — `/work-driver-prep` manifest carries `runtime` per stream

Manifest schema (driver.md frontmatter) gains a `runtime: local | cloud` field per stream. Default `local` for backward compat with existing manifests. Mixed-runtime batches are admitted — some streams local (need local repro, env vars, etc.), some streams cloud (parallel, long-running).

Cloud-eligibility heuristic (work-driver-prep applies as a suggestion, not a hard rule): a spec doc is "cloud-eligible" if:
- No `setup-local-db` / `docker compose` references in the doc.
- No env var deps the cloud VM wouldn't have.
- Diff is contained to a single repo cursor cloud has access to.

The heuristic outputs a `runtime: cloud` suggestion in the manifest; the operator confirms / overrides.

Acceptance: `/work-driver-prep` against a phase doc with 3 todo tasks emits a manifest where streams are marked with explicit `runtime` fields; `/work-driver` consumes the manifest and dispatches each stream correctly per its runtime.

### F7 — CLAUDE.md "The loop" cloud variant

Add an explicit cloud-variant block to CLAUDE.md's "The loop" section so future contributors see both paths side-by-side. Dev workbench `ship` section gains a "cloud first-class" callout.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Workdir for cloud | **Optional, synthesized when absent** | Require workdir always (no change) / require it but document the irrelevance | Removing the requirement matches the architectural reality (cloud VM is the workspace). Synthesized placeholder preserves `workflow_runs.worktree` shape for downstream consumers. |
| docPath guard | **Skip for cloud** | Allow it via a `skipDocPathCheck` opt-in flag | Skip-when-cloud is semantically correct (the doc isn't accessed as a file by cursor cloud). An opt-in flag would push the architectural mismatch onto every caller. |
| Cloud config defaults | **autoCreatePR: true / workOnCurrentBranch: false** | Keep current defaults; require explicit | Matches cursor's own defaults + the common operator case. Operators who want `false` still pass explicitly — no expressivity loss. |
| repo auto-derive | **Auto from `cloud.repos[0].url` when omitted** | Always require explicit | Auto-derive removes boilerplate. Explicit-wins precedence preserves operator control. |
| New MCP tools | **No new tools** | `mcp__ship__cloud_explore` / `cloud_smash` | Operator explicit: "i dont wana deal with like the smash one shot stuff." First-class cloud doesn't need new surfaces, just removing local-first friction from existing ones. |
| Work-driver runtime arg | **Explicit `--runtime cloud` flag** | Auto-detect from the manifest's runtime field | Explicit flag + manifest field both work. The flag handles the ad-hoc case (operator passes spec docs directly); the manifest field handles the prep'd case. Both routes need to exist. |
| Mixed-runtime batches | **Admit them** | Force a batch to be all-local or all-cloud | The whole point of parity is "cloud and local are equally first-class" — some streams in a batch genuinely fit one better. Admit the mix. |
| Open PR for cloud | **Cursor cloud auto-opens (autoCreatePR: true)** | Ship's own `open_pr` cloud-aware | Operator decision: ship doesn't open PRs. Phase 07 closed for this reason. |

## Engineering decisions

### ED-1 — Synthetic worktree shape for cloud-without-workdir

When `workdir` is omitted on a cloud call, `workflow_runs.worktree_json` records:

```json
{ "repo": "<derived>", "name": "(cloud)", "branch": "(cloud)", "path": "(cloud)", "baseRef": "<input baseRef or 'main'>" }
```

`worktreeRefSchema` admits the sentinel values. Hydration treats `"(cloud)"`-valued fields as "no local checkout"; consumers (`list_workflow_runs` output) render them as `(cloud)` in human-readable form.

Alternative considered: make `worktree` optional on the schema. Rejected — `worktree` is non-null in every existing row + the absence-distinguishing concern is better served by the sentinel than by a nullable column.

### ED-2 — Defaults applied at the runner boundary, not the schema

`autoCreatePR: true` / `workOnCurrentBranch: false` defaults live in `cloud-runner.ts` `cloudAgentOptions`, not in the Zod schema. Reasoning: the schema's job is shape validation; the runner's job is "what does the SDK get when this field is unset." Schemas don't carry behavior defaults this way today, and adding them would be inconsistent with the rest of `mcp.ts`.

### ED-3 — Repo auto-derive happens in `core`, not `mcp`

The Zod schema in `@ship/mcp` keeps `repo` as an optional string. `core` does the URL parse + derive. Reasoning: the schema admits the optional shape; `core` owns the side-effecting business logic.

### ED-4 — Skill changes ship in the same phase doc, separate PR

`/work-driver` and `/work-driver-prep` are operator-side skill files in `~/.claude/skills/`. They're not in the Ship repo, so they don't go in Ship's PR — they ship as a separate operator-side update. The phase doc tracks the cross-cut so the work is auditable. Validation runs end-to-end (skill + ship-side) before either lands.

### ED-5 — `cloud-eligibility` is a suggestion, not a gate

The work-driver-prep heuristic outputs `runtime: cloud` as a suggestion the operator confirms. No hard gate: the operator can override per-stream. Reasoning: heuristics are imperfect, and the cost of a wrong-runtime stream is "fire it again in the other runtime" — not catastrophic.

## Validation plan

- **Unit (`@ship/mcp`)** — `shipInputSchema.safeParse`:
  - Cloud call without `workdir` → succeeds.
  - Local call without `workdir` → fails with current error.
  - Cloud call without `repo` → succeeds (auto-derived downstream).
- **Unit (`@ship/core`)** —
  - `service.ts`: docPath outside workdir + `runtime: "cloud"` → succeeds; outside workdir + `runtime: "local"` → throws current `DocPathOutsideWorkdirError`.
  - Repo auto-derive: `cloud.repos[0].url = "https://github.com/owner/name"` + no `repo` → `workflow_runs.repo === "owner/name"`.
  - Synthetic worktree shape: cloud call without workdir → `workflow_runs.worktree.path === "(cloud)"`.
- **Unit (`@ship/cursor-runner`)** —
  - `cloudAgentOptions` with `autoCreatePR: undefined` → SDK receives `autoCreatePR: true`.
  - `cloudAgentOptions` with `autoCreatePR: false` (explicit) → SDK receives `false`.
- **L3 (gated)** — `e2e/scenarios/cloud-no-workdir.e2e.test.ts`: fires cloud `ship.ship` with no `workdir`, no `repo`, against the live sandbox. Asserts terminal succeeded + PR auto-opened.
- **Skill testing** — `/work-driver --runtime cloud spec.md` against a single-stream test spec (no manifest); assert it fires cloud, polls terminal, reads PR URL.
- **`make check`** + `pnpm run coverage` both green; coverage on `service.ts` and `cloud-runner.ts` doesn't regress.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Workdir-optional breaks existing local callers | Local `ship.ship` regresses | Cross-field refinement: `workdir` is required when `runtime !== "cloud"` (default). Existing local flows unaffected. Test pinned. |
| Auto-derive `repo` collides with operator's explicit value | Wrong `workflow_runs.repo` recorded | Explicit-wins precedence. Auto-derive only fires when `repo` is undefined. |
| `autoCreatePR: true` default surprises an operator who didn't want a PR | Unwanted PR opened on the remote | `autoCreatePR: true` is cursor's own default — this just makes it explicit. Operators with the rarer "no PR" need pass `autoCreatePR: false` (one extra field). Documented in the doc + dev-workbench. |
| Synthetic `(cloud)` worktree confuses downstream consumers | `list_workflow_runs` UI / CLI prints garbage | `(cloud)` is a sentinel string that's clearly non-path-shaped; consumers that need a real path already null-check or branch on `workflow_runs.runtime`. Render unambiguously in human output. |
| `work-driver` skill changes break local flow during transition | Operator's local work-driver fails | Default runtime stays `local`. `--runtime cloud` is opt-in. Existing manifests without the field default `local`. |
| `cloud-eligibility` heuristic gets it wrong | Operator overrides per stream; fires wrong-runtime stream | Heuristic is suggestion, not gate (ED-5). Wrong call = fire again in the other runtime; no data loss. |

## Out of scope

- **New MCP tools** (`cloud_explore`, `cloud_smash`). Operator: "i dont wana deal with like the smash one shot stuff."
- **`open_pr` cloud-aware.** Phase 07 closed — ship doesn't open PRs.
- **`branches_json` persistence on `cursor_runs`.** Was a half of phase 07; if `/work-driver` needs the cloud-pushed branch name without parsing `result.json`, it lands as a tiny standalone followup (one column + hydrate path).
- **Multi-repo cloud runs.** Still single-element `repos` tuple per phase 04.
- **`Agent.resume` cross-process.** Separate (phase 08).
- **CLAUDE.md "shipping features" cloud guidance.** "The loop" section gets the cloud variant; the longer Shipping Features section can defer until impl reveals what's actually different there.
- **Per-runtime cost reporting / observability.** Cloud runs cost differently from local; surfacing that delta is a follow-up.

## Implementation plan

Target: 1 PR if total budget < 700; split if budget creeps. Step list = commit boundaries.

1. **MCP + workflow schema.** `shipInputSchema` cross-field refinement (workdir conditional on runtime); `worktreeRefSchema` admits `(cloud)` sentinel; unit tests. **Validation:** unit suites green.

2. **Core service.** docPath guard gates on runtime; repo auto-derive from URL; synthetic workdir + worktree for cloud-no-workdir path; unit tests in `service.test.ts`. **Validation:** unit suite green; existing local tests untouched.

3. **Cursor-runner cloud-runner.ts.** Defaults flip (`autoCreatePR: true`, `workOnCurrentBranch: false`); unit tests in `cloud-runner.test.ts`. **Validation:** unit suite green.

4. **L3 scenario.** `e2e/scenarios/cloud-no-workdir.e2e.test.ts` per § Validation. **Validation:** `SHIP_LIVE=1 SHIP_CLOUD=1 pnpm -F @ship/e2e test` passes.

5. **`/work-driver` skill update.** `--runtime cloud` flag; cloud branch handling; `mcp__tower__` → `/worktree-*` rename. **Validation:** manual run against a small spec.

6. **`/work-driver-prep` skill update.** Per-stream `runtime` in manifest; cloud-eligibility heuristic; mixed-runtime batches. **Validation:** manual run; emitted manifest parses correctly back through `/work-driver`.

7. **CLAUDE.md cloud variant.** "The loop" section gains the cloud branch.

Step 1-4 + 7 are one Ship-side PR. Steps 5-6 are an operator-side commit to `~/.claude/skills/` (no Ship PR), landing alongside.

## Open questions

1. **`branches_json` persistence on cursor_runs — punt or fold in?** `/work-driver` Step 4 ("read the PR URL from `get_workflow_run`") needs the cloud-pushed branch / PR URL surfaced cleanly. Today's path: parse `result.json` from disk. Cleaner: a `cursor_runs.branches_json` column hydrated into the workflow run shape. This was half of the closed phase 07; could fold into phase 09 if it's < 100 weighted LOC. Defer if it pushes the budget.
2. **`workflow_runs.runtime` discriminant?** Today `runtime` lives on `cursor_runs`. For UI / CLI rendering ("is this row local or cloud?"), having `workflow_runs.runtime` denormalized would simplify. Costs a column + write; saves a join. Defer to a follow-up unless it's free here.
3. **Cloud-eligibility heuristic — operator approval shape.** Does `/work-driver-prep` ask the operator inline per stream, or batch-confirm at the end? Inline is more interruption; batch-confirm is more risk if the heuristic is wrong. Spike during impl; not blocking design.

## Cross-refs

- Predecessor: [phase 04](04-cursor-cloud-runner.md) — introduced `CloudCursorRunner`.
- Predecessor: [phase 06](06-cloud-fix-arc.md) — fixed cloud-runtime bugs.
- Supersedes: [phase 07](07-open-pr-cloud-aware.md) (closed, PR #63 — ship doesn't open PRs).
- Sibling: [phase 08](08-agent-resume.md) (Agent.resume; orthogonal to parity).
- Backlog source: friction log captured live 2026-05-22 while firing the roxiq smash run.
- Memory: `feedback_environment_agnostic.md` — substrate-agnostic posture; phase 09 closes the symmetry gap that's been present since phase 04.
- Memory: `feedback_design_doc_inline.md` — design doc with light review expectations.
