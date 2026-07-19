/** Tests for `importManifest`. */

import type { Store } from "@ship/store";

import { createStore, newDriverRunId } from "@ship/store";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importManifest, ImportManifestError } from "./import.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../test/fixtures");

function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

describe("importManifest", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("imports hygiene-followups with progress fields absorbed", () => {
    const path = fixturePath("hygiene-followups.driver.md");
    const { run } = importManifest(store, path);
    expect(run.status).toBe("done");
    expect(run.repo).toBe("dossier");
    expect(run.project).toBe("dossier");
    expect(run.phase).toBe("hygiene-followups");
    expect(run.sourceJson).toBe(readFileSync(path, "utf8"));

    const doneStreams = run.batches
      .flatMap((batch) => batch.streams)
      .filter((s) => s.status === "done");
    expect(doneStreams.length).toBeGreaterThan(0);
    expect(doneStreams.some((s) => s.prNumber !== undefined)).toBe(true);
    expect(doneStreams.some((s) => s.mergeCommit !== undefined)).toBe(true);
  });

  it("imports synthetic fixture with pending and failed stream mapping", () => {
    const path = fixturePath("synthetic-full.driver.md");
    const { run } = importManifest(store, path);
    expect(run.status).toBe("pending");

    const streams = run.batches.flatMap((batch) => batch.streams);
    const failed = streams.find((s) => s.taskSlug === "rooms-stream");
    expect(failed?.status).toBe("failed");
    expect(failed?.cycles).toBe(3);

    const inProgress = streams.find((s) => s.taskSlug === "cloud-stream");
    expect(inProgress?.status).toBe("pending");

    const skipped = streams.find((s) => s.taskSlug === "skipped-task");
    expect(skipped?.status).toBe("skipped");
  });

  it("re-import of same manifest is warn-and-noop", () => {
    const path = fixturePath("synthetic-full.driver.md");
    const first = importManifest(store, path);
    const second = importManifest(store, path);
    expect(second.alreadyImported).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(store.listDriverRuns({ limit: 50 })).toHaveLength(1);
  });

  it("re-import after editing progress fields in file is still noop", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-noop-"));
    const path = join(dir, "driver.md");
    const original = readFileSync(fixturePath("synthetic-full.driver.md"), "utf8");
    writeFileSync(path, original, "utf8");

    const first = importManifest(store, path);
    const edited = original.replace("status: failed", "status: done");
    writeFileSync(path, edited, "utf8");

    const second = importManifest(store, path);
    expect(second.alreadyImported).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(
      second.run.batches.flatMap((b) => b.streams).find((s) => s.taskSlug === "rooms-stream")
        ?.status,
    ).toBe("failed");
    rmSync(dir, { force: true, recursive: true });
  });

  it("re-import finds its run behind 200+ newer runs for the same repo", () => {
    const path = fixturePath("synthetic-full.driver.md");
    const first = importManifest(store, path);

    for (let index = 0; index < 201; index += 1) {
      store.insertDriverRun({
        batches: [],
        id: newDriverRunId(),
        manifestPath: `/tmp/noise-${String(index)}.md`,
        phase: `noise-phase-${String(index)}`,
        project: "ship",
        repo: first.run.repo,
        sourceJson: "---\ndriver_version: 1\n---\n",
        status: "pending",
      });
    }

    const second = importManifest(store, path);
    expect(second.alreadyImported).toBe(true);
    expect(second.run.id).toBe(first.run.id);
  });

  it("assigns streamIndex in manifest order", () => {
    const path = fixturePath("hygiene-followups.driver.md");
    const { run } = importManifest(store, path);
    const firstBatch = run.batches[0];
    expect(firstBatch?.streams.map((s) => s.streamIndex)).toEqual([0, 1, 2]);
  });

  it("propagates parse failures as ImportManifestError", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-bad-"));
    const path = join(dir, "driver.md");
    writeFileSync(path, "not a manifest", "utf8");
    expect(() => importManifest(store, path)).toThrow(ImportManifestError);
    rmSync(dir, { force: true, recursive: true });
  });

  it("wraps a missing manifest file as ImportManifestError", () => {
    const path = fixturePath("does-not-exist.driver.md");
    expect(() => importManifest(store, path)).toThrow(ImportManifestError);
    expect(() => importManifest(store, path)).toThrow(/cannot read manifest/);
  });

  it("returns warnings for manifests with unknown keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-warn-"));
    const path = join(dir, "driver.md");
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "base_branch: main",
      "batches: []",
      "---",
    ].join("\n");
    writeFileSync(path, text, "utf8");

    const { run, warnings } = importManifest(store, path);
    expect(run.repo).toBe("ship");
    expect(warnings).toBeDefined();
    expect(warnings?.some((warning) => warning.includes('unknown field "base_branch"'))).toBe(true);
    rmSync(dir, { force: true, recursive: true });
  });

  it("round-trips rolls_up from a manifest stream to the parsed store row", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-rollsup-"));
    const path = join(dir, "driver.md");
    writeFileSync(
      path,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-07-12T00:00:00Z",
        "generated_by: test",
        "source:",
        "  project: ship",
        "  phase: rolls-up-test",
        "repo: ship",
        "batches:",
        "  - id: 1",
        "    depends_on: []",
        "    streams:",
        "      - spec_path: docs/a.md",
        "        branch_name: feat-a",
        "        rolls_up: [tsk_A, tsk_B]",
        "      - spec_path: docs/b.md",
        "        branch_name: feat-b",
        "---",
      ].join("\n"),
      "utf8",
    );

    const { run } = importManifest(store, path);
    const streams = run.batches[0]?.streams ?? [];
    expect(streams[0]?.rollsUp).toEqual(["tsk_A", "tsk_B"]);
    // No rolls_up on the manifest stream reads back absent, not empty.
    expect(streams[1]?.rollsUp).toBeUndefined();

    // Reload through a fresh hydration to prove the value survives the real
    // column round-trip, not just the insert-time object.
    const reloaded = store.getDriverRun(run.id);
    expect(reloaded?.batches[0]?.streams[0]?.rollsUp).toEqual(["tsk_A", "tsk_B"]);
    rmSync(dir, { force: true, recursive: true });
  });

  it("re-import of manifest with unknown keys still returns warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-rewarn-"));
    const path = join(dir, "driver.md");
    const text = [
      "---",
      "driver_version: 1",
      "generated_at: 2026-06-10T00:00:00Z",
      "generated_by: work-driver-prep",
      "source:",
      "  project: ship",
      "  phase: test",
      "repo: ship",
      "rolls_up_task_ids: [tsk_01]",
      "batches: []",
      "---",
    ].join("\n");
    writeFileSync(path, text, "utf8");

    const first = importManifest(store, path);
    const second = importManifest(store, path);
    expect(second.alreadyImported).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(second.warnings?.some((warning) => warning.includes("rolls_up_task_ids"))).toBe(true);
    rmSync(dir, { force: true, recursive: true });
  });
});

describe("importManifest tier threading", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("persists resolved tiers on stream rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-tier-"));
    const path = join(dir, "driver.md");
    writeFileSync(
      path,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-07-01T00:00:00Z",
        "generated_by: test",
        "source:",
        "  project: ship",
        "  phase: tier-test",
        "repo: ship",
        "default_model: sonnet",
        "default_effort: extra",
        "batches:",
        "  - id: 1",
        "    depends_on: []",
        "    streams:",
        "      - spec_path: docs/a.md",
        "        branch_name: feat-a",
        "        model: opus",
        "      - spec_path: docs/b.md",
        "        branch_name: feat-b",
        "---",
      ].join("\n"),
      "utf8",
    );

    const { run } = importManifest(store, path);
    const streams = run.batches[0]?.streams ?? [];
    expect(streams[0]?.modelTier).toBe("opus");
    expect(streams[0]?.effortTier).toBe("extra");
    expect(streams[1]?.modelTier).toBe("sonnet");
    expect(streams[1]?.effortTier).toBe("extra");
    rmSync(dir, { force: true, recursive: true });
  });

  it("persists model_id (stream field and default) onto stream rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-modelid-"));
    const path = join(dir, "driver.md");
    writeFileSync(
      path,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-07-13T00:00:00Z",
        "generated_by: test",
        "source:",
        "  project: ship",
        "  phase: modelid-test",
        "repo: ship",
        "default_model_id: composer-2.5",
        "batches:",
        "  - id: 1",
        "    depends_on: []",
        "    streams:",
        "      - spec_path: docs/a.md",
        "        model_id: grok-4.5",
        "      - spec_path: docs/b.md",
        "---",
      ].join("\n"),
      "utf8",
    );

    const { run } = importManifest(store, path);
    const streams = run.batches[0]?.streams ?? [];
    // Stream field wins; the second stream inherits the run default.
    expect(streams[0]?.modelId).toBe("grok-4.5");
    expect(streams[1]?.modelId).toBe("composer-2.5");
    rmSync(dir, { force: true, recursive: true });
  });
});

describe("importManifest provider threading", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("persists resolved provider on stream rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-provider-"));
    const path = join(dir, "driver.md");
    writeFileSync(
      path,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-07-02T00:00:00Z",
        "generated_by: test",
        "source:",
        "  project: ship",
        "  phase: provider-test",
        "repo: ship",
        "default_provider: claude",
        "batches:",
        "  - id: 1",
        "    depends_on: []",
        "    streams:",
        "      - spec_path: docs/a.md",
        "        branch_name: feat-a",
        "        provider: codex",
        "      - spec_path: docs/b.md",
        "        branch_name: feat-b",
        "---",
      ].join("\n"),
      "utf8",
    );

    const { run } = importManifest(store, path);
    const streams = run.batches[0]?.streams ?? [];
    expect(streams[0]?.provider).toBe("codex");
    expect(streams[1]?.provider).toBe("claude");
    rmSync(dir, { force: true, recursive: true });
  });

  it("rejects codex provider with cloud runtime at import", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-codex-cloud-"));
    const path = join(dir, "driver.md");
    writeFileSync(
      path,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-07-02T00:00:00Z",
        "generated_by: test",
        "source:",
        "  project: ship",
        "  phase: codex-cloud",
        "repo: ship",
        "repo_url: https://github.com/example/ship",
        "batches:",
        "  - id: 1",
        "    depends_on: []",
        "    streams:",
        "      - spec_path: docs/a.md",
        "        task_slug: codex-cloud-task",
        "        provider: codex",
        "        runtime: cloud",
        "---",
      ].join("\n"),
      "utf8",
    );

    expect(() => importManifest(store, path)).toThrow(ImportManifestError);
    expect(() => importManifest(store, path)).toThrow(/codex-cloud-task/);
    expect(() => importManifest(store, path)).toThrow(
      /codex provider supports only runtime 'local'/,
    );
    rmSync(dir, { force: true, recursive: true });
  });

  it("rejects claude cloud stream without branch_name at import", () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-import-claude-cloud-"));
    const path = join(dir, "driver.md");
    writeFileSync(
      path,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-07-02T00:00:00Z",
        "generated_by: test",
        "source:",
        "  project: ship",
        "  phase: claude-cloud",
        "repo: ship",
        "repo_url: https://github.com/example/ship",
        "batches:",
        "  - id: 1",
        "    depends_on: []",
        "    streams:",
        "      - spec_path: docs/a.md",
        "        task_slug: claude-cloud-task",
        "        provider: claude",
        "        runtime: cloud",
        "---",
      ].join("\n"),
      "utf8",
    );

    expect(() => importManifest(store, path)).toThrow(ImportManifestError);
    expect(() => importManifest(store, path)).toThrow(/claude-cloud-task/);
    expect(() => importManifest(store, path)).toThrow(/requires branch_name/);
    rmSync(dir, { force: true, recursive: true });
  });
});

describe("importManifest dispatch policy", () => {
  let store: Store;
  let repoRoot: string;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
    repoRoot = mkdtempSync(join(tmpdir(), "ship-import-policy-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
  });

  afterEach(() => {
    store.close();
    rmSync(repoRoot, { force: true, recursive: true });
  });

  function writeManifest(streams: string, extra = ""): string {
    const path = join(repoRoot, "driver.md");
    writeFileSync(
      path,
      [
        "---",
        "driver_version: 1",
        "generated_at: 2026-07-15T00:00:00Z",
        "generated_by: test",
        "source:",
        "  project: ship",
        "  phase: policy-test",
        "repo: ship",
        "repo_url: https://github.com/example/ship",
        ...(extra !== "" ? [extra] : []),
        "batches:",
        "  - id: 1",
        "    depends_on: []",
        "    streams:",
        streams,
        "---",
      ].join("\n"),
      "utf8",
    );
    return path;
  }

  function writePolicy(policy: unknown): void {
    writeFileSync(join(repoRoot, ".ship.json"), JSON.stringify(policy), "utf8");
  }

  it("fills provider from the policy default when no manifest field sets it", () => {
    writePolicy({ provider: { default: "claude" } });
    const path = writeManifest("      - spec_path: docs/a.md\n        branch_name: feat-a");

    const { run } = importManifest(store, path);
    expect(run.batches[0]?.streams[0]?.provider).toBe("claude");
  });

  it("lets an explicit manifest provider beat the policy default", () => {
    writePolicy({ provider: { default: "claude" } });
    const path = writeManifest(
      "      - spec_path: docs/a.md\n        provider: codex\n        runtime: local",
    );

    const { run } = importManifest(store, path);
    expect(run.batches[0]?.streams[0]?.provider).toBe("codex");
  });

  it("rejects a cloud stream at import when the policy allows local only", () => {
    writePolicy({ runtime: { allow: ["local"] } });
    const path = writeManifest(
      "      - spec_path: docs/a.md\n        task_slug: cloud-task\n        branch_name: feat-a\n        runtime: cloud",
    );

    expect(() => importManifest(store, path)).toThrow(ImportManifestError);
    expect(() => importManifest(store, path)).toThrow(/cloud-task/);
    expect(() => importManifest(store, path)).toThrow(/\.ship\.json/);
    expect(() => importManifest(store, path)).toThrow(/runtime 'cloud' is not permitted/);
  });

  it("throws a hard error on a malformed policy file before inserting", () => {
    writeFileSync(join(repoRoot, ".ship.json"), "{ broken", "utf8");
    const path = writeManifest("      - spec_path: docs/a.md\n        branch_name: feat-a");

    expect(() => importManifest(store, path)).toThrow(/invalid dispatch policy/);
    expect(store.listDriverRuns({ limit: 50 })).toHaveLength(0);
  });

  it("imports unchanged when no policy file is present", () => {
    const path = writeManifest(
      "      - spec_path: docs/a.md\n        branch_name: feat-a\n        runtime: cloud",
    );
    const { run } = importManifest(store, path);
    expect(run.batches[0]?.streams[0]?.runtime).toBe("cloud");
  });
});

describe("importManifest fallback chains", () => {
  let store: Store;
  let dir: string;
  const FULL_ENV = {
    ANTHROPIC_API_KEY: "k",
    ANTHROPIC_AUTH_TOKEN: "t",
    CURSOR_API_KEY: "k",
    CODEX_API_KEY: "k",
  };
  const HEADER = [
    "driver_version: 1",
    "generated_at: 2026-07-13T00:00:00Z",
    "generated_by: test",
    "source:",
    "  project: ship",
    "  phase: fallback-test",
    "repo: ship",
  ];

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
    dir = mkdtempSync(join(tmpdir(), "ship-import-fallback-"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { force: true, recursive: true });
  });

  function writeManifest(frontmatter: string[]): string {
    const path = join(dir, "driver.md");
    writeFileSync(path, ["---", ...frontmatter, "---", ""].join("\n"), "utf8");
    return path;
  }

  // A single cloud/cursor stream (repo_url + branch_name present) with the given
  // extra stream lines (8-space indented). The baseline is structurally valid so
  // tests isolate the fallback behavior under test.
  function cloudCursorStream(streamLines: string[]): string {
    return writeManifest([
      ...HEADER,
      "repo_url: https://github.com/itsHabib/ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "        branch_name: feat-a",
      "        runtime: cloud",
      "        provider: cursor",
      ...streamLines.map((line) => `        ${line}`),
    ]);
  }

  it("freezes the resolved chain with cursor 0, empty log, and reviewCycles 0", () => {
    const path = cloudCursorStream([
      "fallback:",
      "  - runtime: cloud",
      "    provider: claude",
      "    model_id: claude-opus-4-8",
      "  - runtime: local",
      "    provider: claude",
    ]);
    const { run } = importManifest(store, path, { env: FULL_ENV });
    const stream = run.batches[0]?.streams[0];
    expect(stream?.fallbackChain).toEqual([
      { runtime: "cloud", provider: "claude", modelId: "claude-opus-4-8" },
      { runtime: "local", provider: "claude" },
    ]);
    expect(stream?.fallbackCursor).toBe(0);
    expect(stream?.fallbackLog).toEqual([]);
    expect(stream?.reviewCycles).toBe(0);
  });

  it("inherits default_fallback for a stream that omits fallback; an explicit chain wins", () => {
    const path = writeManifest([
      ...HEADER,
      "repo_url: https://github.com/itsHabib/ship",
      "default_fallback:",
      "  - runtime: local",
      "    provider: claude",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "        branch_name: feat-a",
      "        runtime: cloud",
      "        provider: cursor",
      "      - spec_path: docs/b.md",
      "        branch_name: feat-b",
      "        runtime: cloud",
      "        provider: cursor",
      "        fallback:",
      "          - runtime: cloud",
      "            provider: claude",
    ]);
    const { run } = importManifest(store, path, { env: FULL_ENV });
    const streams = run.batches[0]?.streams ?? [];
    expect(streams[0]?.fallbackChain).toEqual([{ runtime: "local", provider: "claude" }]);
    expect(streams[1]?.fallbackChain).toEqual([{ runtime: "cloud", provider: "claude" }]);
  });

  it("initializes reviewCycles to 0 and leaves fallback columns absent for a chainless stream", () => {
    const path = cloudCursorStream([]);
    const stream = importManifest(store, path, { env: FULL_ENV }).run.batches[0]?.streams[0];
    expect(stream?.reviewCycles).toBe(0);
    expect(stream?.fallbackChain).toBeUndefined();
    expect(stream?.fallbackCursor).toBeUndefined();
    expect(stream?.fallbackLog).toBeUndefined();
  });

  it("rejects a rooms fallback target", () => {
    const path = cloudCursorStream(["fallback:", "  - runtime: rooms", "    provider: cursor"]);
    expect(() => importManifest(store, path, { env: FULL_ENV })).toThrow(
      /rooms is not a valid fallback target/,
    );
  });

  it("rejects an unwired fallback cell", () => {
    const path = cloudCursorStream(["fallback:", "  - runtime: cloud", "    provider: codex"]);
    expect(() => importManifest(store, path, { env: FULL_ENV })).toThrow(
      /cloud\/codex is not a wired dispatch cell/,
    );
  });

  it("rejects a fallback target that duplicates the primary", () => {
    const path = cloudCursorStream(["fallback:", "  - runtime: cloud", "    provider: cursor"]);
    expect(() => importManifest(store, path, { env: FULL_ENV })).toThrow(
      /duplicate fallback target cloud\/cursor/,
    );
  });

  it("rejects a fallback that duplicates the implicit engine-default primary", () => {
    // No provider anywhere: the engine dispatches such a stream as cursor, so a
    // cloud/cursor fallback is a hop back to the same cell.
    const path = writeManifest([
      ...HEADER,
      "repo_url: https://github.com/itsHabib/ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "        branch_name: feat-a",
      "        runtime: cloud",
      "        fallback:",
      "          - runtime: cloud",
      "            provider: cursor",
    ]);
    expect(() => importManifest(store, path, { env: FULL_ENV })).toThrow(
      /duplicate fallback target cloud\/cursor/,
    );
  });

  it("rejects two identical fallback entries", () => {
    const path = cloudCursorStream([
      "fallback:",
      "  - runtime: local",
      "    provider: claude",
      "  - runtime: local",
      "    provider: claude",
    ]);
    expect(() => importManifest(store, path, { env: FULL_ENV })).toThrow(
      /duplicate fallback target/,
    );
  });

  it("rejects a fallback needing branch_name when the stream has none", () => {
    // Primary cloud/cursor needs no branch; the local/cursor fallback does.
    const path = writeManifest([
      ...HEADER,
      "repo_url: https://github.com/itsHabib/ship",
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "        runtime: cloud",
      "        provider: cursor",
      "        fallback:",
      "          - runtime: local",
      "            provider: cursor",
    ]);
    expect(() => importManifest(store, path, { env: FULL_ENV })).toThrow(
      /local\/cursor requires branch_name/,
    );
  });

  it("rejects a cloud fallback when the manifest has no repo_url", () => {
    // Primary local/cursor needs no repo_url; the cloud/cursor fallback does.
    const path = writeManifest([
      ...HEADER,
      "batches:",
      "  - id: 1",
      "    depends_on: []",
      "    streams:",
      "      - spec_path: docs/a.md",
      "        branch_name: feat-a",
      "        runtime: local",
      "        provider: cursor",
      "        fallback:",
      "          - runtime: cloud",
      "            provider: cursor",
    ]);
    expect(() => importManifest(store, path, { env: FULL_ENV })).toThrow(
      /cloud\/cursor requires repo_url/,
    );
  });

  it("warns (does not fail) when a fallback target's credential is absent from env", () => {
    const path = cloudCursorStream(["fallback:", "  - runtime: local", "    provider: claude"]);
    const { warnings } = importManifest(store, path, { env: {} });
    expect(warnings?.join("\n")).toMatch(
      /fallback target local\/claude: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY not set/,
    );
  });

  it("emits no warning when the fallback credential is present", () => {
    const path = cloudCursorStream(["fallback:", "  - runtime: local", "    provider: claude"]);
    const { warnings } = importManifest(store, path, { env: { ANTHROPIC_API_KEY: "k" } });
    expect(warnings).toBeUndefined();
  });
});
