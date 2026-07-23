/** Tests for `spend-log.ts` — the append-only review-spend telemetry. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  appendSpendEvent,
  ownerNameFromRepoUrl,
  resolveSpendLogPath,
  type TerminalSpendEvent,
} from "./spend-log.js";

const terminal = (over: Partial<TerminalSpendEvent> = {}): TerminalSpendEvent => ({
  ts: "2026-07-23T00:00:00.000Z",
  event: "terminal",
  repo: "itsHabib/ship",
  pr: 233,
  tier: "T2",
  tier_source: "classified",
  cycles_used: 1,
  merged: true,
  ...over,
});

describe("appendSpendEvent", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ship-spend-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  test("appends one JSONL line that round-trips the terminal event", () => {
    const path = join(dir, "review-spend.jsonl");
    appendSpendEvent(terminal(), { path });
    appendSpendEvent(terminal({ pr: 234, tier: "T1" }), { path });

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(terminal());
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ pr: 234, tier: "T1", event: "terminal" });
  });

  test("creates the parent directory when missing", () => {
    const path = join(dir, "nested", "deeper", "review-spend.jsonl");
    appendSpendEvent(terminal(), { path });
    expect(readFileSync(path, "utf-8")).toContain('"event":"terminal"');
  });

  test("omits tier when the head was not classified (classifier_error)", () => {
    const path = join(dir, "review-spend.jsonl");
    const ev = terminal({ tier: undefined, tier_source: "classifier_error" });
    delete (ev as { tier?: unknown }).tier;
    appendSpendEvent(ev, { path });
    const parsed = JSON.parse(readFileSync(path, "utf-8").trim()) as Partial<TerminalSpendEvent>;
    expect(parsed.tier).toBeUndefined();
    expect(parsed.tier_source).toBe("classifier_error");
  });

  test("a write failure warns and does not throw (best-effort)", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as NonNullable<
      Parameters<typeof appendSpendEvent>[1]
    >["logger"];
    // Parent is a FILE, not a directory — mkdir/append must fail.
    const filePath = join(dir, "review-spend.jsonl");
    appendSpendEvent(terminal(), { path: filePath });
    const bad = join(filePath, "child", "review-spend.jsonl");
    expect(() => {
      appendSpendEvent(terminal(), { path: bad, logger });
    }).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("resolveSpendLogPath", () => {
  const saved = process.env["SHIP_DB_PATH"];

  afterEach(() => {
    if (saved === undefined) delete process.env["SHIP_DB_PATH"];
    else process.env["SHIP_DB_PATH"] = saved;
  });

  test("places the log beside SHIP_DB_PATH when set", () => {
    process.env["SHIP_DB_PATH"] = join("srv", "state", "state.db");
    expect(resolveSpendLogPath()).toBe(join("srv", "state", "review-spend.jsonl"));
  });

  test("falls back to <userConfigDir>/ship when SHIP_DB_PATH is unset", () => {
    delete process.env["SHIP_DB_PATH"];
    expect(resolveSpendLogPath().endsWith(join("ship", "review-spend.jsonl"))).toBe(true);
  });
});

describe("ownerNameFromRepoUrl", () => {
  test("parses owner/name from an https GitHub URL", () => {
    expect(ownerNameFromRepoUrl("https://github.com/itsHabib/ship")).toBe("itsHabib/ship");
    expect(ownerNameFromRepoUrl("https://github.com/itsHabib/ship.git")).toBe("itsHabib/ship");
  });

  test("returns undefined for an unparseable URL", () => {
    expect(ownerNameFromRepoUrl("not-a-url")).toBeUndefined();
  });
});
