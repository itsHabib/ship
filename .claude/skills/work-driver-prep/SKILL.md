---
name: work-driver-prep
description: Build the spec docs + work-driver invocation for a batch of dossier tasks. Resolves task IDs or a phase slug, generates one spec doc per task, detects file-overlap conflicts, groups into parallel-safe batches, and emits ready /work-driver commands. Use before /work-driver when you have N small tasks to ship in parallel and want to skip the manual "draft a spec for each, figure out which can run together" step.
argument-hint: "[task-ids... | phase:<slug> | project:<slug>:phase:<slug>]"
user_invocable: true
---

# /work-driver-prep — input preparer for /work-driver

Take a batch of dossier tasks and produce everything `/work-driver` needs to fan out: one spec doc per task, conflict-aware grouping into parallel-safe batches, and ready-to-paste invocation commands. Removes the manual gap between "I have a backlog of tasks" and "I can invoke `/work-driver N spec1.md spec2.md ...`."

## When to use

User-facing signals:
- "ship the open follow-ups" / "fan these tasks out" / "prep work-driver"
- "set up the hygiene PRs"
- After finishing a feature and noticing several small tasks that could ship in parallel
- Any explicit invocation: `/work-driver-prep`

Don't use for:
- A single one-off task — write the spec inline; you don't need batching logic.
- Tasks where the spec already exists at the canonical `docs/features/<slug>/spec.md` path — hand the existing path to `/work-driver` directly.
- Free-text feature requests with no design done — those need a design pass first; this skill assumes tasks are already scoped (dossier `task.create`'d) and just needs to translate them into agent-runnable specs.

## Arguments

Parse `<user_argument>` as one of:

- **Project + phase (preferred, unambiguous)**: `project:<slug>:phase:<slug>` — pull all `todo` tasks from that phase.
- **Phase slug only**: `phase:<slug>` — convenience form; the skill must resolve which project owns the phase (see Step 1).
- **Explicit task IDs**: `tsk_XXX tsk_YYY tsk_ZZZ` — dossier has no `task_get { id }` verb, so the skill must walk projects to resolve each ID to a `(project, task)` tuple (see Step 1).

If no argument is given, ASK via `AskUserQuestion`:
1. Project slug (or "all" to scan the whole corpus).
2. Which tasks? (paste IDs, or specify a phase, or "all todo tasks in this project / phase").

## Steps

### 1. Resolve task list

**Goal**: end up with a list of `(project_slug, task_record)` tuples where each `task_record` has at least `id`, `slug`, `title`, `body`, `phase`, `status`. Resolution depends on which argument form was used:

**Form A — `project:<slug>:phase:<slug>`** (cheapest, no ambiguity):
- `mcp__dossier__project_get { slug: <project> }` once.
- Filter `tasks` array to the matching phase and `status == "todo"`.

**Form B — `phase:<slug>` only**:
- `mcp__dossier__project_list {}` to enumerate projects.
- For each project, `mcp__dossier__project_get { slug }` and check whether any phase has the requested slug.
- If exactly one project has it → use that project; proceed as Form A.
- If multiple projects have it → ASK via `AskUserQuestion` which one (don't guess; phase slugs collide across projects routinely — e.g. `write-side` could exist in two projects).
- If zero match → error: `phase '<slug>' not found in any project`.

**Form C — explicit task IDs** (`tsk_...`):
- `mcp__dossier__project_list {}` to enumerate projects.
- For each project, `mcp__dossier__project_get { slug }` and scan `tasks` for matching IDs.
- Build the `(project, task)` map. If any ID is missing from every project, error: `task <id> not found in any project`.
- This is N+1 dossier calls for N projects — fine at solo-dev sizes (tens of projects); revisit if the corpus grows past hundreds.

Skip tasks not in `todo` — `claimed` / `in_progress` are someone else's stream; `done` / `cancelled` aren't candidates. Report skipped IDs back to the operator so they can spot mistakes.

**Post-resolution, surface the resolved list back to the operator before generating specs.** It's cheap insurance against a wrong-project resolution silently producing specs in the wrong directory.

### 2. Generate one spec doc per task

The dossier task body is typically already spec-shaped (problem + fix + source). The spec doc is a thin shell around it with the standard dossier header + scope estimate:

```markdown
**Status**: draft
**Owner**: @<dossier-default-actor>
**Date**: <today, YYYY-MM-DD>
**Related**: dossier task `<task-slug>` (id: `<task-id>`), [docs/follow-ups.md](../../follow-ups.md)

# <Task title> — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | <inferred from task body> | ~<N> | <N> |
| Tests | <inferred> | ~<M> | <M/2> |
| **Total** | | | **~<sum>** |

Band: **<amazing | ideal | stretch>** per repo's PR sizing convention.

## Goal

<one-paragraph restatement of the task body's problem-and-fix, in spec-doc voice>

## Behavior / fix

<the task body, lightly edited for spec-doc tone. Preserve specific call sites,
file paths, and rationale from the original task.>

## Acceptance

<the test or observable behavior that proves the fix landed. For a one-line bug
fix, this is often a single new test asserting the new behavior.>

## Test plan

<specific test names if obvious from the task body, e.g. `list_tasks_filter_by_phase_unknown_slug_errors`>

## Non-goals

<anything related but explicitly out of scope for this PR>
```

**For one-line task fixes** (e.g. *"add `bail!` on second match"*), the spec is correspondingly one screen — don't pad. The spec's job is to give the agent enough rails; over-spec wastes reviewer attention. A 100-line spec for a 5-line fix is a smell.

**Budget estimates routinely drift, sometimes 3–4×.** In dossier batches 2–6, the `frontmatter-field-drift-test` spec estimated ~40 weighted LOC (80 raw × 0.5×) and the agent shipped ~150 weighted (300 raw, all tests). Within the "amazing" band, so non-blocking — but worth knowing for calibration. Don't pad estimates "to be safe"; the spec's stated band is a *lower bound* on agent attention, not an upper bound on output. If you genuinely expect a task to fall outside the band, split it before specing.

**Spec doc path**: write each spec to `docs/features/<phase-slug>/<task-slug>.md` (anchor under the phase it lives in) or, for cross-cutting tasks, `docs/features/<task-slug>/spec.md`.

### 3. Detect conflicts — files + dependency signals

Two passes, both heuristic, both surfaced honestly to the operator so they can spot a wrong guess.

**3a. File overlap.** For each spec, infer the source files the work will touch:
- Read the task body for explicit file paths (`src/store.rs:1500`, `src/server.rs::handler_x`, `PROTOCOL.md`, etc.).
- If the task title / body mentions a known module (`store`, `server`, `domain`, `protocol`), include that file.
- If a task says *"helper used everywhere a slug-derived path is built"* or similar broad-touch language, flag as **wide-blast**: probably touches multiple files; conservatively assume conflict with anything in the same module.
- Ambiguous? `AskUserQuestion` — don't guess. A wrong conflict guess produces silent rebase pain at merge time.

**Sub-region heuristic — test-only vs production code on the same file.** Two tasks that both touch e.g. `src/store.rs` but where one is *test-only* (adds entries to `mod tests`) and the other is *production-only* (modifies a public fn) almost never collide at the textual level: tests sit at the bottom of the file, production code sits at the top. In dossier batches 4+5, two tasks both flagged for `src/store.rs` ran in parallel safely once recognized as test-only-plus-production-light. The default conservative behavior is still to serialize, but call out the sub-region split in `conflict_notes` so the operator can override to parallel for the obvious-safe cases. Example:

```yaml
conflict_notes:
  - kind: file_overlap
    file: src/store.rs
    tasks: [task-a (production-light, ~25 LOC), task-b (test-only, ~80 LOC)]
    note: "production fn + test module are textually disjoint; could parallel-run with low rebase risk"
```

**3b. Dependency signals.** For each task body, scan for phrases that imply another task is upstream:
- Verbs: `depends on`, `requires`, `after`, `blocks on`, `follows from`, `needs`, `must come before`, `before`.
- References: literal task slugs (e.g. `slug-validation-remaining-paths`) or task IDs (`tsk_[A-Z0-9]{26}`).
- When a verb + reference co-occur in the same sentence, record a directed edge: this task depends on the referenced one.

False positives are better than false negatives here — when in doubt, record the edge and surface it. The operator can override before commands run.

**Combined conflict graph.** Tasks A and B can't go parallel iff EITHER (a) their inferred file sets overlap, OR (b) one has a dep edge pointing to the other (or transitively). Dep edges also impose ordering — A before B if A is upstream of B — not just "can't be parallel."

**Always report what was found**, even when nothing:

```
Conflict scan:
  File overlap: 2 pairs (A↔B both touch src/server.rs; D↔E both touch PROTOCOL.md)
  Dep signals : 1 edge (C depends on A — body mentions "after slug-validation-remaining-paths lands")
  No deps found between: {B, D, E, F, G}
```

The "no deps found" line is intentional — silence on dep signals is itself information ("the skill looked, found nothing, so file-overlap-only batching is safe").

### 4. Group into parallel-safe batches

Greedy grouping respecting both conflict types from Step 3:
- Pack tasks into batches where no two tasks in a batch share a file OR a dep edge (direct or transitive).
- Batches are ordered: if task C depends on task A, the batch containing C goes after the batch containing A.
- A task with no conflicts and no upstream deps lands in **Batch 1 — ready now**.

Each batch can run as one `/work-driver N` invocation. **Batches may be mixed-runtime** — some streams `runtime: local`, others `runtime: cloud` — per phase 09. The driver dispatches each stream per its own runtime; the batch boundary still respects file + dep conflicts independent of runtime.

#### 4b. Runtime selection (default LOCAL; cloud only on positive signal)

**Default: `runtime: local`.** Local is cheaper (no Cursor VM time billed), faster per fire, lets the operator step into the run with normal tooling, and is the right choice for the L1/L2 unit-test-driven impl work that dominates most batches. Suggest `runtime: cloud` ONLY when the task body / spec gives a positive cloud signal. When the heuristic doesn't actively push cloud, stay local.

| Signal in task body / spec | Runtime decision |
|---|---|
| `docker compose` / `setup-local-db` / `localhost` API deps | **LOCAL (force)** — cloud VM doesn't have local services |
| Operator-personal env vars / tokens not in the cloud VM | **LOCAL (force)** — cloud VM lacks the secrets |
| Touches files in multiple repos (multi-repo refactor) | **LOCAL (force)** — multi-repo cloud out of scope per phase 04 |
| Spec mentions browser automation / desktop GUI testing | **CLOUD** — cursor cloud's desktop VM unlocks this |
| Long-running impl (>10 min) AND batch has ≥3 parallel streams | **CLOUD** — cloud parallelizes; local would serialize on the operator's machine |
| Operator explicitly asked for cloud (e.g. `--runtime cloud`, "fire this on cloud", dogfood request) | **CLOUD** — explicit override |
| Otherwise (the common case — single-repo, no special deps, L1/L2 impl) | **LOCAL** (default) |

Force signals are gates: if any LOCAL-force row is present, runtime is local regardless of any CLOUD signal also being present. Otherwise the explicit-override / browser / parallel-long-running rows win in that priority order. If none apply, default local.

**Why local-first.** Cloud fires cost real money (billed by Cursor VM active time). For the typical impl task — single repo, L1/L2 unit-test-driven work — local is just as fast and free. Cloud earns its slot when its specific capabilities are actually needed: browser automation, parallelization at scale across ≥3 streams, or an explicit dogfood signal from the operator. "I could use either" defaults to local. When in doubt, surface the choice in the grouping report and let the operator override before committing the manifest.

Surface the suggestion alongside the grouping report; let the operator override before committing the manifest:

```
Batch 1 — parallel-safe, 3 streams (suggested runtime):
  - tsk_AAA → docs/features/hygiene-followups/aaa.md (src/store.rs only)        [suggest: local — single-repo L1/L2 work, default]
  - tsk_BBB → docs/features/hygiene-followups/bbb.md (src/domain.rs only)       [suggest: local — default]
  - tsk_CCC → docs/features/hygiene-followups/ccc.md (browser scrape flow)      [suggest: cloud — browser-automation signal]
```

Output the grouping report (always show the operator the partition before committing):

```
Batch 1 — parallel-safe, 3 streams:
  - tsk_AAA → docs/features/hygiene-followups/aaa.md (src/store.rs only)
  - tsk_BBB → docs/features/hygiene-followups/bbb.md (src/domain.rs only)
  - tsk_CCC → docs/features/hygiene-followups/ccc.md (PROTOCOL.md only)

Batch 2 — parallel-safe, 2 streams:
  - tsk_DDD → docs/features/hygiene-followups/ddd.md (src/server.rs only)
  - tsk_EEE → docs/features/hygiene-followups/eee.md (Cargo.toml + tests/ only)

Batch 3 — serial, 2 streams (both touch src/server.rs):
  - tsk_FFF → docs/features/hygiene-followups/fff.md
  - tsk_GGG → docs/features/hygiene-followups/ggg.md
  → run one at a time; rebase the second on origin/main after the first merges.
```

### 5. Write the driver manifest + emit invocation commands

Produce a machine-readable driver manifest at `docs/features/<phase>/driver.md`. **Distinct from dossier's free-form `plan.md`** (which is a multi-PR feature checklist per CLAUDE.md) — the driver manifest is structured execution state for `/work-driver` specifically. Named after its consumer so the role is obvious.

YAML frontmatter holds the structured batches; the markdown body is the human-readable view of the same content. `/work-driver` consumes this directly — operator doesn't need to copy-paste per batch, and progress is tracked in-file so resume-after-interrupt works. The driver autodetects manifest vs ad-hoc form by reading the file's frontmatter (`driver_version:` present → manifest), so no prefix on the invocation.

**Driver manifest format** (`docs/features/<phase>/driver.md`):

```markdown
---
driver_version: 1
generated_at: <ISO-8601 timestamp>
generated_by: work-driver-prep
source:
  project: <project-slug>
  phase: <phase-slug>
repo: <repo-name>            # workflow_runs.repo label; for cloud streams also defaults the cloud.repos[0].url derivation
repo_url: https://github.com/<owner>/<name>  # required when any stream is runtime: cloud (cursor cloud needs the GitHub URL)
branch_prefix: <feature>-    # local branches; chosen by user, no forced `tower/` prefix per /worktree-* convention
default_runtime: local       # local | cloud — applies to streams that don't set their own runtime; default local for back-compat

batches:
  - id: 1
    label: ready now
    depends_on: []
    status: pending           # pending | in_progress | done | failed
    streams:
      - task_id: tsk_XXX
        task_slug: <slug>
        spec_path: docs/features/<phase>/<slug>.md
        branch_name: <feature>-<slug>     # local-runtime only; cloud branches are picked by cursor cloud
        runtime: local                    # local | cloud — overrides default_runtime when set
        touches: [src/file1.rs, src/file2.rs]
        status: pending
        # populated by /work-driver as the stream lands:
        # pr_number: 23
        # merge_commit: abc1234
        # merged_at: <ISO-8601>
      - task_id: tsk_YYY
        task_slug: <slug>
        spec_path: docs/features/<phase>/<slug>.md
        runtime: cloud                    # cloud streams don't need branch_name (cursor cloud picks it)
        # autoCreatePR + workOnCurrentBranch default per phase 09 (true / false respectively)
        touches: [docs/features/<phase>/<other-slug>.md]
        status: pending
      - ...
  - id: 2
    label: after batch 1
    depends_on: [1]
    status: pending
    streams: [...]

conflict_notes:
  - kind: file_overlap
    file: src/store.rs
    tasks: [task-slug-a, task-slug-b, ...]
  - kind: dep_signal
    from: <task-slug>
    to: <upstream-task-slug>
    reason: "<one-line why>"

skipped_during_resolution:    # optional — surfaces tasks/projects the skill couldn't fully resolve
  - reason: "..."
    workaround: "..."
---

# <Phase title> driver manifest

Generated by `/work-driver-prep <args>` on <date>.
Consumed by `/work-driver docs/features/<phase>/driver.md`.

## Batches
...(human-readable batched view, same as Step 4's grouping report)...
```

**Why both frontmatter and body**: frontmatter is what `/work-driver` parses; the body is what operators (and PR reviewers) read. Same primitive dossier uses everywhere else.

**Then in chat, emit the consumer-friendly invocation**:

```
# Single command (recommended) — driver walks every batch in dep order:
/work-driver docs/features/<phase>/driver.md

# Or batch-by-batch, operator-paced:
/work-driver docs/features/<phase>/driver.md --batch 1
/work-driver docs/features/<phase>/driver.md --batch 2
...
```

**Ad-hoc legacy form** (still supported by `/work-driver` for one-off / non-prep'd runs):

```
/work-driver 3 spec1.md spec2.md spec3.md
```

— but prefer the driver form when you've gone through prep, since you get state tracking and resume for free.

### 6. Commit + push the specs

Before `/work-driver` can use them, the specs need to exist on the branch each worktree will be created from (typically `main`):

```bash
git add docs/features/<phase>/*.md
git commit -m "docs(<phase>): spec docs for batch of <N> hygiene tasks"
git push origin main   # or open a tiny docs PR if branch protection requires
```

If branch protection on `main` is strict, opening a docs PR and merging it first is the clean path. `/work-driver` itself handles the post-spec-merge worktree fast-forward in Step 1.

## Key reminders

- **Specs must land on the branch worktrees inherit from** before `/work-driver` fans out — otherwise worktrees won't have the docs to point ship at.
- **Conflict detection is a heuristic.** File-touching analysis from task bodies is best-effort. If two specs unexpectedly touch the same file at runtime, the second to merge needs a rebase per `/work-driver` Step 6.
- **Don't over-spec one-liners.** A `bail!` one-line fix doesn't need a Behavior section with three subsections; the task body IS the spec, just dressed up.
- **Don't fabricate scope.** If the task body doesn't ground an acceptance criterion, leave it out — the spec is binding for the agent.
- **Surface ambiguity, don't guess.** If you can't tell which files a task touches from its body, ask. A wrong conflict guess wastes a parallel run.

## Anti-patterns

- Don't write a spec when one already exists at `docs/features/<slug>/spec.md` — hand the existing path to `/work-driver`.
- Don't group tasks with semantic dependencies (e.g. one defines a type, another consumes it) into the same parallel batch even if they touch different files. Step 3b does best-effort signal scanning, but if the dep isn't surfaced in the task body's prose, the skill won't catch it — eyeball the resolved task list and add an explicit `(depends on <slug>)` note in the body before re-running if you spot one.
- Don't commit specs without a quick read-through — the agent runs against exactly what you commit; typos and ambiguity become bugs.
- Don't expand `~/path` literally in the spec doc; use repo-relative paths so the agent's worktree resolves them correctly.
- Don't include "out of scope" items that the task body doesn't already exclude; spec must trace 1:1 to the task it was derived from.

## Source material

- `~/.claude/skills/work-driver/SKILL.md` — the consumer of this skill's output.
- Dossier task layout: `LAYOUT.md` + `PROTOCOL.md` in any dossier-tracked repo.
- Spec doc convention: any `docs/features/<feature>/spec.md` in the dossier repo itself; they're the canonical examples.

## Outcome

After this skill runs, the operator has:
- N spec docs on disk, ready to commit (`docs/features/<phase>/<task-slug>.md`)
- A structured driver manifest at `docs/features/<phase>/driver.md` — YAML frontmatter (machine-readable for `/work-driver`) + markdown body (human-readable for review). Named after its consumer to keep the role obvious and distinct from dossier's free-form `plan.md`.
- A single `/work-driver <path-to-driver.md>` command that drives the whole manifest in dep order, or per-batch overrides for operator-paced runs (the driver autodetects manifest vs ad-hoc by reading the file's frontmatter — no prefix needed)

`/work-driver` takes over from there, writing batch status back to the manifest as it goes so a paused-and-resumed run picks up where it left off.
