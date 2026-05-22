/**
 * Renders the implementation prompt template from spec.md § "Implementation
 * prompt template". Pure function — the template is a TS template literal
 * here so it versions with the code, not as a markdown asset.
 */

export interface RenderImplementationPromptInput {
  /** The task doc body, inserted verbatim. */
  readonly taskDoc: string;
  /** Free-form repo label the caller supplies (matches `WorktreeRef.repo`). */
  readonly repo: string;
  /** Absolute path of the workspace the agent runs in. */
  readonly worktreePath: string;
  /** Branch the workdir is checked out on, if known. */
  readonly branch?: string;
  /** Ref the workdir was branched from, if known. */
  readonly baseRef?: string;
}

export function renderImplementationPrompt(input: RenderImplementationPromptInput): string {
  const branch = input.branch ?? "(unknown)";
  const baseRef = input.baseRef ?? "(unknown)";
  return [
    "You are implementing a task document in a real repository.",
    "",
    "Task doc:",
    "---",
    input.taskDoc,
    "---",
    "",
    `Repo: ${input.repo}`,
    `Worktree path: ${input.worktreePath}`,
    `Branch: ${branch}`,
    `Base ref: ${baseRef}`,
    "",
    "Rules:",
    "1. Stay inside the worktree path. All file edits happen there.",
    "2. Follow the task doc closely. If the doc names tests, write or update them. If the doc lists acceptance criteria, your work is done when they pass.",
    "3. Run the required checks listed in the doc, or detected from the repo (e.g. `pnpm test`, `go test ./...`).",
    "4. Do not expand scope beyond the task doc unless needed to make tests pass.",
    "5. If you are blocked (missing context, conflicting requirements, environment failure), stop and write a short blocker note instead of guessing.",
    "6. Before your final summary, commit your work — but only if you actually changed files; skip this step entirely on a clean working tree (e.g. when you wrote only a blocker note per rule 5, or when the task was already satisfied):",
    "   - Stage only the production and test files you changed; exclude `task-doc.md` and any other ephemeral files Ship created in the workdir (anything that existed before you started, or that lives under `.ship/`).",
    "   - Commit with a Conventional Commit subject derived from the task (e.g. `feat(...)`, `fix(...)`, `test(...)`, `docs(...)`, `refactor(...)`).",
    "   - Include `Co-authored-by: Cursor <cursoragent@cursor.com>` in the commit message body.",
    "   - If you do push or open a PR, mark the PR as `--draft`. The driver promotes from draft to ready when reviewing.",
    "7. After committing (rule 6), consider invoking the repo's registered subagents via your `task` tool. Skip this rule entirely if rule 6 was skipped (no changes were committed). Natural dispatch points, only if the `task` tool lists the subagent_type as available:",
    "   - `task` with subagent_type `code-reviewer` — pass the diff for a P0/P1/P2/P3 review against the repo's conventions.",
    "   - `task` with subagent_type `scope-tracker` — verify the diff stays inside the task doc's Scope section.",
    "   - `task` with subagent_type `test-author` — only if you added new exported code without matching tests.",
    "   - `task` with subagent_type `validator` — confirm `make check` (or the repo's equivalent) is green.",
    "   Skip any that don't apply (e.g. test-author on a docs-only change). If the `task` tool's subagent_type enum only lists `generalPurpose | cursor-guide | best-of-n-runner` (no repo-registered subagents), skip this rule entirely and note the gap in the structured summary's blockers section.",
    "   If any subagent returned a P0 or P1 finding, address it in the code, then make a new second commit (not `--amend`) with an appropriate Conventional Commit prefix per rule 6 (e.g. `fix(...)`, `refactor(...)`, `test(...)`, `docs(...)`) and `Co-authored-by: Cursor <cursoragent@cursor.com>`. Multiple commits per run are expected and fine — the follow-up commit should be separately reviewable. If you previously invoked `validator` on the pre-fix diff, re-invoke it on the post-fix diff before producing the structured summary. Skip if you didn't invoke validator earlier in this run. Surface P2/P3 findings in the structured summary's risks section instead.",
    "   If `task` returns an error for an invocation you did attempt, write `task-error: <verbatim error message>` in the blockers section — do NOT fabricate subagent output.",
    "8. At the end, produce a structured summary as the last assistant message:",
    "   - Files changed (paths)",
    "   - Tests added or updated (paths)",
    "   - Tests run, with pass/fail",
    "   - Summary of changes (3-5 sentences)",
    "   - Risks and follow-ups",
    "   - Any blockers encountered",
    "",
  ].join("\n");
}
