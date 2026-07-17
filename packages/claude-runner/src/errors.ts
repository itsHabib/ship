/**
 * Claude-specific typed errors. The neutral taxonomy (`MissingApiKeyError`,
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
      `Claude Agent SDK has no bundled binary for platform ${platform}/${arch}; local Claude runs are unsupported on this host`,
    );
  }
}

/** Cloud inputs passed to {@link CloudClaudeRunner} without `cloud` config. */
export class MissingCloudSpecError extends AgentRunFailedError {
  override readonly name: string = "MissingCloudSpecError";

  constructor() {
    super("runtime: 'cloud' was set but input.cloud is undefined");
  }
}

export class InvalidCloudReposError extends AgentRunFailedError {
  override readonly name: string = "InvalidCloudReposError";

  constructor(receivedLength: number) {
    super(
      `cloud.repos must contain exactly one repo entry; received length ${String(receivedLength)}`,
    );
  }
}

/** Thrown when Managed Agents session setup fails (env/agent/session create). */
export class CloudSessionError extends AgentRunFailedError {
  override readonly name: string = "CloudSessionError";
}

/**
 * Repo `.ship.json` `credentials` constraint refused this dispatch — the pinned
 * token source is absent/empty or a forbidden env override is present. Fail-closed:
 * naming the offending source is the whole point, so the operator sees exactly why.
 */
export class CredentialSourcePolicyError extends AgentRunFailedError {
  override readonly name: string = "CredentialSourcePolicyError";
}
