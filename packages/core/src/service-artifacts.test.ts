/**
 * ShipService cloud artifact list/download — manifest persistence and guards.
 */

import type { ShipInput } from "@ship/mcp";

import { CursorAgentNotFoundError } from "@ship/cursor-runner";
import { FakeCursorRunner } from "@ship/cursor-runner/test/fake";
import { createStore } from "@ship/store";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveCloudArtifactDest } from "./artifacts/paths.js";
import {
  ArtifactGoneError,
  ArtifactNotInManifestError,
  ArtifactPathEscapesRunDirError,
  ArtifactsUnavailableLocalError,
  ArtifactTooLargeError,
} from "./errors.js";
import { createMemoryShipFs } from "./fs/memory.js";
import { createShipService, type ShipService } from "./service.js";

const RUNS_DIR = "/state/runs";
const WORKDIR = "/work/wt/feat";

function deterministicClock(start: string, stepMs = 1000): () => string {
  let t = new Date(start).getTime();
  return () => {
    const out = new Date(t).toISOString();
    t += stepMs;
    return out;
  };
}

function deterministicIds(): {
  workflowRun: () => string;
  phase: () => string;
  cursorRun: () => string;
} {
  let wf = 0;
  let ph = 0;
  let cr = 0;
  const pad = (n: number): string => n.toString().padStart(26, "0");
  return {
    workflowRun: () => `wf_${pad(++wf)}`,
    phase: () => `ph_${pad(++ph)}`,
    cursorRun: () => `cr_${pad(++cr)}`,
  };
}

interface Harness {
  service: ShipService;
  cloudCursor: FakeCursorRunner;
  fs: ReturnType<typeof createMemoryShipFs>;
}

async function createHarness(): Promise<Harness> {
  const fs = createMemoryShipFs();
  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.mkdir(WORKDIR, { recursive: true });
  await fs.writeFile(`${WORKDIR}/docs.md`, "# Task\n");

  const store = createStore({
    dbPath: ":memory:",
    clock: deterministicClock("2026-05-09T00:00:00.000Z"),
  });
  const cloudCursor = new FakeCursorRunner();
  const service = createShipService({
    store,
    fs,
    clock: deterministicClock("2026-05-09T00:00:00.000Z"),
    config: {
      runsDir: RUNS_DIR,
      defaultModel: { id: "composer-2.5" },
      cursor: new FakeCursorRunner(),
      cloudCursor,
      artifactMaxBytes: 64,
    },
    ids: deterministicIds(),
  });
  return { service, cloudCursor, fs };
}

const cloudInput = (): ShipInput => ({
  docPath: "docs.md",
  repo: "ship",
  runtime: "cloud",
  cloud: { repos: [{ url: "https://github.com/acme/sandbox" }] },
  workdir: WORKDIR,
});

const ARTIFACT_REF = {
  path: "out/report.txt",
  sizeBytes: 12,
  updatedAt: "2026-05-29T12:00:00.000Z",
} as const;

describe("ShipService — cloud artifacts", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.service.drainBackground();
  });

  test("cloud terminal persists manifest; listArtifacts reads DB", async () => {
    const payload = Buffer.from("hello-report");
    h.cloudCursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        durationMs: 1,
        branches: [],
        artifacts: [ARTIFACT_REF],
      },
      artifactBytes: { [ARTIFACT_REF.path]: payload },
    });
    const out = await h.service.ship(cloudInput());
    expect(out.status).toBe("succeeded");
    const listed = await h.service.listArtifacts(out.workflowRunId);
    expect(listed).toEqual([ARTIFACT_REF]);
  });

  test("local run: listArtifacts empty; download throws ArtifactsUnavailableLocalError", async () => {
    const localCursor = new FakeCursorRunner();
    const fs = createMemoryShipFs();
    await fs.mkdir(RUNS_DIR, { recursive: true });
    await fs.mkdir(WORKDIR, { recursive: true });
    await fs.writeFile(`${WORKDIR}/docs.md`, "x");
    const store = createStore({
      dbPath: ":memory:",
      clock: deterministicClock("2026-05-09T00:00:00.000Z"),
    });
    localCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [] },
    });
    const service = createShipService({
      store,
      fs,
      clock: deterministicClock("2026-05-09T00:00:00.000Z"),
      config: {
        runsDir: RUNS_DIR,
        defaultModel: { id: "composer-2.5" },
        cursor: localCursor,
        cloudCursor: h.cloudCursor,
      },
      ids: deterministicIds(),
    });
    const out = await service.ship({ docPath: "docs.md", repo: "ship", workdir: WORKDIR });
    expect(await service.listArtifacts(out.workflowRunId)).toEqual([]);
    await expect(service.downloadArtifact(out.workflowRunId, "x")).rejects.toBeInstanceOf(
      ArtifactsUnavailableLocalError,
    );
    store.close();
  });

  test("downloadArtifact writes bytes under run artifacts dir", async () => {
    const payload = Buffer.from("byte-identical");
    h.cloudCursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        durationMs: 1,
        branches: [],
        artifacts: [ARTIFACT_REF],
      },
      artifactBytes: { [ARTIFACT_REF.path]: payload },
    });
    const out = await h.service.ship(cloudInput());
    const downloaded = await h.service.downloadArtifact(out.workflowRunId, ARTIFACT_REF.path);
    expect(downloaded.sizeBytes).toBe(payload.length);
    const expected = resolveCloudArtifactDest(RUNS_DIR, out.workflowRunId, ARTIFACT_REF.path);
    expect(downloaded.localPath).toBe(expected);
    expect(h.fs.snapshot().binaryFiles.get(expected)?.equals(payload)).toBe(true);
  });

  test("path traversal in sdk path is rejected before download (no runner call)", async () => {
    const downloadSpy = vi.spyOn(h.cloudCursor, "downloadArtifact");
    h.cloudCursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        durationMs: 1,
        branches: [],
        artifacts: [{ path: "../escape.txt", sizeBytes: 1, updatedAt: ARTIFACT_REF.updatedAt }],
      },
      artifactBytes: { "../escape.txt": Buffer.from("x") },
    });
    const out = await h.service.ship(cloudInput());
    await expect(
      h.service.downloadArtifact(out.workflowRunId, "../escape.txt"),
    ).rejects.toBeInstanceOf(ArtifactPathEscapesRunDirError);
    expect(downloadSpy).not.toHaveBeenCalled();
    downloadSpy.mockRestore();
  });

  test("size guard trips without calling downloadArtifact on runner", async () => {
    const downloadSpy = vi.spyOn(h.cloudCursor, "downloadArtifact");
    h.cloudCursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        durationMs: 1,
        branches: [],
        artifacts: [{ path: "big.bin", sizeBytes: 999, updatedAt: ARTIFACT_REF.updatedAt }],
      },
      artifactBytes: { "big.bin": Buffer.alloc(999) },
    });
    const out = await h.service.ship(cloudInput());
    await expect(h.service.downloadArtifact(out.workflowRunId, "big.bin")).rejects.toBeInstanceOf(
      ArtifactTooLargeError,
    );
    expect(downloadSpy).not.toHaveBeenCalled();
    downloadSpy.mockRestore();
  });

  test("expired agent maps to ArtifactGoneError", async () => {
    h.cloudCursor.enqueue({
      events: [],
      result: {
        status: "succeeded",
        durationMs: 1,
        branches: [],
        artifacts: [ARTIFACT_REF],
      },
      artifactBytes: { [ARTIFACT_REF.path]: Buffer.from("x") },
    });
    const out = await h.service.ship(cloudInput());
    vi.spyOn(h.cloudCursor, "downloadArtifact").mockRejectedValue(
      new CursorAgentNotFoundError({ agentId: "gone", runId: "", runtime: "cloud" }),
    );
    await expect(
      h.service.downloadArtifact(out.workflowRunId, ARTIFACT_REF.path),
    ).rejects.toBeInstanceOf(ArtifactGoneError);
  });

  test("path not in manifest throws ArtifactNotInManifestError", async () => {
    h.cloudCursor.enqueue({
      events: [],
      result: { status: "succeeded", durationMs: 0, branches: [], artifacts: [ARTIFACT_REF] },
    });
    const out = await h.service.ship(cloudInput());
    await expect(
      h.service.downloadArtifact(out.workflowRunId, "missing.txt"),
    ).rejects.toBeInstanceOf(ArtifactNotInManifestError);
  });
});
