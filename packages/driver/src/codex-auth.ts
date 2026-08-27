import type { CodexLoginStatus } from "@ship/codex-runner";

import { codexLoginStatus } from "@ship/codex-runner";

export type { CodexLoginStatus } from "@ship/codex-runner";

/** Detect account auth through the Codex CLI's authoritative active store. */
export function hasCodexAccountAuth(
  env: Record<string, string | undefined>,
  loginStatus: CodexLoginStatus = codexLoginStatus,
): boolean {
  return loginStatus(env);
}
