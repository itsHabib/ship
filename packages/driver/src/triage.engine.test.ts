/**
 * Engine e2e (fake runners): triage-floor classification threaded through
 * poll → land. A stream's PR is classified once per head; a moved head
 * re-classifies; a classifier failure records `classifier_error` with no tier.
 */

import type { LogFields, Logger } from "@ship/logger";
import type { DriverStream } from "@ship/store";

import { createStore } from "@ship/store";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { TriageClassifier, TriageOutcome } from "./triage.js";

import { resolveDocPath } from "./engine.js";
import { createDriverService } from "./service.js";
import { createFakeGhPort } from "./test/fake-gh-port.js";
import { createFakeShipPort } from "./test/fake-ship-port.js";

interface RecordingTriage {
  classifier: TriageClassifier;
  calls: { slug: string; pr: number }[];
}

function recordingTriage(respond: (slug: string, pr: number) => TriageOutcome): RecordingTriage {
  const calls: { slug: string; pr: number }[] = [];
  return {
    calls,
    classifier: {
      classify: (slug, pr) => {
        calls.push({ pr, slug });
        return Promise.resolve(respond(slug, pr));
      },
    },
  };
}

function capturingLogger(sink: string[]): Logger {
  const record = (_fields: LogFields, msg: string): void => {
    sink.push(msg);
  };
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: record,
    error: record,
    child: () => logger,
  };
  return logger;
}

describe("engine triage classification", () => {
  let tmpDir: string;
  let repoRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "triage-engine-"));
    repoRoot = join(tmpDir, "repo");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(repoRoot, "docs", "tasks"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "tasks", "a.md"), "# task a\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  function writeCloudManifest(): string {
    const path = join(repoRoot, "triage.driver.md");
    writeFileSync(
      path,
      `---
driver_version: 1
generated_at: 2026-07-22T00:00:00Z
generated_by: test
source:
  project: ship
  phase: triage
repo: ship
repo_url: https://github.com/example/ship
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/tasks/a.md
        runtime: cloud
        status: pending
---
`,
    );
    return path;
  }

  function cloudShipPort(prNumber: number) {
    const docA = resolveDocPath(repoRoot, "docs/tasks/a.md");
    return createFakeShipPort([
      {
        docPath: docA,
        prUrl: `https://github.com/example/ship/pull/${String(prNumber)}`,
        repo: "ship",
        workflowRunId: "wf_cloud",
      },
    ]);
  }

  function landedStream(store: ReturnType<typeof createStore>, runId: string): DriverStream {
    const stream = store.getDriverRun(runId)?.batches[0]?.streams[0];
    if (stream === undefined) throw new Error("stream missing");
    return stream;
  }

  test("classified tier + source + lowercased head persist on land", async () => {
    const manifest = writeCloudManifest();
    const fake = cloudShipPort(9);
    const gh = createFakeGhPort({ 9: { headRefOid: "ABC123", isDraft: false, state: "OPEN" } });
    const triage = recordingTriage(() => ({ kind: "classified", tier: "T1" }));
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store, triage: triage.classifier });
    const runId = driver.importManifest(manifest).run.id;

    await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });

    const stream = landedStream(store, runId);
    expect(stream.status).toBe("landed");
    expect(stream.triageTier).toBe("T1");
    expect(stream.triageTierSource).toBe("classified");
    expect(stream.triageHeadSha).toBe("abc123");
    // The `-R` slug is the owner/name derived from repo_url, never the store label.
    expect(triage.calls).toEqual([{ pr: 9, slug: "example/ship" }]);
    store.close();
  });

  test("classifier failure records classifier_error with no tier + a warning", async () => {
    const manifest = writeCloudManifest();
    const fake = cloudShipPort(9);
    const gh = createFakeGhPort({ 9: { headRefOid: "def456", isDraft: false, state: "OPEN" } });
    const triage = recordingTriage(() => ({ kind: "error", reason: "triage-floor exited 1" }));
    const warnings: string[] = [];
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({
      gh,
      logger: capturingLogger(warnings),
      ship: fake.port,
      store,
      triage: triage.classifier,
    });
    const runId = driver.importManifest(manifest).run.id;

    await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });

    const stream = landedStream(store, runId);
    expect(stream.status).toBe("landed");
    expect(stream.triageTierSource).toBe("classifier_error");
    expect(stream.triageTier).toBeUndefined();
    expect(stream.triageHeadSha).toBe("def456");
    expect(warnings.some((w) => w.includes("classifier error"))).toBe(true);
    store.close();
  });

  test("a broken classifier clears any prior routable tier", async () => {
    const manifest = writeCloudManifest();
    const fake = cloudShipPort(9);
    const gh = createFakeGhPort({ 9: { headRefOid: "newhead", isDraft: false, state: "OPEN" } });
    const triage = recordingTriage(() => ({ kind: "error", reason: "boom" }));
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store, triage: triage.classifier });
    const runId = driver.importManifest(manifest).run.id;
    // Pre-seed a stale classified tier bound to an older head.
    const seedId = landedStream(store, runId).id;
    store.updateDriverStream(seedId, {
      triageHeadSha: "oldhead",
      triageTier: "T1",
      triageTierSource: "classified",
    });

    await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });

    const stream = landedStream(store, runId);
    expect(stream.triageTierSource).toBe("classifier_error");
    expect(stream.triageTier).toBeUndefined();
    store.close();
  });

  test("an already-classified head is not re-classified", async () => {
    const manifest = writeCloudManifest();
    const fake = cloudShipPort(9);
    const gh = createFakeGhPort({ 9: { headRefOid: "steady", isDraft: false, state: "OPEN" } });
    const triage = recordingTriage(() => ({ kind: "classified", tier: "T3" }));
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store, triage: triage.classifier });
    const runId = driver.importManifest(manifest).run.id;
    // Same head already classified — the guard must skip re-classification.
    const seedId = landedStream(store, runId).id;
    store.updateDriverStream(seedId, {
      triageHeadSha: "steady",
      triageTier: "T0",
      triageTierSource: "classified",
    });

    await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });

    const stream = landedStream(store, runId);
    expect(triage.calls).toHaveLength(0);
    expect(stream.triageTier).toBe("T0");
    store.close();
  });

  test("a moved head re-classifies", async () => {
    const manifest = writeCloudManifest();
    const fake = cloudShipPort(9);
    const gh = createFakeGhPort({ 9: { headRefOid: "movedhead", isDraft: false, state: "OPEN" } });
    const triage = recordingTriage(() => ({ kind: "classified", tier: "T2" }));
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store, triage: triage.classifier });
    const runId = driver.importManifest(manifest).run.id;
    // A prior classification bound to a now-stale head.
    const seedId = landedStream(store, runId).id;
    store.updateDriverStream(seedId, {
      triageHeadSha: "stalehead",
      triageTier: "T1",
      triageTierSource: "classified",
    });

    await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });

    const stream = landedStream(store, runId);
    expect(triage.calls).toHaveLength(1);
    expect(stream.triageTier).toBe("T2");
    expect(stream.triageHeadSha).toBe("movedhead");
    store.close();
  });

  test("no classifier wired → stream lands with no triage state", async () => {
    const manifest = writeCloudManifest();
    const fake = cloudShipPort(9);
    const gh = createFakeGhPort({ 9: { isDraft: false, state: "OPEN" } });
    const store = createStore({ dbPath: ":memory:" });
    const driver = createDriverService({ gh, ship: fake.port, store });
    const runId = driver.importManifest(manifest).run.id;

    await driver.run({ driverRunId: runId }, { maxWaitMs: 0 });

    const stream = landedStream(store, runId);
    expect(stream.status).toBe("landed");
    expect(stream.triageTierSource).toBeUndefined();
    expect(stream.triageTier).toBeUndefined();
    store.close();
  });
});
