/**
 * Unit tests for `RoomCursorRunner` — the subprocess orchestrator over the
 * `rooms` binary. The `spawn` seam is injected: a fake spawn writes the
 * host-collected `--out` contract artifacts to the real temp dir the runner
 * created, then emits `close`; the runner reads them back with real fs. No
 * real `rooms` binary, no microVM. See `phases/room-cursor-runner.md`.
 */

import type { SDKMessage } from "@cursor/sdk";

import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { RoomsChild, RoomsSpawn } from "./room-runner.js";
import type { CursorRunInput, RoomRunSpec } from "./runner.js";

import {
  InvalidRoomReposError,
  MissingRoomSpecError,
  RoomArtifactError,
  RoomResumeNotSupportedError,
  RoomSchemaVersionError,
  WrongRunnerError,
} from "./errors.js";
import { RoomCursorRunner } from "./room-runner.js";

const REPO_URL = "https://github.com/itsHabib/roxiq";

// Temp roots the runner created (parent of each `--out` dir); removed after
// each test so failure/cancel paths (which intentionally leave their dir for
// debugging) don't litter the OS temp.
const createdRoots = new Set<string>();

afterEach(async () => {
  for (const root of createdRoots) {
    await rm(root, { force: true, recursive: true }).catch(() => undefined);
  }
  createdRoots.clear();
});

interface FakeRoomsOpts {
  /** `result.json` body: object → JSON-encoded, string → verbatim, omitted → file not written. */
  readonly result?: Record<string, unknown> | string;
  readonly summary?: string;
  readonly events?: string;
  /** Default true: emit `close(0)` after writing artifacts. */
  readonly autoClose?: boolean;
  /** Default true: `kill()` emits `close`. */
  readonly closeOnKill?: boolean;
  /** When set, emit `error` instead of writing/closing (spawn failure). */
  readonly spawnError?: Error;
}

class FakeRoomsChild extends EventEmitter {
  killed = false;
  readonly #closeOnKill: boolean;

  constructor(closeOnKill: boolean) {
    super();
    this.#closeOnKill = closeOnKill;
  }

  kill(): boolean {
    this.killed = true;
    if (this.#closeOnKill) {
      setImmediate(() => this.emit("close", null, "SIGTERM"));
    }
    return true;
  }
}

interface RecordedSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function fakeRooms(opts: FakeRoomsOpts = {}): { spawn: RoomsSpawn; calls: RecordedSpawn[] } {
  const calls: RecordedSpawn[] = [];
  const spawn: RoomsSpawn = (command, args, options) => {
    calls.push({ args: [...args], command, env: options.env });
    const outDir = outDirFromArgs(args);
    createdRoots.add(dirname(outDir));
    const child = new FakeRoomsChild(opts.closeOnKill !== false);
    if (opts.spawnError !== undefined) {
      const err = opts.spawnError;
      setImmediate(() => child.emit("error", err));
      return child as RoomsChild;
    }
    writeArtifacts(outDir, opts);
    if (opts.autoClose !== false) {
      setImmediate(() => {
        if (!child.killed) child.emit("close", 0, null);
      });
    }
    return child as RoomsChild;
  };
  return { calls, spawn };
}

function outDirFromArgs(args: readonly string[]): string {
  const i = args.indexOf("--out");
  const dir = i >= 0 ? args[i + 1] : undefined;
  if (dir === undefined) throw new Error("fakeRooms: no --out in args");
  return dir;
}

function writeArtifacts(outDir: string, opts: FakeRoomsOpts): void {
  if (opts.result !== undefined) {
    const body = typeof opts.result === "string" ? opts.result : JSON.stringify(opts.result);
    writeFileSync(join(outDir, "result.json"), body);
  }
  if (opts.summary !== undefined) writeFileSync(join(outDir, "summary.md"), opts.summary);
  if (opts.events !== undefined) writeFileSync(join(outDir, "events.ndjson"), opts.events);
}

function roomsInput(overrides: Partial<CursorRunInput> = {}): CursorRunInput {
  return {
    cwd: "",
    model: { id: "composer-2.5" },
    onEvent: () => undefined,
    prompt: "do the thing",
    room: { repos: [{ url: REPO_URL }] },
    runtime: "rooms",
    ...overrides,
  };
}

function successResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ended_at: "2026-06-07T00:00:30.000Z",
    exit_code: 0,
    pushed_branch: "rooms/ship-wf-1-abcd1234",
    schema_version: 1,
    started_at: "2026-06-07T00:00:00.000Z",
    status: "success",
    ...extra,
  };
}

describe("RoomCursorRunner.run — input guards", () => {
  test('rejects runtime !== "rooms" with WrongRunnerError', async () => {
    const runner = new RoomCursorRunner({ spawn: fakeRooms().spawn });
    await expect(runner.run(roomsInput({ runtime: "local" }))).rejects.toBeInstanceOf(
      WrongRunnerError,
    );
  });

  test("rejects missing room with MissingRoomSpecError", async () => {
    const runner = new RoomCursorRunner({ spawn: fakeRooms().spawn });
    // Drop `room` entirely (exactOptionalPropertyTypes rejects `room: undefined`).
    const { room: _omit, ...noRoom } = roomsInput();
    await expect(runner.run(noRoom)).rejects.toBeInstanceOf(MissingRoomSpecError);
  });

  test("rejects multi-repo room with InvalidRoomReposError", async () => {
    const runner = new RoomCursorRunner({ spawn: fakeRooms().spawn });
    const twoRepos = {
      repos: [{ url: REPO_URL }, { url: "https://github.com/itsHabib/ship" }],
    } as unknown as RoomRunSpec;
    await expect(runner.run(roomsInput({ room: twoRepos }))).rejects.toBeInstanceOf(
      InvalidRoomReposError,
    );
  });
});

describe("RoomCursorRunner.run — argv + env", () => {
  test("builds the rooms argv; GH_TOKEN rides env not argv; defaults base-sha HEAD + derives push-branch", async () => {
    const saved = process.env["GH_TOKEN"];
    process.env["GH_TOKEN"] = "ghs_secret_value";
    try {
      const f = fakeRooms({ result: successResult(), summary: "ok" });
      const runner = new RoomCursorRunner({ spawn: f.spawn });
      const handle = await runner.run(roomsInput({ agentName: "ship/wf_test" }));
      await handle.result;

      const call = f.calls[0]!;
      expect(call.command).toBe("rooms");
      expect(call.args.slice(0, 3)).toEqual(["run", "--runner", "cursor"]);
      expect(argVal(call.args, "--repo")).toBe(REPO_URL);
      expect(argVal(call.args, "--base-sha")).toBe("HEAD");
      expect(argVal(call.args, "--model")).toBe("composer-2.5");
      expect(argVal(call.args, "--push-branch")).toMatch(/^rooms\/ship-wf-test-[0-9a-f]{8}$/);
      expect(call.args).not.toContain("--image");
      // Token never in argv.
      expect(call.args.join(" ")).not.toContain("ghs_secret_value");
      // Token forwarded on env.
      expect(call.env["GH_TOKEN"]).toBe("ghs_secret_value");
    } finally {
      restoreEnv("GH_TOKEN", saved);
    }
  });

  test("maps GITHUB_TOKEN → GH_TOKEN on env", async () => {
    const savedGh = process.env["GH_TOKEN"];
    const savedGithub = process.env["GITHUB_TOKEN"];
    delete process.env["GH_TOKEN"];
    process.env["GITHUB_TOKEN"] = "ghp_from_github_token";
    try {
      const f = fakeRooms({ result: successResult() });
      const runner = new RoomCursorRunner({ spawn: f.spawn });
      await (
        await runner.run(roomsInput())
      ).result;
      expect(f.calls[0]!.env["GH_TOKEN"]).toBe("ghp_from_github_token");
    } finally {
      restoreEnv("GH_TOKEN", savedGh);
      restoreEnv("GITHUB_TOKEN", savedGithub);
    }
  });

  test("passes --image from room.image, then constructor defaultImage, else omits", async () => {
    const fromSpec = fakeRooms({ result: successResult() });
    await (
      await new RoomCursorRunner({ spawn: fromSpec.spawn }).run(
        roomsInput({ room: { image: "spec.ext4", repos: [{ url: REPO_URL }] } }),
      )
    ).result;
    expect(argVal(fromSpec.calls[0]!.args, "--image")).toBe("spec.ext4");

    const fromDefault = fakeRooms({ result: successResult() });
    await (
      await new RoomCursorRunner({ defaultImage: "default.ext4", spawn: fromDefault.spawn }).run(
        roomsInput(),
      )
    ).result;
    expect(argVal(fromDefault.calls[0]!.args, "--image")).toBe("default.ext4");
  });

  test("honors an explicit room.pushBranch and room.startingRef", async () => {
    const f = fakeRooms({ result: successResult() });
    const runner = new RoomCursorRunner({ spawn: f.spawn });
    await (
      await runner.run(
        roomsInput({
          room: { pushBranch: "rooms/custom", repos: [{ startingRef: "abc123", url: REPO_URL }] },
        }),
      )
    ).result;
    expect(argVal(f.calls[0]!.args, "--base-sha")).toBe("abc123");
    expect(argVal(f.calls[0]!.args, "--push-branch")).toBe("rooms/custom");
  });
});

describe("RoomCursorRunner.run — terminal result", () => {
  test("success → CursorRunResult with branches, durationMs, summary; synthetic ids", async () => {
    const f = fakeRooms({ result: successResult(), summary: "implementation done" });
    const runner = new RoomCursorRunner({ spawn: f.spawn });
    const handle = await runner.run(roomsInput());
    expect(handle.agentId).toMatch(/^room-/);
    expect(handle.runId).toMatch(/^run-/);

    const result = await handle.result;
    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("implementation done");
    expect(result.durationMs).toBe(30_000);
    expect(result.branches).toEqual([{ branch: "rooms/ship-wf-1-abcd1234", repoUrl: REPO_URL }]);
    expect(result.sdkTerminalStatus).toBe("success");
  });

  test("events.ndjson is replayed through onEvent before result resolves; malformed lines skipped", async () => {
    const seen: string[] = [];
    const f = fakeRooms({
      events: '{"type":"a"}\n{"type":"b"}\n\nnot-json\n',
      result: successResult(),
    });
    const runner = new RoomCursorRunner({ spawn: f.spawn });
    const handle = await runner.run(
      roomsInput({
        onEvent: (ev: SDKMessage) => {
          seen.push((ev as unknown as { type?: string }).type ?? "?");
        },
      }),
    );
    await handle.result;
    // By the time result resolves, the full replay has run (collectRoomRun
    // awaits the replay before building the result), malformed line dropped.
    expect(seen).toEqual(["a", "b"]);
  });

  test("failed status → status failed, errorMessage from summary, empty branches", async () => {
    const f = fakeRooms({
      result: successResult({ exit_code: 1, pushed_branch: "", status: "failed" }),
      summary: "boom: the build broke",
    });
    const runner = new RoomCursorRunner({ spawn: f.spawn });
    const result = await (await runner.run(roomsInput())).result;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("boom: the build broke");
    expect(result.branches).toEqual([]);
    expect(result.sdkTerminalStatus).toBe("failed");
  });

  test("unknown status falls back to exit_code (0 → succeeded)", async () => {
    const f = fakeRooms({ result: successResult({ exit_code: 0, status: "weird-new-word" }) });
    const result = await (await new RoomCursorRunner({ spawn: f.spawn }).run(roomsInput())).result;
    expect(result.status).toBe("succeeded");
  });
});

describe("RoomCursorRunner.run — artifact contract failures (reject result)", () => {
  test("schema_version drift → RoomSchemaVersionError", async () => {
    const f = fakeRooms({ result: successResult({ schema_version: 2 }) });
    const handle = await new RoomCursorRunner({ spawn: f.spawn }).run(roomsInput());
    await expect(handle.result).rejects.toBeInstanceOf(RoomSchemaVersionError);
  });

  test("missing result.json → RoomArtifactError", async () => {
    const f = fakeRooms({ summary: "no result.json written" });
    const handle = await new RoomCursorRunner({ spawn: f.spawn }).run(roomsInput());
    await expect(handle.result).rejects.toBeInstanceOf(RoomArtifactError);
  });

  test("malformed result.json → RoomArtifactError", async () => {
    const f = fakeRooms({ result: "{not json" });
    const handle = await new RoomCursorRunner({ spawn: f.spawn }).run(roomsInput());
    await expect(handle.result).rejects.toBeInstanceOf(RoomArtifactError);
  });

  test("spawn error (binary missing) → result rejects", async () => {
    const f = fakeRooms({ spawnError: new Error("spawn rooms ENOENT") });
    const handle = await new RoomCursorRunner({ spawn: f.spawn }).run(roomsInput());
    await expect(handle.result).rejects.toThrow(/rooms subprocess failed/);
  });
});

describe("RoomCursorRunner — cancel + attach", () => {
  test("handle.cancel() kills the child and resolves cancelled", async () => {
    const f = fakeRooms({ autoClose: false, closeOnKill: true, result: successResult() });
    const handle = await new RoomCursorRunner({ spawn: f.spawn }).run(roomsInput());
    await handle.cancel();
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
  });

  test("pre-aborted signal resolves cancelled without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fakeRooms({ result: successResult() });
    const handle = await new RoomCursorRunner({ spawn: f.spawn }).run(
      roomsInput({ signal: controller.signal }),
    );
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
    expect(f.calls).toHaveLength(0);
  });

  test("attach rejects with RoomResumeNotSupportedError", async () => {
    const runner = new RoomCursorRunner({ spawn: fakeRooms().spawn });
    await expect(
      runner.attach({
        agentId: "room-x",
        model: { id: "composer-2.5" },
        onEvent: () => undefined,
        runId: "run-x",
      }),
    ).rejects.toBeInstanceOf(RoomResumeNotSupportedError);
  });
});

function argVal(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = saved;
}
