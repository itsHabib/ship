// MCP-flavored test helpers. Lives alongside the workflow/store
// harness so both unit-level (in-memory transport) and subprocess-
// level (stdio transport) tests share the same poll-to-terminal
// logic. Stays substrate-agnostic by taking a minimal structural
// `{ callTool }` client — no `@modelcontextprotocol/sdk` dep on
// `@ship/test-harness`.

import type { WorkflowRun } from "@ship/workflow";

import { isTerminal } from "@ship/workflow";

// Minimal structural shape of an MCP client. Both the SDK's
// in-process `Client` and a real `Client` over `StdioClientTransport`
// satisfy this — the helper doesn't need the rest of the surface.
export interface ToolCaller {
  callTool: (request: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
}

// Tuning knobs for `waitForTerminalRun`. Defaults match the in-process
// unit harness (200 × 10ms = 2s); the subprocess integration test
// passes a wider ceiling because the fake-cursor child can be slow on
// a busy CI box.
export interface WaitForTerminalRunOptions {
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 200;
const DEFAULT_INTERVAL_MS = 10;

// Polls `get_workflow_run` against an MCP client until the row hits a
// terminal status (`succeeded` | `failed` | `cancelled`) or the budget
// is exhausted. The V2 `ship` tool returns `{ status: "running" }`
// after persisting the row + initial phase, with the background
// continuation completing on a later tick — tests that need the
// finalized row wait here.
//
// On any error during a poll (e.g. the MCP tool returns `isError:
// true` and the caller's `parseToolJson` throws), the helper rethrows
// with the `workflowRunId` prefixed so the caller can correlate the
// failure with the run id without re-deriving context from the
// stack.
export async function waitForTerminalRun(
  client: ToolCaller,
  workflowRunId: string,
  opts: WaitForTerminalRunOptions = {},
): Promise<WorkflowRun> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let run: WorkflowRun;
    try {
      const raw = await client.callTool({
        name: "get_workflow_run",
        arguments: { workflowRunId },
      });
      run = parseWorkflowRunResult(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`waitForTerminalRun(${workflowRunId}): poll failed — ${message}`);
    }
    if (isTerminal(run.status)) {
      return run;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error(
    `waitForTerminalRun(${workflowRunId}): timed out after ${String(maxAttempts)} attempts × ${String(intervalMs)}ms`,
  );
}

// Local copy of the JSON-content-block parser used by every V1/V2 MCP
// tool. Kept inline so the test-harness doesn't have to take on the
// full `parseToolJson` surface as exported API — the per-package
// `parseToolJson` helpers in `mcp-server/test/` and `e2e/integration/`
// stay as the canonical generic version.
function parseWorkflowRunResult(result: unknown): WorkflowRun {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const block = r.content?.[0];
  if (block?.type !== "text" || typeof block.text !== "string") {
    throw new Error(`unexpected tool response shape: ${JSON.stringify(result)}`);
  }
  if (r.isError === true) {
    throw new Error(`tool returned isError: ${block.text}`);
  }
  return JSON.parse(block.text) as WorkflowRun;
}
