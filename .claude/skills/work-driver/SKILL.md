---
name: work-driver
description: Drive agent-led impl work end-to-end — pre-flight worktrees (local) or skip (cloud), fan out via `mcp__ship__ship` with `runtime: local | cloud` (single stream or N parallel; mixed-runtime batches admitted), poll terminal states, verify cursor's auto-commit (local) or trust cloud's terminal status (cloud), open PRs (local manually / cloud via autoCreatePR), coordinate review cycles, merge in dep order. Use when the user wants to drive ship-based impl work through to merge, whether one task or several in parallel, local or cloud.
argument-hint: "[stream-count] [phase-docs...] [--runtime local|cloud] — e.g. /work-driver 3 docs/features/x/phases/01-a.md docs/features/x/phases/02-b.md docs/features/x/phases/03-c.md --runtime cloud"
user_invocable: true
---

# /work-driver — work driver for agent-led impl

Drive any agent-led impl work end-to-end. Each stream is one `mcp__ship__ship` run against a task doc; the pattern coordinates **one stream OR N parallel** through fan-out → poll → land → review → merge → cleanup. Source notes at `pers/work-driver.md`; friction log at `pers/workbench-friction.md`. This skill is its codified form.

Pair with `/work-driver-prep` when you have a batch of dossier tasks and want one spec doc per task + conflict-aware grouping into parallel-safe batches before invoking this skill.

## When to use

User-facing signals (any of these — single or parallel):
- "drive this impl work" / "drive these phases"
- "run this through ship" / "ship and merge"
- "fire N parallel streams" / "parallelize this work" / "concurrent agent runs"
- Any explicit invocation: `/work-driver`

The pattern applies to **any agent-led impl work** — one task OR several in parallel. The loop (pre-flight → fan-out → poll → land → review → merge → cleanup) is the same shape regardless of N; parallel is one capability among others. For N=1, the merge-order step trivially has nothing to coordinate and the review-cycle serialization tradeoff in step 5 collapses.

Anti-signal: design-only work where Ship doesn't fire (the design doc IS the deliverable). Write the doc in chat; this skill is for the impl phase that follows.

## Arguments

`/work-driver [N] <doc1.md> [doc2.md ... docN.md] [--batch <N>] [--runtime local|cloud]`

- One or more `.md` paths. The driver **autodetects the form** by reading each file's YAML frontmatter:
  - If a single file has `driver_version:` in frontmatter → **manifest form** (structured execution plan from `/work-driver-prep`).
  - Otherwise → **ad-hoc form** (one or more spec docs, one stream each).
- `N` (optional, ad-hoc only): stream count. If omitted, infer from the number of doc paths supplied. Ignored in manifest form (stream count comes from the manifest).
- `--batch N` (manifest form only): run only that batch from the manifest. Useful for operator-paced runs or recovering from a partial failure.
- `--runtime local|cloud` (optional, default `local`): which Ship runtime to fire each stream against.
  - Ad-hoc form: applies to every stream in the invocation.
  - Manifest form: overrides the per-stream `runtime` field in the manifest when present (use sparingly; the manifest is usually authoritative). Manifest form admits **mixed-runtime batches** — some streams `runtime: local`, others `runtime: cloud` within the same batch.
  - `cloud` skips local-only steps (Step 1 pre-flight, Step 2 worktree creation, Step 4's local commit / format / push). See § "Cloud-runtime variant" below for the full delta.

### Manifest form (the common case after `/work-driver-prep`)

```
/work-driver docs/features/<phase>/driver.md
/work-driver docs/features/<phase>/driver.md --batch 2
```

- Manifest declares all batches, streams, file-touch info, and dep edges.
- Driver walks batches in dep order, fans out per batch's `streams[]`, writes progress (`pr_number`, `merge_commit`, `merged_at`) back to the manifest after each merge.
- **Resumable**: re-invoking with the same path skips streams marked `status: done`, retries `failed` (after cleaning the prior worktree), and starts `pending`.

### Ad-hoc form (one-off / non-prep'd runs)

```
/work-driver 3 spec1.md spec2.md spec3.md
/work-driver spec1.md                       # N inferred as 1
```

No state tracking, no resume. Use when you have one or two specs in hand and don't want the ceremony of generating a manifest.

### If no arguments are given

ASK via `AskUserQuestion`:
1. Path to a `driver.md` manifest, OR path(s) to one-off spec doc(s)?
2. (Ad-hoc only) How many streams?

## Steps

### 1. Pre-flight (CRITICAL — easy to miss)

Tower worktrees inherit local `main`'s HEAD, NOT `origin/main`. After any recent merge:

```bash
git fetch origin
git log -1 --oneline origin/main  # sanity check
for wt in <each worktree path>; do
  git -C "$wt" merge --ff-only origin/main
done
```

Verify each worktree has the docs you'll point Ship at. If a doc is missing, the worktree is stale; re-fetch + fast-forward, or abort.

**Local main hygiene**: if your local checkout has untracked files that collide with paths added by upstream (other agents may have committed spec docs you also have as local drafts), `git pull --ff-only` will refuse with "would be overwritten by merge". **Do NOT `git stash --include-untracked` to "fix" this** — stash silently squirrels work into a list the operator can forget exists; people lose drafts that way. Instead, handle each colliding file deliberately:

1. `cat` the local file. Decide if it's worth keeping vs the incoming canonical version.
2. If superseded by what merged: `rm <file>` — gone, visible.
3. If worth keeping for later review: `mv <file> <file>.local-<yyyy-mm-dd>.bak` — stays visible in the directory, has a clear name, the operator won't be surprised by it later.
4. Re-run `git pull --ff-only`.

Visible-and-named always beats stash-and-hope-you-remember.

### 1b. (Manifest form only) Load + resume from the driver manifest

If autodetection in Step Arguments identified the input as a manifest (single `.md` with `driver_version:` in its frontmatter):

1. Re-read the manifest's YAML frontmatter. Validate `driver_version`, `repo`, `batches[]`. Bail with a clear error if the schema doesn't parse.
2. Identify the next batch with `status != "done"`. If `--batch N` was supplied, jump there directly instead.
3. Within that batch, for each stream:
   - **Skip** if `status == "done"` (already merged in a prior run).
   - **Retry** if `status == "failed"` — clean the previous worktree first (`/worktree-remove <branch>` for local; nothing to clean for cloud), then proceed as `pending`.
   - **Run** if `status == "pending"`.
4. After each stream merges, update its frontmatter block in `driver.md`: `status: done`, `pr_number`, `merge_commit`, `merged_at`. After all streams in a batch are `done`, set the batch's `status: done` too and commit the manifest update with `docs(<phase>): driver batch <N> complete`. One commit per batch (not per stream) keeps the log clean.
5. If a stream fails (CI red after fix attempts, or operator-cancelled), mark its `status: failed` in the frontmatter, commit, and surface to the operator with the failure reason. The driver stops the batch — sibling streams that already succeeded stay `done`; the operator decides whether to retry, abandon, or fix manually.

### 2. Fan out N streams

For each stream `i` of `N`:

1. **Dossier task**: `mcp__dossier__task_create { project: "<slug>", phase: "<phase>", slug: "impl-<i>-...", title, body }`.
2. **Worktree** (local-runtime only): invoke `/worktree-add <branch-name>` (the `/worktree-*` skill family — replaces the deprecated `mcp__tower__add_worktree`). Creates `<repo>/.claude/worktrees/<branch>/` and returns path + branch. **Skip for `runtime: cloud`** — cursor cloud's VM is the workspace; there's no local worktree to create. See § "Cloud-runtime variant" for the full delta.
3. **Ship**: `mcp__ship__ship { workdir, docPath, repo, branch, runtime?, cloud? }` — V2-async, returns `{ workflowRunId, status: "running" }` immediately. For `runtime: cloud` pass `cloud: { repos: [{ url }], autoCreatePR: true, workOnCurrentBranch: false }`. As of phase 09, `workdir` becomes optional + `docPath` no longer needs to live inside `workdir` for cloud calls; pre-phase-09 you still need to satisfy those local-first guards (pass any valid local checkout path + put the doc inside it).

**Recovery**: if any `mcp__ship__ship` call times out at transport layer, the run still persisted server-side. Recover the ID via `mcp__ship__list_workflow_runs { status: ["pending", "running"], limit: N }` and match by `docPath`.

### 3. Poll until terminal

Loop: `mcp__ship__list_workflow_runs { limit: N }`. Each run terminates `succeeded` / `failed` / `cancelled`. While waiting:

- **Tail `events.ndjson`** for each run under `<XDG-config>/ship/runs/<runId>/events.ndjson`:
  - Windows: `~/AppData/Roaming/ship/runs/...`
  - POSIX: `~/.config/ship/runs/...`
- **Watch stderr lines** for chip-worthy patterns (e.g. `ship-start: background continuation rejected`, `Filename too long`, etc.). File chips via `mcp__ccd_session__spawn_task` as friction surfaces.
- Use `Bash --run_in_background` with `sleep 90 && echo "[poll] 90s"` to avoid foreground blocking. Don't burn context on foreground sleeps.

### 4. Per-stream landing

**Cursor auto-commits.** As of 2026-05-18 (verified across 8 successful runs in dossier batches 2–6), every successful ship run leaves a single commit on the worktree branch with `Co-authored-by: Cursor <cursoragent@cursor.com>` already in the trailer. The driver no longer needs to commit manually in the common case. For each stream:

1. **Inspect**: `git -C <workdir> status --short` and `git -C <workdir> log -1 --oneline`. Expected state: clean working tree, one commit on top of `origin/main`. If `status` shows uncommitted changes, cursor didn't auto-commit for this run — fall back to step 3's manual-commit branch.
2. **Read** `<XDG-config>/ship/runs/<runId>/summary.md` for the agent's self-report. For richer signal (mid-run errors, thinking, tool calls), tail `events.ndjson` from the same dir — `get_workflow_run` only exposes status (friction #7).
3. **Commit** (only if dirty — common case is no-op): if `git status` showed uncommitted changes in step 1, commit with both trailers:
   ```
   Co-authored-by: Cursor <cursoragent@cursor.com>
   Co-Authored-By: Claude <model-name> <noreply@anthropic.com>
   ```
   If cursor auto-committed, skip this and proceed to step 4. The cursor coauthor trailer is already there; don't re-commit just to add a Claude trailer (you didn't edit any files).
4. **Format + verify locally before push.** Cursor's auto-commit doesn't always match the project's exact formatter shape — drift on 3/8 batch-2-to-6 runs was caught by re-running the project formatter. Run whatever the repo uses for `format` and `check` (look for a `Makefile`, `package.json` scripts, `justfile`, `CONTRIBUTING.md`, or the repo's `CLAUDE.md` for the canonical commands), then **read the output**. Two specific traps:
   - **Background-task exit-code lies.** When you run the check command via `Bash --run_in_background`, the task-notification's `exit code 0` is not authoritative — observed on 2026-05-17 where a linter errored mid-stream but the notification reported success. Always `grep -iE "error|fail|warning"` (case-insensitive!) the output file before you push; only `0 failed` test-result lines or empty grep output count as green.
   - **Format drift is silent if you skip the check.** Builds and tests can pass while the formatter-check fails (this is a common pattern across language toolchains — formatters gate independently of compilers/test runners). CI catches it, but burns a cycle. Cheaper to format once before push.

   Re-commit any formatter changes as a follow-up commit (don't amend cursor's commit — keep the cursor work attributable as its own commit; the format fix is yours).
5. **Push**: `git push -u origin <branch>`.
6. **Open PR** (local-runtime only): `gh pr create --title "..." --body "..."` from the worktree. Ship doesn't open PRs — that's downstream of ship's job; the `open_pr` verb was removed (see [docs/features/remove-open-pr/spec.md](../../../docs/features/remove-open-pr/spec.md)). Use `gh pr create` directly until the `gh` MCP shim lands. **For `runtime: cloud`**: cursor cloud already opened the PR via `autoCreatePR: true` — skip this step entirely and read the PR URL from `mcp__ship__get_workflow_run { workflowRunId }` (the persisted `cursor_runs.branches[0].prUrl` field, once that hydration lands; today, parse `result.json` from `<runs-dir>/<wfId>/result.json`).
7. **Request reviewers** (per CLAUDE.md):
   - Copilot: `gh pr edit <n> --add-reviewer @copilot` (per [GitHub's official docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)). Note the **lowercase `@copilot` with leading `@`** — NOT `Copilot` and NOT the REST `requested_reviewers` endpoint. **Historical confusion (2026-05-22)**: the prior recipe `gh api -X POST repos/<o>/<r>/pulls/<n>/requested_reviewers -f 'reviewers[]=Copilot'` was likely written for org repos with Copilot Enterprise where Copilot is wired as a repo-level collaborator and the REST endpoint accepts the login. On personal repos (confirmed today on `itsHabib/trading-system`) that REST call returns HTTP 200 but `requested_reviewers` stays empty because Copilot isn't a collaborator — silent no-op. The `gh pr edit --add-reviewer @copilot` form talks to GitHub's Copilot code-review surface and works on personal repos. To verify the request actually registered, check `gh api repos/<o>/<r>/issues/<n>/timeline --jq '.[] | select(.event == "review_requested")'` — a `review_requested` event with `requested_reviewer.login == "Copilot"` confirms it. An empty `reviewRequests` from `gh pr view --json reviewRequests` is NOT proof of failure: Copilot often auto-submits a review within ~1 min and that clears the requested-state. Cross-check via `gh api repos/<o>/<r>/pulls/<n>/reviews` to see if a Copilot review already landed (verified empirically 2026-05-17 on PR #41).
   - Codex: `gh pr comment <n> -b "@codex review"`.
   - Claude: `gh pr comment <n> -b "@claude review"`.
8. **Dossier task_claim** + `artifact_link` the PR URL.

### 5. Review cycle coordination

Cap: **3 cycles per PR** (per `feedback_review_cycles.md` + operator clarification 2026-05-17). After cycle 3, **always ping the operator** — never auto-merge. If cycle 3 is clean, surface that and ask for merge confirmation. If cycle 3 has new findings, surface them with severity + suggested resolution; operator decides whether to address inline, merge with follow-up chips, or push past the 3-cycle cap once. Cycles are counted **per PR**, not per session — three open PRs each get their own three cycles.

**Address-inline-and-merge-without-re-ping rule** (added 2026-05-18 after dossier batches 2–6). When the next cycle's findings are *pure follow-ons to the prior cycle's reasoning* (e.g. cycle 1 fixed 3 misclassified markers and cycle 2 surfaces a 4th using the same logic), or are *strict mechanical fixes* (compile error caught by CI, format drift), you can address them inline + post a close-out comment + merge — without burning another wait-for-review cycle. Re-ping reviewers only when fixes change shape or behavior in a way that warrants fresh eyes. Empirically this collapsed batch 2 from ~3 cycles to 2 and batches 3–6 from 2 cycles to 1 each.

**Don't drive reviews on all N PRs in parallel** for N≥3. Cycle-1 fixes typically land on every open PR at once, and the driver thrashes context-switching across worktrees (friction #13). For N=2 the "batched" strategy worked fine in batches 2 and 4+5 — cycle-1 across both, then merge close-out together. Pick one strategy up front:

- **Serial**: complete cycle-3 on PR 1 before opening reviews on PR 2. Lowest context cost; longest wall-clock. Best for N≥3 unsimilar PRs.
- **Sub-agent per PR**: spawn one `Agent` task per PR with the PR number, worktree path, and the 3-cycle cap. Driver coordinates only at merge time. Highest parallelism; needs careful agent prompts.
- **Batched**: drive cycle-1 across all N PRs (small fixes are often the same shape), then serialize cycles 2-3. Middle ground. Works well for N≤2 and for batches where the work is similar in shape (e.g. all hygiene fixes).

**Codex latency is highly variable.** Observed range 3–14 min from ping. In dossier batch 2, codex on PR #28 took ~14 min while PR #29 was 3 min. Don't block cycle progression on codex past ~5 min in cycle 1 — claude usually arrives within 3 min and is sufficient signal to start fixing. Codex's cycle-N+1 review on your fix push often lands while you're already addressing claude's findings, so you get its feedback without an explicit wait.

For each cycle:

1. Wait ~2-5 min after the re-ping. Bot responses land in:
   - **Issue comments**: `gh api repos/<o>/<r>/issues/<n>/comments` — claude bot, comment-level codex.
   - **Pull reviews**: `gh api repos/<o>/<r>/pulls/<n>/reviews` — formal codex Review submissions.
   - **Pull comments**: `gh api repos/<o>/<r>/pulls/<n>/comments` — line-level codex review comments (P1/P2 badges).

   **CRITICAL**: codex line comments live in the `pulls/<n>/comments` endpoint, NOT in issue-comments. Always check both endpoints or you'll miss P1 flags.

2. Triage findings:
   - **P0/P1 line-level bugs** → fix inline + commit + push + re-ping (unless address-inline-and-merge rule above applies).
   - **P2/P3 observations** → acknowledge in a resolution comment; fix only if cheap.
   - **Doc-only nits** → bundle into the next push if you're touching that file anyway.

3. Re-ping reviewers for next cycle (same 3 commands as step 4.7). **Skip the re-ping** when the address-inline-and-merge rule applies — close-out comment + merge instead.

### 6. Merge in dep order

If multiple PRs touch the same aggregate file (`pnpm-lock.yaml`, `Cargo.lock`, generated schemas, OpenAPI specs, etc.):

1. **Merge smallest first** via `gh pr merge <n> --squash --delete-branch --admin`. `--admin` is needed in two distinct cases: (a) main is ahead and you're force-merging, (b) branch protection requires `APPROVED` reviews but the default reviewer set (Copilot / Codex / Claude) leaves `COMMENTED` reviews — solo-dev repos hit this every PR. Verify reviewer feedback is substantive first; `--admin` is the bypass for the policy-vs-process mismatch, not a license to merge unreviewed work.
2. **For each remaining PR**: `git fetch origin && git -C <worktree> rebase origin/main`. Resolve the aggregate-file conflict by regenerating (whatever the repo uses to refresh that artifact — `pnpm install` for `pnpm-lock.yaml`, the build for a Cargo/Go lockfile, the codegen script for generated schemas, etc.).
3. **`git push --force-with-lease`** to update the PR with the rebased state.
4. **Merge** the next PR.

If no aggregate-file overlap, merge order doesn't matter — squash + admin each.

**`--delete-branch` only deletes the remote branch.** The local branch + worktree are still around after `gh pr merge --admin --delete-branch`. The command also returns non-zero on Windows because the local-branch-delete attempt fails (the worktree still references it) — that's normal, not a failure. Verify with `gh pr view <n> --json state` showing `MERGED`, then proceed to Step 7's `/worktree-remove <branch>` to clean up locally (cloud runs skip this — there was no local worktree).

**Parallel-while-CI optimization.** A manifest PR's CI is short (~30–60 s docs-only); the next batch's ship run is the long pole (~2–5 min). Fire `mcp__ship__ship` for batch N+1 right after pushing batch N's manifest PR — they don't share files and don't interfere. Observed savings: ~3 min per batch boundary in dossier batches 4–6.

**Manifest-bundling optimization.** Per-batch manifest commits keep the log clean (one-line summary in `git log`), but bundling adjacent quick batches into a single manifest PR is a clean variant. In dossier 4+5 the two batches landed within 1 min of each other; combining their manifest update into one PR (`docs(<phase>): driver batches 4 + 5 complete`) saved a CI cycle and a worktree round-trip. Use when batches land close in time AND the operator isn't reading the manifest between them.

### 7. Cleanup

For each completed stream:

1. **Dossier**: `task_update { status: "in_progress", note }` then `task_complete { id, note }` (the API requires in-progress before done). `artifact_link { kind: "commit", ref: <merge-sha>, label: "PR #<n> merge commit" }`.

   **Retroactive close-out**: if the task is still in `todo` (e.g., it was created in a prior session and you're now linking a PR that shipped its fix), prepend `task_claim { id, actor }`. Full sequence: `claim → update(in_progress) → complete`. Three calls per close-out — friction worth knowing about for backlog cleanup runs.
2. **Worktree cleanup** (local-runtime only): `/worktree-remove <branch>` (replaces deprecated `mcp__tower__remove_worktree`). **Skip for `runtime: cloud`** — there was no local worktree.
   - **Cursor leaves scratch in the worktree root** — typically a `task-doc.md` (and sometimes a `pr-c-task.md` or similar). `git worktree remove` refuses with "contains modified or untracked files". `/worktree-remove` handles dirty state interactively (commit-WIP / stash / discard); for blind force-remove, `rm <worktree>/task-doc.md` first and re-run.
   - **Windows long-path gotcha**: `node_modules` can hit Windows' 260-char path limit. If removal fails with "Filename too long" or "Function not implemented", `Remove-Item -Recurse -Force -LiteralPath <worktree>/node_modules` first (PowerShell with long-path support) then retry; if even that fails, drop to `cmd /c "rmdir /s /q <worktree>"`.

## Cloud-runtime variant (`--runtime cloud`)

Concise summary of which steps differ from the local default:

| Step | Local | Cloud |
|---|---|---|
| 1. Pre-flight | fetch + fast-forward each worktree | **skipped** — no local worktree |
| 2.2 Worktree | `/worktree-add <branch>` | **skipped** — cursor cloud's VM is the workspace |
| 2.3 Ship | `mcp__ship__ship { workdir, docPath, repo, branch }` | `mcp__ship__ship { workdir, docPath, repo, branch, runtime: "cloud", cloud: { repos: [{ url }], autoCreatePR: true, workOnCurrentBranch: false } }` |
| 4.1 Inspect | `git status` + `git log` on local worktree | **skipped** — local has nothing; cursor cloud committed inside the cloud VM |
| 4.3 Commit fallback | manual commit if cursor didn't auto-commit | **skipped** — trust terminal `succeeded` status from `get_workflow_run` |
| 4.4 Format + verify | local `make check` / `pnpm run check` etc. | **skipped** — branch already pushed by cursor cloud; CI on the auto-opened PR is the verification |
| 4.5 Push | `git push -u origin <branch>` from worktree | **skipped** — cursor cloud already pushed |
| 4.6 Open PR | `gh pr create` from worktree | **skipped** — cursor cloud's `autoCreatePR: true` opened it; read the URL from `get_workflow_run` |
| 5. Review cycles | unchanged | unchanged — bot review flow is identical on a cloud-opened PR |
| 6. Merge in dep order | unchanged | unchanged |
| 7.2 Cleanup worktree | `/worktree-remove <branch>` | **skipped** — no local worktree |

**What stays the same for cloud:** Step 3 (poll until terminal — same `list_workflow_runs` / events.ndjson pattern), Step 4.7 (request reviewers — `gh pr edit --add-reviewer @copilot` + `@codex` + `@claude`), Step 4.8 (`dossier.task_claim` + `artifact_link`), Step 5 (review cycles, 3-cycle cap), Step 6 (merge with `gh pr merge --squash --admin --delete-branch`).

**Mixed-runtime batches** (manifest form): per-stream `runtime` field in the manifest is authoritative. Some streams `runtime: local` (need local repro, env-var deps the cloud VM doesn't have, shared local fixtures), others `runtime: cloud` (parallel-friendly, long-running, no local-only setup). The driver dispatches each stream per its own runtime.

**Cloud failure modes worth knowing:**
- Cloud agent expired before terminal → `get_workflow_run` shows `failed` with errorMessage. No worktree to inspect; events.ndjson is the only forensics.
- `autoCreatePR: true` succeeded but `branches[0].prUrl` is empty → the existing `result.json` warnings field will flag it (per phase 06 PR2). Treat as ship-side bug, not workflow failure.
- Cursor cloud pushed a branch that the local repo doesn't have → expected. Don't try to `git checkout <branch>` locally; use `gh` to interact with the PR remotely.

## Key reminders (read every time you start)

- **Local worktrees are stale post-merge** — always fetch + fast-forward first (local runtime only; cloud has no local worktree to stale).
- **Ship transport timeouts ≠ run failures** — recover the runId via `list_workflow_runs`.
- **Cursor auto-commits.** Verify with `git log -1` after the run; only commit manually if `git status` shows uncommitted changes.
- **Always run the project formatter + check command locally before push.** Cursor's commit can pass tests but fail the formatter check (formatters gate independently of compilers/test runners in most toolchains). Cheaper to format once locally than burn a CI cycle.
- **Background `make check` exit code lies.** Always `grep -iE "error|fail|warning"` the output before trusting success. A `task-notification` `exit code 0` doesn't mean the build was green.
- **Codex line comments live in `pulls/<n>/comments`** — check both endpoints during review triage.
- **Codex latency is highly variable (3–14 min).** Don't block cycle 1 progression on it past ~5 min; claude is usually sufficient signal to start fixing.
- **`gh pr merge --delete-branch` only deletes the remote.** Non-zero exit on Windows after a successful merge is normal — verify `MERGED` state, then `/worktree-remove <branch>` to clean up locally (cloud runs skip this step entirely).
- **Dossier task body doesn't reach the agent** — overrides must live in the spec doc, not the task body (until `compass` exists per `pers/mcp-workstation/compass.md`).
- **3-cycle review cap is strict** — `feedback_review_cycles.md`. Don't spiral into cycle 4. The address-inline-and-merge rule in Step 5 lets you collapse to fewer cycles when fixes are mechanical / follow-on.
- **MCP server iteration is gated on Claude Code restart unless the server is wired to build-from-source on launch.** Pre-built binaries in `claude_desktop_config.json` freeze tool versions at session start. If you're iterating on the MCP server itself, wire its command to a build-and-run wrapper (`cargo run --quiet` for Rust, `go run` for Go, etc.) so each new session compiles from current source. Otherwise tool fixes are stranded until the next Claude Code restart.
- **Append to the friction log** (`pers/workbench-friction.md`) after each session. Every new entry is potential material for `mcp-workstation` tool POCs.

## Anti-patterns (don't do these)

- Don't open standalone design-doc PRs (per `feedback_design_doc_inline.md`).
- Don't commit `.github/workflows/*.yml` blindly when operator said "CI deferred" — the auto-mode classifier may correctly block this.
- Don't burn context on foreground `sleep` polling. Use `Bash --run_in_background` + a `Monitor`-style wait.
- Don't expect `dossier.task_create`'s body to influence the agent's behavior. The agent only sees `docPath`.
- Don't skip the both-endpoints review check — codex P1 line comments aren't in issue-comments.
- Don't trust a background-task `exit code 0` without grepping the output. The notification can lie when the underlying command fails mid-stream.
- Don't manually re-commit cursor's work just to add a Claude trailer — if cursor auto-committed, the cursor coauthor is already there and the work isn't yours to claim. Only add a Claude coauthor on commits where Claude actually edited files (review-cycle fixes, format fixups).

## Source material

- `pers/work-driver.md` — full writeup: driver loop diagram, sample prompts, anti-patterns. Friction log moved to `pers/workbench-friction.md`.
- `pers/mcp-workstation/` — candidate MCP tools that would close specific friction-log entries (notify, sweeper, wedge, compass, etc.).
- Memory: `reference_work_driver_notes.md` (points at the writeup); `feedback_review_cycles.md`, `feedback_design_doc_inline.md`, `feedback_chip_worktrees.md`, `feedback_bug_smash_continuous.md`.

## Outcome

After the run, **append a new friction-log entry** to `pers/workbench-friction.md` for anything new you hit. The friction log IS this skill's learning corpus.
