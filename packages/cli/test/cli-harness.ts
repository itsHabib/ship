/**
 * Test helper — builds a Commander program wired to a fake-runner-
 * backed `ShipService` over an in-memory store and FS, plus a stdout/
 * stderr capture that lets tests assert on the printed output without
 * letting it leak into vitest's terminal.
 *
 * Lives under `test/` (not `src/`) so vitest's coverage `include`
 * glob (`src/**`) doesn't count this helper as production code.
 */

import type { ShipService } from "@ship/core";
import type { Harness, ServiceBundle } from "@ship/test-harness";
import type { Command } from "commander";

import { createHarness, createServiceFromHarness } from "@ship/test-harness";
import { resolve as resolvePath } from "node:path";

import { CliExit } from "../src/errors.js";
import { buildProgram } from "../src/program.js";

// Use `path.resolve` so tests on Windows match what `ship.ts`'s
// `path.resolve(opts.workdir)` produces (drive-letter prefix).
const WORKDIR = resolvePath("/work/wt/feat");

export interface CliHarness {
  readonly program: Command;
  readonly service: ShipService;
  readonly bundle: ServiceBundle;
  readonly harness: Harness;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly close: () => void;
}

export async function createCliHarness(
  opts: { defaultThinking?: "low" | "high" } = {},
): Promise<CliHarness> {
  const harness = createHarness();
  const bundle = createServiceFromHarness(harness, opts);
  await bundle.fs.mkdir(WORKDIR, { recursive: true });
  await bundle.fs.writeFile(`${WORKDIR}/docs.md`, "# Task\n\nDo it.\n");

  const program = buildProgram(() => bundle.service);
  const stdout: string[] = [];
  const stderr: string[] = [];
  // Capture via process.stdout/process.stderr without spawning child procs.
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };

  return {
    program,
    service: bundle.service,
    bundle,
    harness,
    stdout,
    stderr,
    close: () => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
      harness.close();
    },
  };
}

/**
 * Run the program with the given argv against the captured streams.
 * Returns the `CliExit` code if any (else 0). Commander's `--help` /
 * `--version` paths throw with `exitCode: 0`; pass it through directly
 * rather than `|| 1`, which would silently flip 0 → 1 (the same
 * regression that was fixed in `bin.ts` during PR #12 cycle-1).
 */
export async function runArgv(
  program: Command,
  argv: readonly string[],
): Promise<{ code: number; thrown: unknown }> {
  try {
    await program.parseAsync(["node", "ship", ...argv]);
    return { code: 0, thrown: null };
  } catch (err) {
    if (err instanceof CliExit) return { code: err.code, thrown: null };
    if (err !== null && typeof err === "object" && "exitCode" in err) {
      const raw = err.exitCode;
      const code = typeof raw === "number" ? raw : Number(raw);
      return { code: Number.isFinite(code) ? code : 1, thrown: err };
    }
    return { code: -1, thrown: err };
  }
}

export const TEST_WORKDIR = WORKDIR;
