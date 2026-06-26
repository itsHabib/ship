/** Tests for `renderImplementationPrompt`. Pins shape, not exact bytes. */

import { commitCoAuthoredByTrailer } from "@ship/workflow";
import { describe, expect, test } from "vitest";

import { renderImplementationPrompt } from "./prompt-template.js";

const sampleTaskDoc = `# Hello task

Add a hello() function to lib/hello.ts that returns "hello world".`;

describe("renderImplementationPrompt", () => {
  test("renders the full template with all fields wired in", () => {
    const out = renderImplementationPrompt({
      taskDoc: sampleTaskDoc,
      repo: "ship",
      worktreePath: "/work/wt/feat-hello",
      branch: "ship/feat-hello",
      baseRef: "main",
    });

    expect(out).toContain("You are implementing a task document in a real repository.");
    expect(out).toContain("Task doc:\n---");
    expect(out).toContain(sampleTaskDoc);
    expect(out).toContain("---\n");
    expect(out).toContain("Repo: ship");
    expect(out).toContain("Worktree path: /work/wt/feat-hello");
    expect(out).toContain("Branch: ship/feat-hello");
    expect(out).toContain("Base ref: main");
    expect(out).toContain("Rules:");
    // Rule numbers #1–#8 must appear; contract covers #6 (commit + draft PR),
    // #7 (subagent dispatch via `task` tool), and #8 (structured summary).
    for (let n = 1; n <= 8; n += 1) {
      expect(out).toContain(`${String(n)}.`);
    }
    expect(out).not.toContain("Do NOT open a pull request");
    expect(out).toContain("mark the PR as `--draft`");
    expect(out).toContain("Before your final summary, commit your work");
    // Rule 6 must be conditional on actual file changes — a clean
    // working tree (e.g. a blocker run per rule 5) must not trip
    // `git commit` on an empty diff. Pin the guard wording.
    expect(out).toContain("skip this step entirely on a clean working tree");
    expect(out).toContain("Co-authored-by: Cursor <cursoragent@cursor.com>");
    expect(out).toContain(
      commitCoAuthoredByTrailer("cursor") ?? "missing cursor trailer in test fixture",
    );
    // Rule 7 dispatches to repo-registered subagents via cursor's
    // `task` tool — lowercase name matters (the SDK tool surface is
    // `task`, not `Agent`). Refusal-fallback wording prevents the
    // composer from fabricating subagent output when a call fails.
    expect(out).toContain("`task` tool");
    expect(out).toContain("Use `task` with subagent_type:");
    expect(out).toContain("- `code-reviewer`");
    // Code-reviewer's bullet must reference BOTH absorbed checklists
    // so future edits can't quietly drop the link between rule 7 and
    // code-reviewer.md's body checklists.
    expect(out).toContain('"Naming checklist" section');
    expect(out).toContain('"Scope checklist" section');
    expect(out).toContain("- `validator`");
    expect(out).toContain("- `security-auditor`");
    // Phase 10 retired scope-tracker + ci-checker; the retrench retired
    // verifier + test-author + debugger. None should appear ANYWHERE in
    // the rendered prompt — assert the backticked name broadly, not just
    // the bullet form, so a stray prose mention also fails the test.
    expect(out).not.toContain("`scope-tracker`");
    expect(out).not.toContain("`ci-checker`");
    expect(out).not.toContain("`verifier`");
    expect(out).not.toContain("`test-author`");
    expect(out).not.toContain("`debugger`");
    expect(out).toContain("built-in subagents (`Explore`, `Bash`, `Browser`)");
    // Rule 7's skip guard is scoped to the diff-reviewing pair only —
    // security-auditor (the sole remaining proactive subagent) still
    // fires during impl even if no commits were ultimately produced.
    expect(out).toContain(
      "diff-reviewing subagents (code-reviewer / validator) have no diff to review",
    );
    expect(out).toContain("security-auditor still fires");
    // Rule 7 success path: act on P0/P1 via a NEW follow-up commit
    // (explicitly not `--amend`, which differentiates the new clause from
    // rule 6's commit guidance); route P2/P3 to the structured-summary
    // risks section; re-run validator after follow-up commit when applicable.
    expect(out).toContain("P0 or P1 finding");
    expect(out).toContain("second commit (not `--amend`)");
    expect(out).toContain("appropriate Conventional Commit prefix per rule 6");
    expect(out).toContain("re-invoke it on the post-fix diff");
    expect(out).toContain("P2/P3 findings");
    expect(out).toContain("risks section");
    expect(out).toContain("task-error: <verbatim error message>");
    expect(out).toContain("structured summary");
  });

  test("cursor provider includes co-author trailer in rule 6 and rule 7 follow-up path", () => {
    const trailer = commitCoAuthoredByTrailer("cursor");
    if (trailer === undefined) {
      throw new Error("expected cursor co-author trailer");
    }
    const out = renderImplementationPrompt({
      taskDoc: "minimal",
      repo: "x",
      worktreePath: "/w",
      provider: "cursor",
    });
    expect(out).toContain(`Include \`${trailer}\` in the commit message body.`);
    expect(out).toContain(`\`${trailer}\`. Multiple commits per run`);
  });

  test("non-cursor provider omits co-author trailer from rule 6 and rule 7", () => {
    const out = renderImplementationPrompt({
      taskDoc: "minimal",
      repo: "x",
      worktreePath: "/w",
      provider: "claude",
    });
    expect(out).not.toContain("Co-authored-by: Cursor <cursoragent@cursor.com>");
    expect(out).not.toContain("Include `Co-authored-by:");
    expect(out).not.toMatch(/`Co-authored-by:.*`\. Multiple commits per run/);
  });

  test("missing branch + baseRef render as (unknown)", () => {
    const out = renderImplementationPrompt({
      taskDoc: "minimal",
      repo: "x",
      worktreePath: "/w",
    });
    expect(out).toContain("Branch: (unknown)");
    expect(out).toContain("Base ref: (unknown)");
  });

  test("inserts the task doc verbatim (no normalization, no escaping)", () => {
    const doc = "Line 1\r\nLine 2\nLine 3\n";
    const out = renderImplementationPrompt({
      taskDoc: doc,
      repo: "x",
      worktreePath: "/w",
    });
    expect(out).toContain(doc);
  });
});
