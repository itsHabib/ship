/** Tests for `renderImplementationPrompt`. Pins shape, not exact bytes. */

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
    // Rule numbers #1–#8 must appear; contract covers #6/#8 (no PR), #7 (commit),
    // and structured summary.
    for (let n = 1; n <= 8; n += 1) {
      expect(out).toContain(`${String(n)}.`);
    }
    expect(out).toContain("Do NOT open a pull request");
    expect(out).toContain("Before your final summary, commit your work");
    // Rule 7 must be conditional on actual file changes — a clean
    // working tree (e.g. a blocker run per rule 5) must not trip
    // `git commit` on an empty diff. Pin the guard wording.
    expect(out).toContain("skip this step entirely on a clean working tree");
    expect(out).toContain("Co-authored-by: Cursor <cursoragent@cursor.com>");
    expect(out).toContain("structured summary");
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
