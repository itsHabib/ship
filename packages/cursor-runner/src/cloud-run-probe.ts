/**
 * Bounded REST probe of a Cursor cloud run for server-stamped age fields.
 */

import type { AgentRunProbeResult } from "@ship/agent-runner";

const API_KEY_ENV = "CURSOR_API_KEY";
const DEFAULT_API_BASE = "https://api.cursor.com";

interface V1RunResponse {
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function buildProbeResult(body: V1RunResponse): AgentRunProbeResult | undefined {
  const createdAtMs = parseIsoMs(body.createdAt);
  const updatedAtMs = parseIsoMs(body.updatedAt);
  if (createdAtMs === undefined && updatedAtMs === undefined && body.status === undefined) {
    return undefined;
  }
  return {
    ...(body.status !== undefined && { status: body.status }),
    ...(createdAtMs !== undefined && { createdAtMs }),
    ...(updatedAtMs !== undefined && { updatedAtMs }),
  };
}

/** Probe a cloud run via the agents REST surface; undefined on failure/timeout. */
export async function probeCursorCloudRun(args: {
  readonly agentId: string;
  readonly runId: string;
  readonly timeoutMs: number;
}): Promise<AgentRunProbeResult | undefined> {
  const apiKey = process.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") return undefined;

  const baseUrl = process.env["CURSOR_API_BASE_URL"] ?? DEFAULT_API_BASE;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, args.timeoutMs);
  try {
    const url = `${baseUrl}/v0/agents/${encodeURIComponent(args.agentId)}/runs/${encodeURIComponent(args.runId)}`;
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!resp.ok) return undefined;
    const body = (await resp.json()) as V1RunResponse;
    return buildProbeResult(body);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
