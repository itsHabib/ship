// stderr-only debug telemetry for cloud runs — gated strictly on SHIP_CLOUD_DEBUG=1.

export function cloudDebugLog(label: string, payload: unknown): void {
  if (process.env["SHIP_CLOUD_DEBUG"] !== "1") return;
  // Defensive: JSON.stringify throws on circular refs / BigInt. This is
  // diagnostics — a crash here is the worst possible outcome. Fall back
  // to String() so the run continues.
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = String(payload);
  }
  process.stderr.write(`[ship-cloud-debug] ${label}: ${serialized}\n`);
}
