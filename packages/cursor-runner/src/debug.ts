// stderr-only debug telemetry for cloud runs — gated strictly on SHIP_CLOUD_DEBUG=1.

export function cloudDebugLog(label: string, payload: unknown): void {
  if (process.env["SHIP_CLOUD_DEBUG"] !== "1") return;
  process.stderr.write(`[ship-cloud-debug] ${label}: ${JSON.stringify(payload)}\n`);
}
