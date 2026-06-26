/**
 * Codex-specific typed errors. The neutral taxonomy (`MissingApiKeyError`,
 * `AgentRunFailedError`) lives in `@ship/agent-runner`.
 */

import { AgentRunFailedError } from "@ship/agent-runner";

export { AgentRunFailedError, agentRunFailedError, MissingApiKeyError } from "@ship/agent-runner";

export class WrongRunnerError extends AgentRunFailedError {
  override readonly name: string = "WrongRunnerError";
}

export class OperationNotSupportedError extends AgentRunFailedError {
  override readonly name: string = "OperationNotSupportedError";
}

export class UnsupportedPlatformError extends AgentRunFailedError {
  override readonly name: string = "UnsupportedPlatformError";

  constructor(platform: string, arch: string) {
    super(
      `Codex CLI has no bundled binary for platform ${platform}/${arch}; local Codex runs are unsupported on this host`,
    );
  }
}
