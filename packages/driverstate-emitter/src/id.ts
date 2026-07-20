/** ID factories: `<prefix>_<ulid>`, mirroring workbench's driver-state ID shape. */

import { ulid } from "ulid";

/** Returns a new client-minted event idempotency key, `evt_<ulid>`. */
export function newEventId(): string {
  return `evt_${ulid()}`;
}

/** Returns a new driver-state run id, `dsr_<ulid>`. */
export function newRunId(): string {
  return `dsr_${ulid()}`;
}
