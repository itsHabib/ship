/**
 * `@ship/driverstate-emitter` — the driver-state v0.1.0 WRITE contract in
 * TypeScript, so ship's engine can emit lifecycle events into the workbench
 * ledger (`<stateRoot>/<run_id>/events.jsonl`). Mechanism package only: no
 * engine wiring, no read/reduce (workbench owns reads).
 */

export type { Event } from "./canonical.js";
export { SCHEMA_VERSION, canonicalBytes, computeHash, encodeEvent } from "./canonical.js";

export type { AppendInput, AppendResult } from "./emitter.js";
export { appendEvent, formatTime, releaseRun } from "./emitter.js";

export { newEventId, newRunId } from "./id.js";

export { resolveStateRoot } from "./paths.js";
