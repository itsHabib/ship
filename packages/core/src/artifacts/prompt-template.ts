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
    "6. Do NOT open a pull request. Ship will handle that as a separate phase.",
    "7. Before your final summary, commit your work — but only if you actually changed files; skip this step entirely on a clean working tree (e.g. when you wrote only a blocker note per rule 5, or when the task was already satisfied):",
    "   - Stage only the production and test files you changed; exclude `task-doc.md` and any other ephemeral files Ship created in the workdir (anything that existed before you started, or that lives under `.ship/`).",
    "   - Commit with a Conventional Commit subject derived from the task (e.g. `feat(...)`, `fix(...)`, `test(...)`, `docs(...)`, `refactor(...)`).",
    "   - Include `Co-authored-by: Cursor <cursoragent@cursor.com>` in the commit message body.",
    "   - Do NOT push and do NOT open a pull request (the driver owns those).",
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
