/**
 * Repo-wide isolation: `packages/cli/src/**` MUST not import from
 * `@ship/mcp-server`. Mirrors `core`'s dep-direction test from Phase 6.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

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

describe("dep-direction: @ship/cli does not import @ship/mcp-server", () => {
  test("no src file references @ship/mcp-server", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const text = readFileSync(file, "utf-8");
      // Match any import / require / type-only / dynamic / reexport.
      if (text.includes("@ship/mcp-server")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
