/**
 * Subprocess-level integration test for the `ship` binary. Runs the
 * actual entrypoint (`tsx src/bin.ts ...`) as a child process, so any
 * exit-code path that bypasses the in-process Commander harness (e.g.
 * `--help` going through `bin.ts`'s top-level `.catch`) is exercised
 * end-to-end. This layer is what caught the cycle-1 bug-smash
 * `--help → exit 1` regression that the in-process tests missed.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PKG = resolve(HERE, "..", "..", "packages", "cli");
const BIN = join(CLI_PKG, "src", "bin.ts");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ship-int-"));
});

afterEach(() => {
  // Don't bother cleaning up — vitest gives each test a fresh tmpdir
  // anyway, and the OS will GC `~/AppData/Local/Temp` eventually.
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(argv: readonly string[]): RunResult {
  // Clone process.env minus the keys that resolve to the user's real
  // config dir. `XDG_CONFIG_HOME` would otherwise win on POSIX since
  // `userConfigDir()` prefers it over the `HOME`-based fallback, and
  // the subprocess would write to the operator's actual
  // `~/.config/ship/` instead of the tmpdir we set up.
  const isolatedEnv: NodeJS.ProcessEnv = { ...process.env };
  delete isolatedEnv["XDG_CONFIG_HOME"];
  isolatedEnv["HOME"] = tmp;
  isolatedEnv["APPDATA"] = tmp;
  isolatedEnv["USERPROFILE"] = tmp;

  const result = spawnSync(process.execPath, ["--import", "tsx/esm", BIN, ...argv], {
    encoding: "utf-8",
    cwd: CLI_PKG,
    env: isolatedEnv,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("ship binary — subprocess smoke", () => {
  test("--help exits 0 and prints usage", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: ship");
    expect(r.stdout).toContain("ship [options]");
    expect(r.stdout).toContain("status [options]");
    expect(r.stdout).toContain("list [options]");
    expect(r.stdout).toContain("cancel [options]");
  });

  test("unknown subcommand exits 1 (Commander user error)", () => {
    const r = run(["bogus-subcommand"]);
    expect(r.status).toBe(1);
  });

  test("list --json against a fresh config dir prints { runs: [] } and exits 0", () => {
    const r = run(["list", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { runs: unknown[] };
    expect(parsed.runs).toEqual([]);
  });

  test("list --status banana exits 1 (InvalidArgumentError → user)", () => {
    const r = run(["list", "--status", "banana"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/invalid --status: banana/);
  });

  test("list --limit 99999999 exits 1 (RangeError from store → user)", () => {
    const r = run(["list", "--limit", "99999999"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/exceeds the maximum allowed value/);
  });

  test("cancel garbage exits 1 (WorkflowRunNotFoundError → user)", () => {
    const r = run(["cancel", "garbage"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/workflow run not found: garbage/);
  });

  test("ship without --repo exits 1 (Commander missing required option)", () => {
    const r = run(["ship", "docs.md"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/required.*--repo/i);
  });
});
