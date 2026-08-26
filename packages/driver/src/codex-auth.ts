import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type CodexLoginStatus = (env: Record<string, string | undefined>) => boolean;

function codexHomeFromEnv(env: Record<string, string | undefined>): string | undefined {
  const configured = env["CODEX_HOME"]?.trim();
  if (configured) return configured;
  const home = [env["HOME"]?.trim(), env["USERPROFILE"]?.trim()].find(
    (candidate) => candidate !== undefined && candidate !== "",
  );
  return home === undefined ? undefined : join(home, ".codex");
}

function authFileExists(env: Record<string, string | undefined>): boolean {
  const codexHome = codexHomeFromEnv(env);
  if (codexHome === undefined) return false;
  try {
    return statSync(join(codexHome, "auth.json")).isFile();
  } catch {
    return false;
  }
}

function resolveCodexExecutable(env: Record<string, string | undefined>): string | undefined {
  const configured = env["SHIP_CODEX_CLI"]?.trim();
  const candidates = configured
    ? [configured]
    : (env["PATH"] ?? "")
        .split(delimiter)
        .filter((dir) => dir !== "")
        .flatMap((dir) => [join(dir, "codex"), join(dir, "codex.exe")]);
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const executable = realpathSync(candidate);
      if (!statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      // Keep looking through the fixed candidate list.
    }
  }
  return undefined;
}

function runCodexLoginStatus(env: Record<string, string | undefined>): boolean {
  const executable = resolveCodexExecutable(env);
  if (executable === undefined) return false;
  const result = spawnSync(executable, ["login", "status"], {
    env,
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
  return result.status === 0;
}

/** Detect file- or keyring-backed account auth through the Codex CLI contract. */
export function hasCodexAccountAuth(
  env: Record<string, string | undefined>,
  loginStatus: CodexLoginStatus = runCodexLoginStatus,
): boolean {
  if (authFileExists(env)) return true;
  return loginStatus(env);
}
