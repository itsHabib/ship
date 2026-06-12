/** Argv → DriverService plumbing for `ship driver` subcommands. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CliExit } from "../src/errors.js";
import { createDriverDiskHarness, type DriverDiskHarness } from "./driver-disk-harness.js";
import { writeOneStreamManifest } from "./driver-fixtures.js";

let h: DriverDiskHarness;
const stdout: string[] = [];
const stderr: string[] = [];
let origStdout: typeof process.stdout.write;
let origStderr: typeof process.stderr.write;

beforeEach(() => {
  h = createDriverDiskHarness();
  stdout.length = 0;
  stderr.length = 0;
  origStdout = process.stdout.write.bind(process.stdout);
  origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
});

afterEach(() => {
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  h.dispose();
});

async function runDriver(argv: readonly string[]): Promise<number> {
  try {
    await h.program.parseAsync(["node", "ship", ...argv]);
    return 0;
  } catch (err) {
    if (err instanceof CliExit) return err.code;
    throw err;
  }
}

describe("ship driver", () => {
  test("import prints driverRunId JSON and exits 0", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    expect(await runDriver(["driver", "import", layout.manifestPath])).toBe(0);
    const parsed = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    expect(parsed.driverRunId).toMatch(/^drv_/);
  });

  test("run auto-import exits 0 blocked_on_merges for landed stream", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const code = await runDriver([
      "driver",
      "run",
      layout.manifestPath,
      "--max-wait",
      "30s",
      "--poll-interval",
      "1s",
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join("").trim()) as { status: string };
    expect(parsed.status).toBe("blocked_on_merges");
  });

  test("run awaiting_judgment exits 10", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: { status: "failed", durationMs: 0, branches: [] },
    });
    const code = await runDriver([
      "driver",
      "run",
      layout.manifestPath,
      "--max-wait",
      "5s",
      "--poll-interval",
      "1s",
      "--json",
    ]);
    expect(code).toBe(10);
    const parsed = JSON.parse(stdout.join("").trim()) as {
      status: string;
      awaiting: { kind: string }[];
    };
    expect(parsed.status).toBe("awaiting_judgment");
    expect(parsed.awaiting[0]?.kind).toBe("failure-triage");
  }, 15_000);

  test("run rejects --poll-interval 0s with exit 1", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    const code = await runDriver(["driver", "run", layout.manifestPath, "--poll-interval", "0s"]);
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/--poll-interval.*must be > 0/);
  });

  test("run rejects --batch 0 with exit 1", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    const code = await runDriver(["driver", "run", layout.manifestPath, "--batch", "0"]);
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/invalid --batch: 0/);
  });

  test("mark-merged rejects --pr with trailing junk", async () => {
    const code = await runDriver([
      "driver",
      "mark-merged",
      "drv_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--stream",
      "ds_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--pr",
      "12oops",
      "--sha",
      "abc1234",
    ]);
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/invalid --pr: 12oops/);
  });

  test("mark-merged rejects a fractional --cycles", async () => {
    const code = await runDriver([
      "driver",
      "mark-merged",
      "drv_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--stream",
      "ds_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--pr",
      "12",
      "--sha",
      "abc1234",
      "--cycles",
      "3.5",
    ]);
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/invalid --cycles: 3.5/);
  });

  test("unknown driver run id exits 1", async () => {
    expect(await runDriver(["driver", "status", "drv_missing"])).toBe(1);
    expect(stderr.join("")).toMatch(/not found/);
  });

  test("decide skip without --reason exits 1", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    await runDriver(["driver", "import", layout.manifestPath]);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    stdout.length = 0;
    const statusOut = await runDriver(["driver", "status", imported.driverRunId, "--json"]);
    expect(statusOut).toBe(0);
    const status = JSON.parse(stdout.join("").trim()) as {
      batches: { streams: { id: string }[] }[];
    };
    const streamId = status.batches[0]?.streams[0]?.id;
    stdout.length = 0;
    expect(
      await runDriver(["driver", "decide", imported.driverRunId, "skip", "--stream", streamId!]),
    ).toBe(1);
    expect(stderr.join("")).toMatch(/requires --reason/);
  });

  test("status --json omits manifestModified when byte-identical", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    await runDriver(["driver", "import", layout.manifestPath]);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    stdout.length = 0;
    expect(await runDriver(["driver", "status", imported.driverRunId, "--json"])).toBe(0);
    const parsed = JSON.parse(stdout.join("").trim()) as { manifestModified?: boolean };
    expect(parsed.manifestModified).toBeUndefined();
  });

  test("status warns when manifest frontmatter changed", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    await runDriver(["driver", "import", layout.manifestPath]);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      layout.manifestPath,
      `---
driver_version: 1
generated_at: 2026-06-12T10:00:00Z
generated_by: test-edited
source:
  project: ship
  phase: driver-cli-test
repo: ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/task.md
        branch_name: feat-a
        runtime: local
        status: pending
---
`,
    );
    stdout.length = 0;
    await runDriver(["driver", "status", imported.driverRunId]);
    expect(stdout.join("")).toContain("manifest modified since import");
  });

  test("status warns when manifest is edited into something unparseable", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    await runDriver(["driver", "import", layout.manifestPath]);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(layout.manifestPath, "---\nbatches: [unclosed\n---\n");
    stdout.length = 0;
    await runDriver(["driver", "status", imported.driverRunId]);
    expect(stdout.join("")).toContain("manifest modified since import");
  });
});
