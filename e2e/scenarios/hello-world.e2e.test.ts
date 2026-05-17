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

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { startEventTailer } from "./event-tailer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "test-repo");
const CLI_PKG = resolve(HERE, "..", "..", "packages", "cli");
const BIN = join(CLI_PKG, "src", "bin.ts");

const HAS_KEY = process.env["CURSOR_API_KEY"] !== undefined && process.env["CURSOR_API_KEY"] !== "";

describe.skipIf(!HAS_KEY)("Phase 9 live e2e — ship the hello-world fixture", () => {
  test("ship ship docs/features/hello.md → succeeded; agent produces hello.ts + test", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ship-live-"));
    const workdir = join(tmp, "wt");
    cpSync(FIXTURE, workdir, { recursive: true });

    process.stdout.write(`[e2e] tmp=${tmp}\n[e2e] workdir=${workdir}\n[e2e] spawning ship...\n`);
    const startedAt = Date.now();

    // Stream child stdout/stderr to the parent in real time so the
    // operator sees progress during a live run (which can take 30-90s).
    // We still capture stdout into a buffer for the post-run JSON parse.
    // Clear `XDG_CONFIG_HOME` along with the HOME-equivalent vars so the
    // CLI's POSIX path resolution lands inside `tmp` instead of the
    // operator's real config dir.
    const isolatedEnv: NodeJS.ProcessEnv = { ...process.env };
    delete isolatedEnv["XDG_CONFIG_HOME"];
    isolatedEnv["HOME"] = tmp;
    isolatedEnv["APPDATA"] = tmp;
    isolatedEnv["USERPROFILE"] = tmp;

    const child = spawn(
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
        cwd: CLI_PKG,
        env: isolatedEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[ship-stderr] ${chunk}`);
    });

    // Walk the tmp tree on each poll for an `events.ndjson` file —
    // doesn't matter what subdirectory the CLI uses (`<tmp>/.config/ship/runs/`
    // on POSIX, `<tmp>/AppData/Roaming/ship/runs/` on Windows, etc.), the
    // walk picks it up either way. Once found, poll-read the file from the
    // last position and emit each new event's `type` to stdout. Pure
    // setInterval: no `watchFile`, so the loop doesn't keep the process
    // alive past test completion. The interval is cleared in `finally`.
    const tailer = startEventTailer(tmp, child);

    try {
      const exitCode = await new Promise<number>((resolveCode) => {
        child.on("close", (code) => {
          resolveCode(code ?? -1);
        });
      });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stdout.write(`[e2e] ship exited code=${exitCode.toString()} after ${elapsed}s\n`);

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as {
        status: string;
        summary?: string;
        artifacts: { resultPath: string };
      };
      expect(parsed.status).toBe("succeeded");
      expect(parsed.summary).toBeDefined();
      expect((parsed.summary ?? "").length).toBeGreaterThan(0);
      expect(statSync(parsed.artifacts.resultPath).isFile()).toBe(true);
      expect(statSync(join(workdir, "src", "hello.ts")).isFile()).toBe(true);
    } finally {
      tailer.stop();
    }
  });
});
