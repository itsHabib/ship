/** Tests for the per-run artifact path resolver. */

import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";

import { ArtifactPathEscapesRunDirError } from "../errors.js";
import {
  ARTIFACT_FILES,
  assertSafeCloudArtifactPath,
  resolveCloudArtifactDest,
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
