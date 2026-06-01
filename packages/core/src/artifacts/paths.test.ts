/** Tests for the per-run artifact path resolver. */

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ArtifactPathEscapesRunDirError } from "../errors.js";
import { createNodeShipFs } from "../fs/node.js";
import {
  ARTIFACT_FILES,
  assertSafeCloudArtifactPath,
  resolveCloudArtifactDest,
  resolveContainedCloudArtifactDest,
  resolveRunArtifactPaths,
  resolveRunArtifactsDir,
} from "./paths.js";

describe("resolveRunArtifactsDir", () => {
  test("composes runsDir + workflowRunId via path.join (platform-correct separators)", () => {
    expect(resolveRunArtifactsDir("/var/lib/ship/runs", "wf_01ABC")).toBe(
      join("/var/lib/ship/runs", "wf_01ABC"),
    );
  });
});

describe("resolveRunArtifactPaths", () => {
  test("returns all five artifact paths under the run dir", () => {
    const p = resolveRunArtifactPaths("/runs", "wf_X");
    expect(p.dir.endsWith("wf_X")).toBe(true);
    expect(p.prompt.endsWith(ARTIFACT_FILES.prompt)).toBe(true);
    expect(p.taskDoc.endsWith(ARTIFACT_FILES.taskDoc)).toBe(true);
    expect(p.events.endsWith(ARTIFACT_FILES.events)).toBe(true);
    expect(p.result.endsWith(ARTIFACT_FILES.result)).toBe(true);
    expect(p.summary.endsWith(ARTIFACT_FILES.summary)).toBe(true);
  });

  test("events path resolves to a file named events.ndjson directly", () => {
    const p = resolveRunArtifactPaths("/runs", "wf_basename");
    expect(basename(p.events)).toBe("events.ndjson");
  });

  test("reject absolute and .. artifact paths", () => {
    expect(() => {
      assertSafeCloudArtifactPath("/etc/passwd");
    }).toThrow(ArtifactPathEscapesRunDirError);
    expect(() => {
      assertSafeCloudArtifactPath("../secret");
    }).toThrow(ArtifactPathEscapesRunDirError);
  });

  test("resolveCloudArtifactDest nests under artifacts/", () => {
    const dest = resolveCloudArtifactDest("/runs", "wf_1", "nested/file.txt");
    expect(dest).toContain(join("runs", "wf_1", "artifacts", "nested", "file.txt"));
  });

  test("the file constants match spec.md § ED-4", () => {
    // Locked names. If you change one, audit spec.md and the design doc.
    expect(ARTIFACT_FILES).toEqual({
      prompt: "prompt.md",
      taskDoc: "task-doc.md",
      events: "events.ndjson",
      result: "result.json",
      summary: "summary.md",
    });
  });
});

describe("resolveContainedCloudArtifactDest", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ship-paths-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  test("rejects a symlinked intermediate directory that resolves outside the artifacts root", async () => {
    const fs = createNodeShipFs();
    const runsDir = join(tmpRoot, "runs");
    const outsideDir = join(tmpRoot, "outside");
    const workflowRunId = "wf_symlink_escape";
    const artifactsRoot = join(runsDir, workflowRunId, "artifacts");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.mkdir(artifactsRoot, { recursive: true });
    // "junction" so the directory link creates without admin on Windows CI.
    symlinkSync(outsideDir, join(artifactsRoot, "link"), "junction");

    await expect(
      resolveContainedCloudArtifactDest(fs, runsDir, workflowRunId, "link/secret.txt"),
    ).rejects.toBeInstanceOf(ArtifactPathEscapesRunDirError);
  });

  test("rejects a dangling symlink in the path that stat() reports as missing", async () => {
    const fs = createNodeShipFs();
    const runsDir = join(tmpRoot, "runs");
    const workflowRunId = "wf_dangling_escape";
    const artifactsRoot = join(runsDir, workflowRunId, "artifacts");
    await fs.mkdir(artifactsRoot, { recursive: true });
    // Create the junction to a real dir, then remove the target so the link
    // dangles. NT junctions require the target to exist at creation time, so
    // create-then-remove is the portable way to get a dangling link (the
    // junction persists after the target is gone). stat() (follows) then throws
    // ENOENT, but lstat still sees the link, so the write must be rejected.
    const danglingTarget = join(tmpRoot, "outside-gone");
    await fs.mkdir(danglingTarget, { recursive: true });
    symlinkSync(danglingTarget, join(artifactsRoot, "link"), "junction");
    rmSync(danglingTarget, { force: true, recursive: true });

    await expect(
      resolveContainedCloudArtifactDest(fs, runsDir, workflowRunId, "link/secret.txt"),
    ).rejects.toBeInstanceOf(ArtifactPathEscapesRunDirError);
  });
});
