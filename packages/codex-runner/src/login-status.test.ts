import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { codexLoginStatus, resolveBundledCodexExecutable } from "./login-status.js";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ship-codex-cli-"));
  roots.push(root);
  return root;
}

function installNativeFixture(platform: NodeJS.Platform, arch: NodeJS.Architecture): string {
  const root = newRoot();
  const triples = {
    "darwin/arm64": "aarch64-apple-darwin",
    "win32/x64": "x86_64-pc-windows-msvc",
  } as const;
  const triple = triples[`${platform}/${arch}` as keyof typeof triples];
  const packageRoot = join(root, "package");
  const nativeRoot = join(packageRoot, "vendor", triple);
  mkdirSync(join(nativeRoot, "bin"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), "{}");
  writeFileSync(join(nativeRoot, "codex-package.json"), "{}");
  const binary = join(nativeRoot, "bin", platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(binary, "binary", { mode: 0o700 });
  return join(packageRoot, "package.json");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("resolveBundledCodexExecutable", () => {
  test("resolves the native binary installed with the SDK", () => {
    const executable = resolveBundledCodexExecutable();
    expect(executable).toBeDefined();
    expect(executable).toMatch(process.platform === "win32" ? /codex\.exe$/ : /\/codex$/);
  });

  test("resolves the SDK-bundled native binary", () => {
    const packageJson = installNativeFixture("darwin", "arm64");
    expect(
      resolveBundledCodexExecutable({
        arch: "arm64",
        platform: "darwin",
        resolvePackageJson: () => packageJson,
      }),
    ).toBe(realpathSync(join(packageJson, "..", "vendor", "aarch64-apple-darwin", "bin", "codex")));
  });

  test("uses the native exe on Windows instead of relying on npm shims", () => {
    const packageJson = installNativeFixture("win32", "x64");
    expect(
      resolveBundledCodexExecutable({
        arch: "x64",
        platform: "win32",
        resolvePackageJson: () => packageJson,
      }),
    ).toMatch(/codex\.exe$/);
  });

  test("returns no binary for an unsupported platform", () => {
    expect(resolveBundledCodexExecutable({ platform: "aix" })).toBeUndefined();
  });

  test("returns no binary when the platform package cannot be resolved", () => {
    expect(
      resolveBundledCodexExecutable({
        resolvePackageJson: () => {
          throw new Error("missing optional dependency");
        },
      }),
    ).toBeUndefined();
  });
});

describe("codexLoginStatus", () => {
  test("runs an explicit absolute native CLI with the supplied environment", () => {
    const executable = join(newRoot(), "codex");
    writeFileSync(executable, "binary", { mode: 0o700 });
    const spawn = vi.fn(() => ({ status: 0 }) as never);
    const env = { CODEX_HOME: join(newRoot(), ".codex"), SHIP_CODEX_CLI: executable };
    expect(codexLoginStatus(env, spawn)).toBe(true);
    expect(spawn).toHaveBeenCalledWith(realpathSync(executable), ["login", "status"], {
      env,
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
  });

  test("reports a failed login-status exit", () => {
    const executable = join(newRoot(), "codex");
    writeFileSync(executable, "binary", { mode: 0o700 });
    const spawn = vi.fn(() => ({ status: 1 }) as never);
    expect(codexLoginStatus({ SHIP_CODEX_CLI: executable }, spawn)).toBe(false);
  });

  test("rejects a relative explicit override without spawning", () => {
    const spawn = vi.fn((_executable: string, _args: string[], _options: unknown) => {
      return { status: 0 } as never;
    });
    expect(codexLoginStatus({ SHIP_CODEX_CLI: "codex" }, spawn)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
