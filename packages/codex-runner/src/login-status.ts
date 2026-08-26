import type { SpawnSyncReturns } from "node:child_process";

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CodexLoginStatus = (env: Record<string, string | undefined>) => boolean;

interface NativeTarget {
  readonly packageName: string;
  readonly triple: string;
}

interface NativeResolutionOptions {
  readonly arch?: NodeJS.Architecture;
  readonly platform?: NodeJS.Platform;
  readonly resolvePackageJson?: (packageName: string) => string;
}

type SpawnLoginStatus = (
  executable: string,
  args: string[],
  options: {
    env: Record<string, string | undefined>;
    stdio: "ignore";
    timeout: number;
    windowsHide: boolean;
  },
) => SpawnSyncReturns<Buffer>;

function nativeTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): NativeTarget | undefined {
  const key = `${platform}/${arch}`;
  const targets: Readonly<Record<string, NativeTarget>> = {
    "android/arm64": {
      packageName: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
    },
    "android/x64": {
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
    },
    "darwin/arm64": {
      packageName: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin",
    },
    "darwin/x64": {
      packageName: "@openai/codex-darwin-x64",
      triple: "x86_64-apple-darwin",
    },
    "linux/arm64": {
      packageName: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
    },
    "linux/x64": {
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
    },
    "win32/arm64": {
      packageName: "@openai/codex-win32-arm64",
      triple: "aarch64-pc-windows-msvc",
    },
    "win32/x64": {
      packageName: "@openai/codex-win32-x64",
      triple: "x86_64-pc-windows-msvc",
    },
  };
  return targets[key];
}

function defaultPackageJsonResolver(packageName: string): string {
  const sdkPackageJson = findSdkPackageJson(dirname(fileURLToPath(import.meta.url)));
  if (sdkPackageJson === undefined) throw new Error("@openai/codex-sdk is not installed");
  const sdkRequire = createRequire(sdkPackageJson);
  const codexPackageJson = sdkRequire.resolve("@openai/codex/package.json");
  return createRequire(codexPackageJson).resolve(`${packageName}/package.json`);
}

function findSdkPackageJson(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = join(dir, "node_modules", "@openai", "codex-sdk", "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function validExecutable(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  try {
    const executable = realpathSync(path);
    if (!statSync(executable).isFile()) return undefined;
    accessSync(executable, constants.X_OK);
    return executable;
  } catch {
    return undefined;
  }
}

/** Resolve the same native Codex binary shipped with `@openai/codex-sdk`. */
export function resolveBundledCodexExecutable(
  options: NativeResolutionOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const target = nativeTarget(platform, options.arch ?? process.arch);
  if (target === undefined) return undefined;
  try {
    const resolvePackageJson = options.resolvePackageJson ?? defaultPackageJsonResolver;
    const packageJson = resolvePackageJson(target.packageName);
    const binaryName = platform === "win32" ? "codex.exe" : "codex";
    const root = join(dirname(packageJson), "vendor", target.triple);
    if (!statSync(join(root, "codex-package.json")).isFile()) return undefined;
    return validExecutable(join(root, "bin", binaryName));
  } catch {
    return undefined;
  }
}

function resolveCodexExecutable(env: Record<string, string | undefined>): string | undefined {
  const configured = env["SHIP_CODEX_CLI"]?.trim();
  if (configured !== undefined && configured !== "") return validExecutable(configured);
  return resolveBundledCodexExecutable();
}

/** Ask the configured or SDK-bundled native Codex CLI for its auth status. */
export function codexLoginStatus(
  env: Record<string, string | undefined>,
  spawn: SpawnLoginStatus = spawnSync,
): boolean {
  const executable = resolveCodexExecutable(env);
  if (executable === undefined) return false;
  const result = spawn(executable, ["login", "status"], {
    env,
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
  return result.status === 0;
}
