/**
 * Renders the implementation prompt template from spec.md § "Implementation
 * prompt template". Pure function — the template is a TS template literal
 * here so it versions with the code, not as a markdown asset.
 */

import { type AgentProvider, commitCoAuthoredByTrailer } from "@ship/workflow";

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
  /** Agent backend; defaults to `cursor` when omitted. */
  readonly provider?: AgentProvider;
}

function commitTrailerRuleLine(trailer: string | undefined): string[] {
  if (trailer === undefined) return [];
  return [`   - Include \`${trailer}\` in the commit message body.`];
}

function followUpCommitTrailerClause(trailer: string | undefined): string {
  if (trailer === undefined) return "";
  return ` and \`${trailer}\``;
}

function cursorSubagentDispatchRules(followUpTrailerClause: string): string[] {
  return [
    "7. As you implement, dispatch to the repo's registered subagents at the natural points. If you ultimately produce no commits in this run (rule 6 skipped per its clean-tree clause), the diff-reviewing subagents (code-reviewer / validator) have no diff to review — skip those and note the gap in the structured summary's blockers section; security-auditor still fires if its trigger fired during implementation. Use `task` with subagent_type:",
    '   - `code-reviewer` — always use before producing the structured summary. Pass the diff. Covers bugs, edge cases, and operator conventions, including the 5 naming rules (per its body\'s "Naming checklist" section) and the scope check against the task doc\'s Scope / Out-of-scope sections (per its body\'s "Scope checklist" section).',
    "   - `validator` — always use before producing the structured summary. Runs the repo's check commands.",
    "   - `security-auditor` — use proactively when the diff touches auth, payments, secrets, env vars, or third-party API calls.",
    "",
    "   Note: Cursor provides built-in subagents (`Explore`, `Bash`, `Browser`) for context-heavy operations — codebase search, shell command isolation, browser-DOM filtering. These load automatically; do not redefine them.",
    "",
    "   If the `task` tool's subagent_type enum only lists `generalPurpose | cursor-guide | best-of-n-runner` (no repo-registered subagents), skip this rule entirely and note the gap in the structured summary's blockers section.",
    `   If any subagent returned a P0 or P1 finding, address it in the code, then make a new second commit (not \`--amend\`) with an appropriate Conventional Commit prefix per rule 6 (e.g. \`fix(...)\`, \`refactor(...)\`, \`test(...)\`, \`docs(...)\`)${followUpTrailerClause}. Multiple commits per run are expected and fine — the follow-up commit should be separately reviewable. If you previously invoked \`validator\` on the pre-fix diff, re-invoke it on the post-fix diff before producing the structured summary. Skip if you didn't invoke validator earlier in this run. Surface P2/P3 findings in the structured summary's risks section instead.`,
    "   If `task` returns an error for an invocation you did attempt, write `task-error: <verbatim error message>` in the blockers section — do NOT fabricate subagent output.",
  ];
}

// Unlike `cursorSubagentDispatchRules`, this takes no `followUpTrailerClause`:
// the Claude Agent SDK auto-emits its own `Co-Authored-By: Claude` trailer on
// commit (so `commitCoAuthoredByTrailer("claude")` is undefined by design), so
// there is no prompt-instructed trailer to thread into the follow-up commit rule.
function claudeSubagentDispatchRules(): string[] {
  return [
    "7. As you implement, dispatch to the repo's registered subagents (passed via the SDK `agents` option) at the natural points. If you ultimately produce no commits in this run (rule 6 skipped per its clean-tree clause), the diff-reviewing subagents (code-reviewer / validator) have no diff to review — skip those and note the gap in the structured summary's blockers section; security-auditor still fires if its trigger fired during implementation. Invoke them by name:",
    '   - `code-reviewer` — always use before producing the structured summary. Pass the diff. Covers bugs, edge cases, and operator conventions, including the 5 naming rules (per its body\'s "Naming checklist" section) and the scope check against the task doc\'s Scope / Out-of-scope sections (per its body\'s "Scope checklist" section).',
    "   - `validator` — always use before producing the structured summary. Runs the repo's check commands.",
    "   - `security-auditor` — use proactively when the diff touches auth, payments, secrets, env vars, or third-party API calls.",
    "",
    "   If any subagent returned a P0 or P1 finding, address it in the code, then make a new second commit (not `--amend`) with an appropriate Conventional Commit prefix per rule 6 (e.g. `fix(...)`, `refactor(...)`, `test(...)`, `docs(...)`). Multiple commits per run are expected and fine — the follow-up commit should be separately reviewable. If you previously invoked `validator` on the pre-fix diff, re-invoke it on the post-fix diff before producing the structured summary. Skip if you didn't invoke validator earlier in this run. Surface P2/P3 findings in the structured summary's risks section instead.",
    "   If a subagent invocation fails, write `subagent-error: <verbatim error message>` in the blockers section — do NOT fabricate subagent output.",
  ];
}

function codexSubagentDispatchRules(): string[] {
  return [
    "7. Before producing the structured summary, self-review your work: re-read the diff for the operator's conventions and run the repo's check commands (`make check` or the equivalent detected from the repo). Codex has no inline subagent dispatch surface — do not invoke a `task` tool or fabricate subagent output.",
  ];
}

function subagentDispatchRules(provider: AgentProvider, followUpTrailerClause: string): string[] {
  if (provider === "claude") return claudeSubagentDispatchRules();
  if (provider === "codex") return codexSubagentDispatchRules();
  return cursorSubagentDispatchRules(followUpTrailerClause);
}

export function renderImplementationPrompt(input: RenderImplementationPromptInput): string {
  const branch = input.branch ?? "(unknown)";
  const baseRef = input.baseRef ?? "(unknown)";
  const provider = input.provider ?? "cursor";
  const commitTrailer = commitCoAuthoredByTrailer(provider);
  const followUpTrailerClause = followUpCommitTrailerClause(commitTrailer);
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
    ...commitTrailerRuleLine(commitTrailer),
    "   - If you do push or open a PR, mark the PR as `--draft`. The driver promotes from draft to ready when reviewing.",
    ...subagentDispatchRules(provider, followUpTrailerClause),
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
