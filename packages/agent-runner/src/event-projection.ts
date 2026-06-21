/**
 * Provider-neutral event projection seam. Each runner supplies an
 * implementation that normalizes raw provider spellings into the
 * canonical vocabularies below.
 */

/** Opaque streamed event — structure is read only via `EventProjection`. */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- intentional named public event type (spec §6); the structure is deliberately opaque and read only through EventProjection
export type AgentEvent = unknown;

/** Normalized tool-call lifecycle status (provider spellings never leak past projection). */
export type ToolCallStatus = "running" | "completed" | "error" | "failed";

export interface EventProjection<E = AgentEvent> {
  /** Event discriminator, e.g. `"tool_call"` or `"status"`. */
  eventKind(event: E): string | undefined;
  /** Stable tool-call id for reconciliation (`call_id` on cursor). */
  toolCallId(event: E): string | undefined;
  /** Normalized tool-call status; `undefined` when not a tool_call event. */
  toolCallStatus(event: E): ToolCallStatus | undefined;
  toolCallName(event: E): string | undefined;
  /** Shell/command argument extracted from tool args when present. */
  commandArg(event: E): string | undefined;
  /** Epoch ms from event timestamp fields (`ts`, `startedAt`, …). */
  timestamp(event: E): number | undefined;
  /** Free-text status message on terminal status events. */
  statusMessage(event: E): string | undefined;
  /** Tool-call result payload as text. */
  resultText(event: E): string | undefined;
  /** Terminal run status on status events; `undefined` on non-terminal events. */
  terminalStatus(event: E): string | undefined;
}
