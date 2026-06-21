/**
 * Cursor-specific typed errors. The neutral taxonomy (`MissingApiKeyError`,
 * `AgentRunFailedError`) lives in `@ship/agent-runner`.
 */

import { AgentNotFoundError, AgentRunFailedError } from "@ship/agent-runner";

export { AgentRunFailedError, agentRunFailedError, MissingApiKeyError } from "@ship/agent-runner";

/** Cloud inputs passed to {@link CloudCursorRunner} without `cloud` config. */
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

export class CursorCloudIntegrationError extends AgentRunFailedError {
  override readonly name: string = "CursorCloudIntegrationError";

  constructor(
    public readonly provider: string,
    public readonly helpUrl: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Cloud agent integration not connected for provider "${provider}". Visit ${helpUrl} to connect.`,
      options,
    );
  }
}

export class WrongRunnerError extends AgentRunFailedError {
  override readonly name: string = "WrongRunnerError";
}

export class CursorAgentNotFoundError extends AgentNotFoundError {
  override readonly name: string = "CursorAgentNotFoundError";
  declare readonly agentId: string;
  declare readonly runId: string;
  readonly runtime: "local" | "cloud";

  constructor(args: {
    agentId: string;
    runId: string;
    runtime: "local" | "cloud";
    cause?: unknown;
  }) {
    super({
      agentId: args.agentId,
      cause: args.cause,
      message: `Cursor agent not found (agentId=${args.agentId}, runId=${args.runId}, runtime=${args.runtime})`,
      runId: args.runId,
    });
    this.runtime = args.runtime;
  }
}

export class LocalResumeNotSupportedError extends AgentRunFailedError {
  override readonly name: string = "LocalResumeNotSupportedError";
  readonly agentId: string;

  constructor(args: { agentId: string }) {
    super(`Local agent resume is not supported (agentId=${args.agentId})`);
    this.agentId = args.agentId;
  }
}

export class MissingRoomSpecError extends AgentRunFailedError {
  override readonly name: string = "MissingRoomSpecError";

  constructor() {
    super("runtime: 'rooms' was set but input.room is undefined");
  }
}

export class InvalidRoomReposError extends AgentRunFailedError {
  override readonly name: string = "InvalidRoomReposError";

  constructor(receivedLength: number) {
    super(
      `room.repos must contain exactly one repo entry; received length ${String(receivedLength)}`,
    );
  }
}

export class MissingRoomImageError extends AgentRunFailedError {
  override readonly name: string = "MissingRoomImageError";

  constructor() {
    super(
      "rooms requires a guest image: set room.image or construct RoomCursorRunner with a defaultImage",
    );
  }
}

export class RoomResumeNotSupportedError extends AgentRunFailedError {
  override readonly name: string = "RoomResumeNotSupportedError";
  readonly agentId: string;

  constructor(args: { agentId: string }) {
    super(`Rooms agent resume is not supported (agentId=${args.agentId})`);
    this.agentId = args.agentId;
  }
}

export class RoomArtifactError extends AgentRunFailedError {
  override readonly name: string = "RoomArtifactError";
}

export class RoomSchemaVersionError extends AgentRunFailedError {
  override readonly name: string = "RoomSchemaVersionError";
  readonly expected: number;
  readonly received: unknown;

  constructor(args: { expected: number; received: unknown }) {
    super(
      `rooms result.json schema_version mismatch: expected ${String(args.expected)}, received ${JSON.stringify(args.received)}`,
    );
    this.expected = args.expected;
    this.received = args.received;
  }
}
