import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultStateRoot, resolveStateRoot } from "./paths.js";

describe("resolveStateRoot", () => {
  const savedStateDir = process.env["WORKBENCH_STATE_DIR"];
  const savedVitest = process.env["VITEST"];

  beforeEach(() => {
    delete process.env["WORKBENCH_STATE_DIR"];
  });

  afterEach(() => {
    delete process.env["WORKBENCH_STATE_DIR"];
    delete process.env["VITEST"];
    if (savedStateDir !== undefined) {
      process.env["WORKBENCH_STATE_DIR"] = savedStateDir;
    }
    if (savedVitest !== undefined) {
      process.env["VITEST"] = savedVitest;
    }
  });

  it("prefers WORKBENCH_STATE_DIR when set", () => {
    process.env["WORKBENCH_STATE_DIR"] = "/tmp/some-state-root";
    expect(resolveStateRoot()).toBe("/tmp/some-state-root");
  });

  it("treats an empty WORKBENCH_STATE_DIR as unset", () => {
    process.env["WORKBENCH_STATE_DIR"] = "";
    delete process.env["VITEST"];
    expect(resolveStateRoot()).toBe(defaultStateRoot());
  });

  it("falls back to the default root outside vitest", () => {
    delete process.env["VITEST"];
    expect(resolveStateRoot()).toBe(join(homedir(), ".workbench", "driver-state"));
  });

  it("refuses the operator's real store under vitest with an unset override", () => {
    // The regression guard: this is precisely the state that let driver CLI
    // tests append 235 fixture runs to ~/.workbench/driver-state.
    process.env["VITEST"] = "true";
    expect(() => resolveStateRoot()).toThrow(/refusing to resolve the real store/);
    expect(() => resolveStateRoot()).toThrow(/setupFiles/);
  });
});
