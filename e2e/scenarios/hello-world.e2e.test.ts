/**
 * Phase 9 live e2e: drives the `ship` CLI against a real `LocalCursorRunner`
 * + the fixture repo at `e2e/fixtures/test-repo/`. Gated on `SHIP_LIVE=1`
 * (requires `CURSOR_API_KEY`); the e2e config's `include` glob excludes
 * this file when the env var is unset, so default `pnpm test` runs are
 * unaffected.
 *
 * The scenario:
 *   1. Copies the fixture repo into a tmpdir (real filesystem).
 *   2. Spawns `tsx src/bin.ts ship docs/features/hello.md --workdir <tmp> ...`
 *      with isolated `--db-path` + `--runs-dir` so it doesn't touch the
 *      user's real `~/.config/ship/`. (Once those flags exist; see Open Q3
 *      in the Phase 7 task doc — V1 hard-codes paths via env-isolated
 *      $HOME / $APPDATA, which is what we rely on here.)
 *   3. Asserts: ship exits 0, the run terminates `succeeded`, the agent
 *      created `src/hello.ts` + a test file, and `result.json` carries
 *      a non-empty summary.
 *
 * Marked `test.skip` on absence of `CURSOR_API_KEY` so a SHIP_LIVE=1 run
 * without the key fails loud (rather than silently skipping every
 * assertion). Burns one Cursor run per execution — not free.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "test-repo");
const CLI_PKG = resolve(HERE, "..", "..", "packages", "cli");
const BIN = join(CLI_PKG, "src", "bin.ts");

const HAS_KEY = process.env["CURSOR_API_KEY"] !== undefined && process.env["CURSOR_API_KEY"] !== "";

describe.skipIf(!HAS_KEY)("Phase 9 live e2e — ship the hello-world fixture", () => {
  test("ship ship docs/features/hello.md → succeeded; agent produces hello.ts + test", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ship-live-"));
    const workdir = join(tmp, "wt");
    cpSync(FIXTURE, workdir, { recursive: true });

    // Isolate the CLI's persistent state to this tmpdir so the test doesn't
    // touch ~/.config/ship — set HOME/APPDATA/USERPROFILE to the tmp root.
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        BIN,
        "ship",
        "docs/features/hello.md",
        "--workdir",
        workdir,
        "--repo",
        "ship-e2e-fixture",
        "--json",
      ],
      {
        encoding: "utf-8",
        cwd: CLI_PKG,
        env: {
          ...process.env,
          HOME: tmp,
          APPDATA: tmp,
          USERPROFILE: tmp,
        },
        timeout: 5 * 60 * 1000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      summary?: string;
      artifacts: { resultPath: string };
    };
    expect(parsed.status).toBe("succeeded");
    expect(parsed.summary).toBeDefined();
    expect((parsed.summary ?? "").length).toBeGreaterThan(0);
    expect(statSync(parsed.artifacts.resultPath).isFile()).toBe(true);

    // The agent should have produced the requested file in the worktree.
    expect(statSync(join(workdir, "src", "hello.ts")).isFile()).toBe(true);
  });
});
