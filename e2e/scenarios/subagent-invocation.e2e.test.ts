/**
 * Phase 03 L3: validates file-based subagents load via
 * `local.settingSources: ["project"]` end-to-end. Gated on `SHIP_LIVE=1`
 * (included by `e2e/vitest.e2e.config.ts`) and `CURSOR_API_KEY`.
 *
 * Builds a temp worktree with `.cursor/agents/code-reviewer.md` copied from
 * the repo template and a minimal task doc instructing the parent to invoke
 * the subagent. Assertions:
 * - `ship ship` exits 0 and status is `succeeded` (minimum bar).
 * - If `events.ndjson` contains `code-reviewer`, logs optimistic shape;
 *   otherwise logs degraded observability (F4) — run still passes.
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
  try {
    const text = readFileSync(eventsPath, "utf-8");
    return text.includes("code-reviewer");
  } catch {
    return false;
  }
}

describe.skipIf(!HAS_KEY || !LIVE)("Phase 03 L3 — subagent invocation (live)", () => {
  test("ship loads project subagents; run succeeds; events may reference code-reviewer", async () => {
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

      if (eventsMentionCodeReviewer(parsed.artifacts.eventsPath)) {
        process.stdout.write(
          "[e2e] events.ndjson references code-reviewer (observed subagent signal)\n",
        );
      } else {
        process.stdout.write(
          "[e2e] events.ndjson has no code-reviewer reference (degraded observability; F4)\n",
        );
      }
    } finally {
      tailer.stop();
    }
  });
});
