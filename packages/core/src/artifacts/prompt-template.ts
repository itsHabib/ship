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
    "7. As you implement, dispatch to the repo's registered subagents at the natural points. Skip this rule entirely if rule 6 was skipped (no changes were committed). Use `task` with subagent_type:",
    '   - `code-reviewer` — always use before producing the structured summary. Pass the diff. Code-reviewer now also covers the 5 operator naming rules (no Impl suffix, no And/Or, no generic package names, no JSDoc, no Impl-hidden-behind-rename) per its body\'s "Naming checklist" section.',
    "   - `verifier` — always use before producing the structured summary. Reads the task doc's F1-Fn against the diff.",
    "   - `validator` — always use before producing the structured summary. Runs the repo's check commands.",
    "   - `test-author` — use proactively when the diff adds a new exported function / method / type in any language.",
    "   - `security-auditor` — use proactively when the diff touches auth, payments, secrets, env vars, or third-party API calls.",
    "   - `debugger` — invoke manually via `/debugger` when you hit an error you can't immediately diagnose. Not auto-dispatched.",
    "",
    "   Note: Cursor provides built-in subagents (`Explore`, `Bash`, `Browser`) for context-heavy operations — codebase search, shell command isolation, browser-DOM filtering. These load automatically; do not redefine them.",
    "",
    "   If the `task` tool's subagent_type enum only lists `generalPurpose | cursor-guide | best-of-n-runner` (no repo-registered subagents), skip this rule entirely and note the gap in the structured summary's blockers section.",
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
