import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { hasCodexAccountAuth } from "./codex-auth.js";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ship-codex-auth-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("hasCodexAccountAuth", () => {
  test("accepts a private profile file without consulting login status", () => {
    const root = newRoot();
    const codexHome = join(root, ".codex");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}");
    const loginStatus = vi.fn(() => false);
    expect(hasCodexAccountAuth({ CODEX_HOME: codexHome }, loginStatus)).toBe(true);
    expect(loginStatus).not.toHaveBeenCalled();
  });

  test("accepts keyring-backed login reported by the Codex CLI", () => {
    const loginStatus = vi.fn(() => true);
    expect(hasCodexAccountAuth({ CODEX_HOME: join(newRoot(), ".codex") }, loginStatus)).toBe(true);
    expect(loginStatus).toHaveBeenCalledOnce();
  });

  test("rejects a profile when neither file nor CLI login exists", () => {
    expect(hasCodexAccountAuth({ PATH: "" })).toBe(false);
  });
});
