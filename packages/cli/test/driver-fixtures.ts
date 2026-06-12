/** Shared driver manifest fixtures for CLI / integration tests. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DriverRepoLayout {
  repoRoot: string;
  manifestPath: string;
  worktreePath: string;
  docPath: string;
}

export function writeOneStreamManifest(
  repoRoot: string,
  opts: {
    generatedAt?: string;
    phase?: string;
    branch?: string;
    specPath?: string;
    status?: string;
    batchCount?: number;
  } = {},
): DriverRepoLayout {
  const generatedAt = opts.generatedAt ?? "2026-06-12T10:00:00Z";
  const phase = opts.phase ?? "driver-cli-test";
  const branch = opts.branch ?? "feat-a";
  const specPath = opts.specPath ?? "docs/task.md";
  const status = opts.status ?? "pending";
  const batchCount = opts.batchCount ?? 1;

  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  writeFileSync(join(repoRoot, specPath), "# task\n");

  const worktreePath = join(repoRoot, ".claude", "worktrees", branch);
  mkdirSync(dirname(join(worktreePath, specPath)), { recursive: true });
  writeFileSync(join(worktreePath, specPath), "# task\n");

  const batches =
    batchCount === 1
      ? `  - id: 1
    depends_on: []
    streams:
      - spec_path: ${specPath}
        branch_name: ${branch}
        runtime: local
        status: ${status}`
      : `  - id: 1
    depends_on: []
    streams:
      - spec_path: ${specPath}
        branch_name: ${branch}
        runtime: local
        status: ${status}
  - id: 2
    depends_on: [1]
    streams:
      - spec_path: docs/task-b.md
        branch_name: feat-b
        runtime: local
        status: pending`;

  if (batchCount > 1) {
    mkdirSync(dirname(join(repoRoot, ".claude", "worktrees", "feat-b", "docs", "task-b.md")), {
      recursive: true,
    });
    writeFileSync(join(repoRoot, "docs", "task-b.md"), "# task b\n");
    writeFileSync(
      join(repoRoot, ".claude", "worktrees", "feat-b", "docs", "task-b.md"),
      "# task b\n",
    );
  }

  const manifestPath = join(repoRoot, "driver.md");
  writeFileSync(
    manifestPath,
    `---
driver_version: 1
generated_at: ${generatedAt}
generated_by: test
source:
  project: ship
  phase: ${phase}
repo: ship
batches:
${batches}
---
`,
  );

  return {
    repoRoot,
    manifestPath,
    worktreePath,
    docPath: join(worktreePath, specPath),
  };
}
