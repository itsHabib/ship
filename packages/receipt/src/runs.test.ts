import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  loadShipRunReceipts,
  plausibleDispatch,
  resolveDefaultReceiptsPath,
  resolveDefaultRunsDir,
  runResultToReceipt,
} from "./runs.js";

describe("runResultToReceipt", () => {
  it("maps a succeeded run to an execution receipt", () => {
    const receipt = runResultToReceipt({
      runId: "wf_1",
      result: { status: "succeeded", durationMs: 212650.7, model: { id: "composer-2" } },
      dispatchedAt: "2026-05-10T18:47:00.000Z",
      terminalAt: "2026-05-10T18:51:00.000Z",
    });
    expect(receipt?.source).toBe("ship-run");
    expect(receipt?.outcome).toBe("succeeded");
    expect(receipt?.run_id).toBe("wf_1");
    expect(receipt?.duration_ms).toBe(212651);
    expect(receipt?.model).toBe("composer-2");
    expect(receipt?.cost_tokens).toBeNull();
    expect(receipt?.terminal_at).toBe("2026-05-10T18:51:00.000Z");
  });

  it("maps usage.totalTokens to cost_tokens when present", () => {
    const receipt = runResultToReceipt({
      runId: "wf_usage",
      result: {
        status: "succeeded",
        durationMs: 1000,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      },
      dispatchedAt: undefined,
      terminalAt: undefined,
    });
    expect(receipt?.cost_tokens).toBe(150);
  });

  it("leaves cost_tokens null when result.json has no usage", () => {
    const receipt = runResultToReceipt({
      runId: "wf_no_usage",
      result: { status: "succeeded", durationMs: 1000 },
      dispatchedAt: undefined,
      terminalAt: undefined,
    });
    expect(receipt?.cost_tokens).toBeNull();
  });

  it("maps failed and cancelled terminal statuses", () => {
    expect(
      runResultToReceipt({
        runId: "a",
        result: { status: "failed" },
        dispatchedAt: undefined,
        terminalAt: undefined,
      })?.outcome,
    ).toBe("failed");
    expect(
      runResultToReceipt({
        runId: "b",
        result: { status: "cancelled" },
        dispatchedAt: undefined,
        terminalAt: undefined,
      })?.outcome,
    ).toBe("cancelled");
  });

  it("treats an unrecognized status as unknown", () => {
    const receipt = runResultToReceipt({
      runId: "c",
      result: { status: "running" },
      dispatchedAt: undefined,
      terminalAt: undefined,
    });
    expect(receipt?.outcome).toBe("unknown");
  });

  it("extracts pr_url + pr_number from the first branch with a prUrl", () => {
    const receipt = runResultToReceipt({
      runId: "d",
      result: {
        status: "succeeded",
        branches: [{}, { prUrl: "https://github.com/itsHabib/ship/pull/108" }],
      },
      dispatchedAt: undefined,
      terminalAt: undefined,
    });
    expect(receipt?.pr_url).toBe("https://github.com/itsHabib/ship/pull/108");
    expect(receipt?.pr_number).toBe(108);
  });

  it("returns null for an unparseable result", () => {
    expect(
      runResultToReceipt({
        runId: "e",
        result: "not-an-object",
        dispatchedAt: undefined,
        terminalAt: undefined,
      }),
    ).toBeNull();
  });

  it("returns null instead of throwing when the receipt fails validation", () => {
    // empty runId fails the schema's non-empty key — isolate it, never abort the load
    expect(
      runResultToReceipt({
        runId: "",
        result: { status: "succeeded" },
        dispatchedAt: undefined,
        terminalAt: undefined,
      }),
    ).toBeNull();
  });

  it("ignores a non-positive PR number parsed from a URL", () => {
    const receipt = runResultToReceipt({
      runId: "z",
      result: { status: "succeeded", branches: [{ prUrl: "https://github.com/o/r/pull/0" }] },
      dispatchedAt: undefined,
      terminalAt: undefined,
    });
    expect(receipt?.pr_number).toBeUndefined();
    expect(receipt?.pr_url).toBe("https://github.com/o/r/pull/0");
  });
});

describe("plausibleDispatch", () => {
  it("drops a degenerate pre-2000 (epoch) birthtime", () => {
    expect(plausibleDispatch("1970-01-01T00:00:00.000Z")).toBeUndefined();
  });

  it("keeps a plausible modern timestamp", () => {
    expect(plausibleDispatch("2026-06-08T04:00:00.000Z")).toBe("2026-06-08T04:00:00.000Z");
  });

  it("passes undefined through", () => {
    expect(plausibleDispatch(undefined)).toBeUndefined();
  });
});

describe("resolveDefaultRunsDir", () => {
  it("honors the SHIP_RUNS_DIR override", () => {
    expect(resolveDefaultRunsDir({ SHIP_RUNS_DIR: "/custom/runs" }, "linux", "/home/u")).toBe(
      "/custom/runs",
    );
  });

  it("ignores a relative SHIP_RUNS_DIR and uses the platform default", () => {
    expect(resolveDefaultRunsDir({ SHIP_RUNS_DIR: "rel/runs" }, "linux", "/home/u")).toBe(
      join("/home/u", ".config", "ship", "runs"),
    );
  });

  it("uses XDG_CONFIG_HOME when set", () => {
    expect(resolveDefaultRunsDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/u")).toBe(
      join("/xdg", "ship", "runs"),
    );
  });

  it("uses APPDATA on win32", () => {
    expect(
      resolveDefaultRunsDir({ APPDATA: "C:\\AppData\\Roaming" }, "win32", "C:\\Users\\u"),
    ).toBe(join("C:\\AppData\\Roaming", "ship", "runs"));
  });

  it("falls back to ~/AppData/Roaming on win32 without APPDATA", () => {
    expect(resolveDefaultRunsDir({}, "win32", "C:\\Users\\u")).toBe(
      join("C:\\Users\\u", "AppData", "Roaming", "ship", "runs"),
    );
  });

  it("ignores a relative XDG_CONFIG_HOME and uses the platform default", () => {
    expect(resolveDefaultRunsDir({ XDG_CONFIG_HOME: "rel/dir" }, "linux", "/home/u")).toBe(
      join("/home/u", ".config", "ship", "runs"),
    );
  });

  it("falls back to ~/.config on posix", () => {
    expect(resolveDefaultRunsDir({}, "darwin", "/home/u")).toBe(
      join("/home/u", ".config", "ship", "runs"),
    );
  });
});

describe("resolveDefaultReceiptsPath", () => {
  it("honors the SHIP_RECEIPTS_PATH override", () => {
    expect(
      resolveDefaultReceiptsPath(
        { SHIP_RECEIPTS_PATH: "/custom/receipts.jsonl" },
        "linux",
        "/home/u",
      ),
    ).toBe("/custom/receipts.jsonl");
  });

  it("uses APPDATA on win32", () => {
    expect(
      resolveDefaultReceiptsPath({ APPDATA: "C:\\AppData\\Roaming" }, "win32", "C:\\Users\\u"),
    ).toBe(join("C:\\AppData\\Roaming", "ship", "receipts.jsonl"));
  });

  it("falls back to ~/.config on posix", () => {
    expect(resolveDefaultReceiptsPath({}, "linux", "/home/u")).toBe(
      join("/home/u", ".config", "ship", "receipts.jsonl"),
    );
  });
});

describe("loadShipRunReceipts", () => {
  const root = mkdtempSync(join(tmpdir(), "ship-receipt-runs-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads every run dir with a valid result.json and skips the rest", () => {
    mkdirSync(join(root, "wf_ok"));
    writeFileSync(
      join(root, "wf_ok", "result.json"),
      JSON.stringify({ status: "succeeded", durationMs: 1000 }),
    );
    mkdirSync(join(root, "wf_noresult"));
    mkdirSync(join(root, "wf_bad"));
    writeFileSync(join(root, "wf_bad", "result.json"), "{ not json");

    const receipts = loadShipRunReceipts(root);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.run_id).toBe("wf_ok");
    expect(receipts[0]?.terminal_at).toBeTypeOf("string");
  });

  it("returns [] for a missing runs dir", () => {
    expect(loadShipRunReceipts(join(root, "does-not-exist"))).toEqual([]);
  });
});
