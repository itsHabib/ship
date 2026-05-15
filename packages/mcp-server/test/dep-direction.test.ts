/**
 * Repo-wide isolation: `packages/mcp-server/src/**` MUST not import
 * from `@ship/cli`. The CLI is the human-facing consumer; the
 * mcp-server is the agent-facing consumer; both sit on top of
 * `@ship/core` and never the other way around. Mirrors the CLI's
 * dep-direction test from Phase 7.
 *
 * The match-anywhere check the CLI's test uses is too broad for this
 * package (whole-prose comments could legitimately reference the
 * sibling consumer). This test scans for actual import / require /
 * dynamic-import / re-export forms only — the same regex shape as
 * the cursor-runner SDK-isolation test.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Catches every form: `from "..."`, `import "..."`, `import("...")`,
// `require("...")`, `export ... from "..."` — including subpath
// specifiers like `@ship/cli/src/foo` or `@ship/cli/test/...`. Bare
// keyword references in comments don't match (no quoted module
// specifier follows). The disjunction is intrinsic to the four import
// forms; splitting it across regexes loses the single-pass property
// the test relies on. Disabling sonar's 21-vs-20 threshold on the
// matching line below.
const CLI_IMPORT_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity
  /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']@ship\/cli(?:\/[^"']+)?["']/;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(HERE, "..", "src");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      yield* walk(p);
    } else if (p.endsWith(".ts")) {
      yield p;
    }
  }
}

describe("dep-direction: @ship/mcp-server does not import @ship/cli", () => {
  test("no src file imports / requires / re-exports @ship/cli", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const text = readFileSync(file, "utf-8");
      if (CLI_IMPORT_PATTERN.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
