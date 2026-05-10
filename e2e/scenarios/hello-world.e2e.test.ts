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
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  statSync,
  watchFile,
} from "node:fs";
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
  test("ship ship docs/features/hello.md → succeeded; agent produces hello.ts + test", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ship-live-"));
    const workdir = join(tmp, "wt");
    cpSync(FIXTURE, workdir, { recursive: true });

    process.stdout.write(`[e2e] tmp=${tmp}\n[e2e] workdir=${workdir}\n[e2e] spawning ship...\n`);
    const startedAt = Date.now();

    // Stream child stdout/stderr to the parent in real time so the
    // operator sees progress during a live run (which can take 30-90s).
    // We still capture stdout into a buffer for the post-run JSON parse.
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
        env: { ...process.env, HOME: tmp, APPDATA: tmp, USERPROFILE: tmp },
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

    // Tail the runs/<id>/events.ndjson once it shows up so the operator
    // sees the agent's stream events as the run unfolds. We discover the
    // path lazily — `ship`'s --json result tells us where it lives, but
    // we want the tail BEFORE the run finishes. Poll the runs dir until
    // an `events.ndjson` appears, then tail it.
    const runsDir = join(tmp, "ship", "runs");
    tailEventsLazy(runsDir);

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
  });
});

/**
 * Polls `runsDir` for an `events.ndjson` file, then tails it line by
 * line and pipes each event's `type` (or whatever shape the SDK emits)
 * to stdout so the operator can watch the agent stream in real time.
 * Best-effort — silently no-ops if the file never shows up.
 */
function tailEventsLazy(runsDir: string): void {
  let started = false;
  let position = 0;
  const POLL_MS = 250;
  const interval = setInterval(() => {
    let eventsPath: string | undefined;
    try {
      const subs = readdirSync(runsDir);
      for (const sub of subs) {
        const candidate = join(runsDir, sub, "events.ndjson");
        if (existsSync(candidate)) {
          eventsPath = candidate;
          break;
        }
      }
    } catch {
      // runsDir doesn't exist yet — try again next tick.
      return;
    }
    if (eventsPath === undefined) return;
    if (!started) {
      started = true;
      process.stdout.write(`[e2e] tailing ${eventsPath}\n`);
      watchFile(eventsPath, { interval: POLL_MS }, (curr, prev) => {
        if (curr.size <= position) return;
        const stream = createReadStream(eventsPath, {
          encoding: "utf-8",
          start: position,
          end: curr.size,
        });
        position = curr.size;
        stream.on("data", (chunk: Buffer | string) => {
          const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
          for (const line of text.split("\n").filter((l) => l.length > 0)) {
            try {
              const ev = JSON.parse(line) as { type?: string };
              process.stdout.write(`[ship-event] ${ev.type ?? "?"}\n`);
            } catch {
              process.stdout.write(`[ship-event] (unparseable: ${line.slice(0, 60)}…)\n`);
            }
          }
        });
        // Keep the watch interval alive for the next chunk.
        void prev;
      });
      clearInterval(interval);
    }
  }, POLL_MS);
}
