import type { Logger } from "@ship/logger";

// Debug telemetry for cloud runs, emitted via the injected Logger (stderr by
// default). Gated strictly on SHIP_CLOUD_DEBUG=1 — that flag is the access
// control, so once past it we emit at `info` rather than `debug`: the flag is
// the gate, not the log level, so `SHIP_CLOUD_DEBUG=1` alone is sufficient to
// surface these diagnostics at the default level.

export function cloudDebugLog(log: Logger | undefined, label: string, payload: unknown): void {
  if (process.env["SHIP_CLOUD_DEBUG"] !== "1" || log === undefined) return;
  // Defensive: JSON.stringify throws on circular refs / BigInt. This is
  // diagnostics — a crash here is the worst possible outcome. Fall back
  // to String() so the run continues.
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = String(payload);
  }
  log.info({ label, payload: serialized }, label);
}
