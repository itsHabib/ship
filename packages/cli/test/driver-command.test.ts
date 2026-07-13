/** Argv → DriverService plumbing for `ship driver` subcommands. */

import { createFakeGhPort } from "@ship/driver/test/fake-gh";
import { join } from "node:path";
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

  test("run auto-import prints manifest warnings", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const manifestText = readFileSync(layout.manifestPath, "utf8");
    writeFileSync(
      layout.manifestPath,
      manifestText.replace("repo: ship", "repo: ship\nbase_branch: main"),
    );
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
    ]);
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("warnings:");
    expect(out).toContain("base_branch");
  });

  test("run by driverRunId does not print import warnings", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const manifestText = readFileSync(layout.manifestPath, "utf8");
    writeFileSync(
      layout.manifestPath,
      manifestText.replace("repo: ship", "repo: ship\nbase_branch: main"),
    );
    expect(await runDriver(["driver", "import", layout.manifestPath])).toBe(0);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    stdout.length = 0;
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const code = await runDriver([
      "driver",
      "run",
      imported.driverRunId,
      "--max-wait",
      "30s",
      "--poll-interval",
      "1s",
    ]);
    expect(code).toBe(0);
    expect(stdout.join("")).not.toContain("warnings:");
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

  test("land merges and records a landed stream via prUrl resolution", async () => {
    const gh = createFakeGhPort({
      55: { mergeCommit: null, mergedAt: null, state: "OPEN" },
    });
    h.dispose();
    h = createDriverDiskHarness(gh);
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        durationMs: 0,
        branches: [
          {
            branch: "feat-a",
            prUrl: "https://github.com/org/ship/pull/55",
            repoUrl: "https://github.com/org/ship",
          },
        ],
      },
    });
    await runDriver([
      "driver",
      "run",
      layout.manifestPath,
      "--max-wait",
      "30s",
      "--poll-interval",
      "1s",
      "--json",
    ]);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    stdout.length = 0;
    expect(await runDriver(["driver", "land", imported.driverRunId, "--pr", "55"])).toBe(0);
    stdout.length = 0;
    expect(await runDriver(["driver", "status", imported.driverRunId, "--json"])).toBe(0);
    const status = JSON.parse(stdout.join("").trim()) as {
      batches: { streams: { status: string; mergeCommit?: string; prNumber?: number }[] }[];
    };
    const stream = status.batches[0]?.streams[0];
    expect(stream?.status).toBe("done");
    expect(stream?.prNumber).toBe(55);
    expect(stream?.mergeCommit).toBe("fake-merge-sha");
    expect(gh.mergeCalls).toHaveLength(1);
    expect(gh.mergeCalls[0]?.prNumber).toBe(55);
    // --admin not passed: the default land path merges without it.
    expect(gh.mergeCalls[0]?.admin).toBe(false);
  });

  test("land --admin threads the admin opt-in through to the merge", async () => {
    const gh = createFakeGhPort({
      66: { mergeCommit: null, mergedAt: null, state: "OPEN" },
    });
    h.dispose();
    h = createDriverDiskHarness(gh);
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        durationMs: 0,
        branches: [
          {
            branch: "feat-a",
            prUrl: "https://github.com/org/ship/pull/66",
            repoUrl: "https://github.com/org/ship",
          },
        ],
      },
    });
    await runDriver([
      "driver",
      "run",
      layout.manifestPath,
      "--max-wait",
      "30s",
      "--poll-interval",
      "1s",
      "--json",
    ]);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    stdout.length = 0;
    expect(await runDriver(["driver", "land", imported.driverRunId, "--pr", "66", "--admin"])).toBe(
      0,
    );
    expect(gh.mergeCalls).toHaveLength(1);
    expect(gh.mergeCalls[0]?.admin).toBe(true);
  });

  test("land records an already-MERGED PR without re-merging", async () => {
    const gh = createFakeGhPort({
      88: {
        mergeCommit: { oid: "merged88" },
        mergedAt: "2026-06-12T04:00:00.000Z",
        state: "MERGED",
      },
    });
    h.dispose();
    h = createDriverDiskHarness(gh);
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        durationMs: 0,
        branches: [
          {
            branch: "feat-a",
            prUrl: "https://github.com/org/ship/pull/88",
            repoUrl: "https://github.com/org/ship",
          },
        ],
      },
    });
    await runDriver([
      "driver",
      "run",
      layout.manifestPath,
      "--max-wait",
      "30s",
      "--poll-interval",
      "1s",
      "--json",
    ]);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    stdout.length = 0;
    expect(await runDriver(["driver", "land", imported.driverRunId, "--pr", "88"])).toBe(0);
    expect(gh.mergeCalls).toEqual([]);
  });

  test("land errors when prUrl is absent and --stream not passed", async () => {
    const gh = createFakeGhPort();
    h.dispose();
    h = createDriverDiskHarness(gh);
    const layout = writeOneStreamManifest(h.repoRoot);
    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    await runDriver([
      "driver",
      "run",
      layout.manifestPath,
      "--max-wait",
      "30s",
      "--poll-interval",
      "1s",
      "--json",
    ]);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    stdout.length = 0;
    expect(await runDriver(["driver", "land", imported.driverRunId, "--pr", "5"])).toBe(1);
    expect(stderr.join("")).toMatch(/pass --stream/);
  });

  test("unknown driver run id exits 1", async () => {
    expect(await runDriver(["driver", "status", "drv_missing"])).toBe(1);
    expect(stderr.join("")).toMatch(/not found/);
  });

  test("import of a missing manifest path exits 1", async () => {
    const code = await runDriver(["driver", "import", "does-not-exist.driver.md"]);
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/cannot read manifest/);
  });

  test("render of an unknown driver run id exits 1", async () => {
    const code = await runDriver(["driver", "render", "drv_01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/driver run not found/);
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

  test("flip-cloud re-dispatches an imported local stream with continuation ref", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    expect(await runDriver(["driver", "import", layout.manifestPath])).toBe(0);
    const imported = JSON.parse(stdout.join("").trim()) as {
      driverRunId: string;
    };
    const statusBefore = JSON.parse(
      (
        await (async () => {
          stdout.length = 0;
          await runDriver(["driver", "status", imported.driverRunId, "--json"]);
          return stdout.join("");
        })()
      ).trim(),
    ) as { batches: { streams: { id: string }[] }[] };
    const streamId = statusBefore.batches[0]?.streams[0]?.id;
    expect(streamId).toBeDefined();

    h.cursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    stdout.length = 0;
    expect(
      await runDriver(["driver", "flip-cloud", imported.driverRunId, "--stream", streamId!]),
    ).toBe(0);
    await h.drainShip();

    const startCall = h.cursor.calls.at(-1);
    expect(startCall?.input.runtime).toBe("cloud");
    expect(startCall?.input.cloud?.repos[0]?.startingRef).toBe("feat-a");
    expect(startCall?.input.cloud?.workOnCurrentBranch).toBe(true);
  });

  test("address refuses a non-landed stream with exit 1 and a structured message", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    expect(await runDriver(["driver", "import", layout.manifestPath])).toBe(0);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };

    stdout.length = 0;
    await runDriver(["driver", "status", imported.driverRunId, "--json"]);
    const status = JSON.parse(stdout.join("").trim()) as {
      batches: { streams: { id: string }[] }[];
    };
    const streamId = status.batches[0]?.streams[0]?.id;
    expect(streamId).toBeDefined();

    const { writeFileSync } = await import("node:fs");
    const findingsPath = join(h.tmp, "findings.md");
    writeFileSync(findingsPath, "- fix the null deref\n");
    stdout.length = 0;
    stderr.length = 0;
    // A freshly imported stream is local + pending — address refuses `not-landed`.
    expect(
      await runDriver([
        "driver",
        "address",
        imported.driverRunId,
        "--stream",
        streamId!,
        "--findings",
        findingsPath,
      ]),
    ).toBe(1);
    expect(stderr.join("")).toContain("not landed");
  });

  test("list on empty store prints header and exits 0", async () => {
    expect(await runDriver(["driver", "list"])).toBe(0);
    const lines = stdout.join("").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("DRIVER RUN ID");
  });

  test("list --json emits versioned envelope", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    await runDriver(["driver", "import", layout.manifestPath]);
    stdout.length = 0;
    expect(await runDriver(["driver", "list", "--json"])).toBe(0);
    const parsed = JSON.parse(stdout.join("").trim()) as {
      v: number;
      runs: { driverRunId: string; sourceHash: string; manifestRef?: string }[];
    };
    expect(parsed.v).toBe(1);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.driverRunId).toMatch(/^drv_/);
    expect(parsed.runs[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.runs[0]?.manifestRef).toBe("driver.md");
    expect(JSON.stringify(parsed)).not.toContain("sourceJson");
    expect(JSON.stringify(parsed)).not.toContain("manifestPath");
  });

  test("list --repo + repeated --status + --limit reach the service", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    await runDriver(["driver", "import", layout.manifestPath]);
    stdout.length = 0;
    expect(
      await runDriver([
        "driver",
        "list",
        "--repo",
        "ship",
        "--status",
        "pending",
        "--status",
        "running",
        "--limit",
        "10",
        "--json",
      ]),
    ).toBe(0);
    const parsed = JSON.parse(stdout.join("").trim()) as { runs: unknown[] };
    expect(parsed.runs.length).toBeGreaterThanOrEqual(1);
  });

  test("list rejects invalid --status with exit 1", async () => {
    expect(await runDriver(["driver", "list", "--status", "bogus"])).toBe(1);
    expect(stderr.join("")).toMatch(/invalid --status: bogus/);
  });

  test("list rejects invalid --limit with exit 1", async () => {
    expect(await runDriver(["driver", "list", "--limit", "nope"])).toBe(1);
    expect(stderr.join("")).toMatch(/invalid --limit: nope/);
  });

  test("list rejects zero --limit with exit 1", async () => {
    expect(await runDriver(["driver", "list", "--limit", "0"])).toBe(1);
    expect(stderr.join("")).toMatch(/invalid --limit: 0/);
  });

  test("list rejects --limit above 200 cap with exit 1", async () => {
    expect(await runDriver(["driver", "list", "--limit", "99999999"])).toBe(1);
    expect(stderr.join("")).toMatch(/exceeds the maximum allowed value 200/);
  });

  test("list --json writes only JSON to stdout", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    await runDriver(["driver", "import", layout.manifestPath]);
    stdout.length = 0;
    stderr.length = 0;
    expect(await runDriver(["driver", "list", "--json"])).toBe(0);
    expect(stderr.join("")).toBe("");
    const parsed = JSON.parse(stdout.join("").trim()) as { v: number };
    expect(parsed.v).toBe(1);
  });

  test("list does not trigger ship dispatch or orphan resume", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    await runDriver(["driver", "import", layout.manifestPath]);
    stdout.length = 0;
    const callsBefore = h.cursor.calls.length;
    expect(await runDriver(["driver", "list", "--json"])).toBe(0);
    expect(h.cursor.calls.length).toBe(callsBefore);
  });

  test("status --json remains backward compatible after list is added", async () => {
    const layout = writeOneStreamManifest(h.repoRoot);
    await runDriver(["driver", "import", layout.manifestPath]);
    const imported = JSON.parse(stdout.join("").trim()) as { driverRunId: string };
    stdout.length = 0;
    expect(await runDriver(["driver", "status", imported.driverRunId, "--json"])).toBe(0);
    const parsed = JSON.parse(stdout.join("").trim()) as {
      driverRunId: string;
      manifestPath: string;
      batches: unknown[];
    };
    expect(parsed.driverRunId).toBe(imported.driverRunId);
    expect(parsed.manifestPath).toBe(layout.manifestPath);
    expect(parsed.batches).toHaveLength(1);
  });
});
