# `@ship/mcp`

## What this package owns

Zod wire schemas for Ship's MCP tool boundary — the contract between `@ship/mcp-server` and MCP clients. No server logic, no I/O. Validates tool inputs at the MCP edge; types are consumed by `@ship/mcp-server` and re-exported through `@ship/core` so CLI callers need not depend on both packages for typing alone.

## Public surface

**Ship tool**

- `shipInputSchema` / **`ShipInput`** — workdir, docPath, repo, branch, runtime, cloud spec, model.
- `shipStartOutputSchema` / **`ShipStartOutput`** — async kickoff `{ workflowRunId, status: "running" }`.
- `shipOutputSchema` / **`ShipOutput`** — terminal run summary (status, artifacts, error chain).
- `cloudRunSpecSchema` — Zod twin of `@ship/cursor-runner`'s `CloudRunSpec` type.

**Inspect / control tools**

- `getWorkflowRunInputSchema` / `getWorkflowRunOutputSchema`
- `listWorkflowRunsInputSchema` / `listWorkflowRunsOutputSchema`
- `cancelWorkflowRunInputSchema` / `cancelWorkflowRunOutputSchema`

**Artifacts**

- `shipArtifactsSchema` / `ShipArtifacts` — paths to `events.ndjson`, `result.json`, rendered prompt.

Nested domain schemas (`workflowRunSchema`, terminal status enums, **`cursorRunRuntimeSchema`**) live in `@ship/workflow` and are composed into the MCP schemas here.

## How it composes

Depends on `@ship/workflow` for domain shapes. Consumed by `@ship/mcp-server` (tool handlers parse with these schemas) and indirectly by `@ship/cli` via `@ship/core` re-exports. Keeps MCP wire format separate from SQLite domain types so either can evolve independently within Zod's parse boundary.

## When to swap it

Replace or extend this package when adding MCP tools or changing wire shapes — e.g. a V2 review-cycle tool gets a new schema file here, server registers it, core gains a matching method. Swapping persistence or the cursor runner does not touch MCP schemas unless the tool contract changes.

## Develop / test

```bash
pnpm --filter @ship/mcp test
```

Property tests in `src/mcp.properties.test.ts` round-trip wire payloads. No runtime configuration.
