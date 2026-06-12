/**
 * Driver CLI/MCP tests need real `node:fs` — the engine resolves worktree
 * paths on disk while the default CLI harness wires `MemoryShipFs`.
 */

import type { Command } from "commander";

import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProgram } from "../src/program.js";
import { createCliDriverService, createCliService } from "../src/service.js";

export interface DriverDiskHarness {
  readonly program: Command;
  readonly cursor: FakeCursorRunner;
  readonly tmp: string;
  readonly repoRoot: string;
}

export function createDriverDiskHarness(): DriverDiskHarness {
  const tmp = mkdtempSync(join(tmpdir(), "driver-disk-"));
  const dbPath = join(tmp, "state.db");
  const runsDir = join(tmp, "runs");
  const repoRoot = join(tmp, "repo");
  const cursor = new FakeCursorRunner();
  const opts = { dbPath, runsDir, cursor };
  const program = buildProgram(createCliService(opts), createCliDriverService(opts));
  return { program, cursor, tmp, repoRoot };
}
