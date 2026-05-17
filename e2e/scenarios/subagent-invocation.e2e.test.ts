/**
 * Phase 03 L3: validates file-based subagents load via
 * `local.settingSources: ["project"]` end-to-end. Gated on `SHIP_LIVE=1`
 * (included by `e2e/vitest.e2e.config.ts`) and `CURSOR_API_KEY`.
 *
 * Builds a temp worktree with `.cursor/agents/code-reviewer.md` copied from
 * the repo template and a minimal task doc instructing the parent to invoke
 * the subagent. Assertions:
 * - `ship ship` exits 0 and status is `succeeded`.
 * - `events.ndjson` contains a `code-reviewer` reference in **a non-user
 *   event** (catches the regression where `settingSources` is silently
 *   broken and the subagent never registers). The check parses each
 *   ndjson line and skips `type: "user"` entries (which echo the task
 *   doc prompt and would false-positive on every run). The remaining
 *   match space — system / assistant / thinking / tool_call / status —
 *   only mentions `code-reviewer` if the subagent loaded into cursor's
 *   tool catalog. Per F4, the test stays permissive on the precise event
 *   shape; once Open Q #3 surfaces the canonical invocation-event shape,
 *   the scan can narrow further (e.g. require a `tool_call` with the
 *   `Agent` dispatch name and the subagent in args).
 */

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { startEventTailer } from "./event-tailer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "test-repo");
const REPO_ROOT = resolve(HERE, "..", "..");
const COMMITTED_REVIEWER = join(REPO_ROOT, ".cursor", "agents", "code-reviewer.md");
const CLI_PKG = resolve(HERE, "..", "..", "packages", "cli");
const BIN = join(CLI_PKG, "src", "bin.ts");

const HAS_KEY = process.env["CURSOR_API_KEY"] !== undefined && process.env["CURSOR_API_KEY"] !== "";
const LIVE = process.env["SHIP_LIVE"] === "1";

function eventsMentionCodeReviewer(eventsPath: string): boolean {
  // Substring match across all event lines EXCEPT `type: "user"` entries,
  // which echo the task doc prompt and would false-positive even when
  // `settingSources` is broken and the subagent never registers. The
  // remaining events (system init / assistant / thinking / tool_call /
  // status) only mention `code-reviewer` if the subagent loaded.
  try {
    const lines = readFileSync(eventsPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: { type?: string };
      try {
        event = JSON.parse(line) as { type?: string };
      } catch {
        continue; // Skip malformed JSON lines
      }
      if (event.type === "user") continue; // Task doc echo lives here
      if (line.includes("code-reviewer")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

describe.skipIf(!HAS_KEY || !LIVE)("Phase 03 L3 — subagent invocation (live)", () => {
  test(
    "ship loads project subagents; run succeeds; events reference code-reviewer",
    { timeout: 5 * 60_000 },
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "ship-subagent-live-"));
      const workdir = join(tmp, "wt");
      cpSync(FIXTURE, workdir, { recursive: true });

      mkdirSync(join(workdir, ".cursor", "agents"), { recursive: true });
      writeFileSync(
        join(workdir, ".cursor", "agents", "code-reviewer.md"),
        readFileSync(COMMITTED_REVIEWER, "utf-8"),
      );

      const taskRel = "docs/features/subagent-smoke.md";
      writeFileSync(
        join(workdir, taskRel),
        [
          "# Subagent invocation smoke",
          "",
          "## Goal",
          "",
          "Use the Agent tool to delegate once to the `code-reviewer` subagent (review the current workspace / scratch changes).",
          "",
          "## Acceptance",
          "",
          "- After the subagent returns, output a single-line summary. No pull request.",
          "- Do not expand scope beyond this harness check.",
          "",
        ].join("\n"),
      );

      process.stdout.write(`[e2e] tmp=${tmp}\n[e2e] workdir=${workdir}\n[e2e] spawning ship...\n`);
      const startedAt = Date.now();

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
          taskRel,
          "--workdir",
          workdir,
          "--repo",
          "ship-e2e-subagent",
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
          artifacts: { eventsPath: string; resultPath: string };
        };
        expect(parsed.status).toBe("succeeded");
        expect(statSync(parsed.artifacts.resultPath).isFile()).toBe(true);

        const found = eventsMentionCodeReviewer(parsed.artifacts.eventsPath);
        if (found) {
          process.stdout.write(
            "[e2e] events.ndjson references code-reviewer in a non-user event (subagent registration / invocation signal)\n",
          );
        } else {
          process.stdout.write(
            `[e2e] events.ndjson at ${parsed.artifacts.eventsPath} has no non-user-event reference to code-reviewer; subagent likely did not load via settingSources\n`,
          );
        }
        // Hard assertion: the scan filters `type: "user"` events (task
        // doc echo) so a substring hit here is non-trivial evidence that
        // the subagent loaded into cursor's tool catalog. Tighten further
        // once Open Q #3 surfaces the canonical invocation-event shape.
        expect(
          found,
          "events.ndjson must reference code-reviewer in a non-user event (subagent-loading regression check)",
        ).toBe(true);
      } finally {
        tailer.stop();
      }
    },
  );
});
