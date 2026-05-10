# Phase 8 — `packages/mcp-server`

Status: design draft, revision 0 (2026-05-10). Awaiting review before implementation.
Owner: itsHabib
Date: 2026-05-10

> **Companion docs.** [spec.md](../spec.md) is the V1 design spec; § "Component responsibilities" pins what `mcp-server` owns. [phases/06-core.md](06-core.md) shipped the `ShipService` interface this phase consumes. [phases/07-cli.md](07-cli.md) is the sister consumer — every architectural choice here mirrors a CLI choice (lazy service factory, error-mapping, fake-runner-backed tests). The PR sizing rule + dep-boundary preference in [CLAUDE.md](../../../../CLAUDE.md) governs the budget below.

## Scope

**Weighted-LOC budget:** ~250 src + ~280 tests = **390 weighted LOC** total — comfortably inside the < 500 amazing band, so **lands as a single PR**. No split.

| Sub-PR | Source | Tests | Weighted | Boundary |
|---|---|---|---|---|
| **8** binary + four tool handlers + one resource + smoke tests | ~250 | ~280 | ~390 | thin wrapper over `ShipService`; the binary owns no domain logic |

## Summary

`@ship/mcp-server` is the stdio MCP server that exposes the four V1 tools (`ship`, `get_workflow_run`, `list_workflow_runs`, `cancel_workflow_run`) and one resource (`ship://runs/{id}`) over the same `ShipService` instance the CLI uses (Phase 7). The handlers are thin: validate input with the `@ship/mcp` schemas (already shipped in Phase 2), call the matching service method, format the response with the same schemas. No domain logic. No state of its own.

This phase exists for two reasons:

1. **A driver agent (Cursor, Claude Code, future cloud orchestrators) needs a programmatic surface that isn't argv.** The CLI from Phase 7 is the human interface; the MCP server is the agent interface. Both share `ShipService` so the contract stays single-sourced.
2. **The MCP boundary already has its schemas.** Phase 2's `@ship/mcp` defined the four tool input/output schemas and Phase 6 extended them with `workdir` / `branch`. This phase wires those schemas to the actual MCP TS SDK request/response plumbing. Building the boundary first means the server is just plumbing.

## Functional requirements

### F1 — `ship` tool

Maps to `ShipService.ship(input)`. Per spec.md § F1.

- Input schema: `@ship/mcp`'s `shipInputSchema` (already exists). The MCP SDK validates request payloads against it before the handler runs.
- Output schema: `shipOutputSchema`. The handler validates the service's return value against it before serializing.
- The handler blocks until the run reaches a terminal state. V1 streaming responses are out of scope (see spec.md § "F1").

### F2 — `get_workflow_run` tool

Maps to `ShipService.getRun(id)`.

- Input: `getWorkflowRunInputSchema` (`{ workflowRunId }`).
- Output: `getWorkflowRunOutputSchema` — the hydrated `WorkflowRun` shape.
- `null` from the service (unknown id) → MCP error response with code `-32602` ("invalid params") and a `not found: <id>` message. Not a `null` payload — MCP clients shouldn't have to disambiguate.

### F3 — `list_workflow_runs` tool

Maps to `ShipService.listRuns(filter)`.

- Input: `listWorkflowRunsInputSchema` (`{ repo?, status?, limit? }`).
- Output: `listWorkflowRunsOutputSchema` — `{ runs: [...] }`.

### F4 — `cancel_workflow_run` tool

Maps to `ShipService.cancelRun(id)`.

- Input: `cancelWorkflowRunInputSchema`.
- Output: `cancelWorkflowRunOutputSchema` (`{ workflowRunId, status }`).
- Idempotent in the service; the server just relays.
- Unknown id surfaces as the same `-32602` "not found" error as F2.

### F5 — `ship://runs/{id}` resource

Single resource for fetching a run's hydrated state by id. Maps to the same `ShipService.getRun(id)` call as F2.

- URI template: `ship://runs/{id}`.
- Body: JSON of `getWorkflowRunOutputSchema` shape.
- Mime type: `application/json`.
- Unknown id surfaces as a resource-not-found error.

The resource shape lets clients embed run state directly into LLM context without a tool call round-trip; a tool call still works for clients that prefer that.

### F6 — Service wiring at startup

The binary entrypoint constructs exactly one `ShipService` per server lifetime, identical wiring to the CLI (`createNodeShipFs` + `LocalCursorRunner` + `createStore` glued by `createShipService`). `<UserConfigDir>/ship/` resolution is reused — see [phases/07-cli.md § ED-2](07-cli.md). The CLI's `createCliService(opts)` factory is the natural shape; both packages export an internal `createServerService(opts)` (or share via a sibling helper module).

The server reads `process.env["CURSOR_API_KEY"]` at startup and fails loud with a clear error message + non-zero exit when missing — same pre-flight as Phase 7's Risks-section recommendation.

### F7 — Tests via fake-runner-backed service

Smoke tests construct an MCP server with `FakeCursorRunner` injected (via `createServerService(opts).cursorOverride`, mirroring the CLI's pattern), connect via a JSON-RPC pair over an in-memory transport (the MCP SDK exposes `InMemoryTransport`), and assert the server responds correctly to each tool call + the resource read. No real Cursor SDK calls; no real network.

L3 integration tests under `e2e/integration/` exercise the binary as a child process (subprocess + real disk + fake cursor) — same pattern as CLI's Phase 7 integration suite.

## Non-functional requirements

- **No imports of `cli`.** Both `cli` and `mcp-server` consume `core` directly.
- **No direct `@cursor/sdk` import.** Only via `@ship/cursor-runner`'s `LocalCursorRunner`.
- **Single source of truth for tool schemas.** Already shipped via `@ship/mcp` (Phase 2); this phase imports them, never re-derives.
- **Strict TS + lint matching the rest of the repo.**
- **Coverage threshold:** 80% statements / 75% branches (matches `@ship/cli`'s glue band — most of the server is request/response plumbing).
- **Calibrated comment style.** Per `chore/comment-slim` (PR #6).
- **Protocol fidelity.** Validate every output against its `@ship/mcp` schema before sending so internal drift doesn't leak to clients (matches the Phase 2 contract: every tool ships an input *and* an output schema).

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| MCP SDK | `@modelcontextprotocol/sdk@^1.0.0` (TypeScript) | hand-rolled JSON-RPC | The official SDK handles transport, framing, capability declaration, and error codes correctly. Hand-rolling forecloses SSE/HTTP later. |
| Transport | stdio only | stdio + SSE | Spec.md § ED-6 (or thereabouts) pins V1 to stdio. SSE is V2. The SDK supports both behind the same `Server` class. |
| Tool registration | One file per tool under `src/tools/` | One large `bin.ts` | Mirrors Phase 7's per-subcommand layout. Each tool's request/response/error mapping fits in one screen; tests are local. |
| Resource registration | One file: `src/resources/runs.ts` | Same as tools | Only one resource in V1. Folding into a single file keeps the surface tight. |
| Error mapping | Custom `mapErrorToJsonRpcError(err)` in `src/errors.ts` | Let MCP SDK auto-map | The SDK auto-maps everything to `-32603` (internal error). Our service throws typed errors (`WorkdirNotFoundError`, `WorkflowRunNotFoundError`, etc.) that map naturally to `-32602` (invalid params). Custom mapping preserves caller-facing meaning. |
| Service wiring | Reuse `createCliService(opts)` from `@ship/cli` | Each binary builds its own | DRY, but couples cli and mcp-server. Better: factor the wiring into a shared `@ship/core` helper (`createDefaultServiceFromConfig`) that both consume. See ED-1. |
| Smoke-test transport | `InMemoryTransport` from the SDK | Spawn a subprocess + pipe stdio | In-memory is faster, deterministic, and exercises the same handler dispatch path. Subprocess tests live in `e2e/integration/` for cross-process fidelity. |
| Default model handling | Hard-coded `composer-2` (matches CLI) | Read from `SHIP_MODEL` env | Spec.md pins composer-2. Env override lands in V2 consistently for both binaries. |
| Output validation | `.parse()` on every tool's output schema before send | Trust the service | Defense-in-depth. The schemas are already imported; one extra `.parse()` per response is free and catches service drift before it reaches a client. |

## Engineering decisions

### ED-1 — Service-wiring helper hoisted into `@ship/core`

Phase 7 added `createCliService(opts: CliPathOpts): ServiceFactory` in `@ship/cli/src/service.ts`. Phase 8 needs the same wiring (LocalCursorRunner + createNodeShipFs + createStore + path resolution). Rather than duplicate or import-from-cli (which inverts the dep direction), this phase **moves the wiring helper to `@ship/core`** as `createDefaultShipService(opts)`. Both `cli` and `mcp-server` consume it.

```ts
// packages/core/src/default-wiring.ts (new)
export interface DefaultShipServiceOpts {
  readonly dbPath: string;
  readonly runsDir: string;
  readonly defaultModelId?: string;
  readonly cursor?: CursorRunner; // override for tests
}

export function createDefaultShipService(opts: DefaultShipServiceOpts): () => ShipService;
```

The CLI's `createCliService(opts)` then becomes a thin wrapper that adds the path-resolution defaults; the MCP server uses `createDefaultShipService(opts)` directly because it accepts paths via env vars/flags rather than computing defaults itself. Same memoization semantics.

The Phase 7 `createCliService` still exists for backwards compat; the only behavior change is delegating its body to the new helper.

### ED-2 — Binary shape

Single executable: `ship-mcp-server` (registered via `package.json#bin`, deferred to V2 like the CLI's `ship` bin entry — V1 is `tsx src/bin.ts`). Implemented in `src/bin.ts`. The binary:

1. Reads `SHIP_DB_PATH`, `SHIP_RUNS_DIR`, `CURSOR_API_KEY` from env (with `<UserConfigDir>/ship/` defaults via the same resolver as the CLI).
2. Pre-flight: rejects with exit 1 + a clear "set CURSOR_API_KEY" message if the key is missing.
3. Constructs the `ShipService` via `createDefaultShipService(opts)`.
4. Constructs the MCP `McpServer` (high-level dispatch-aware variant — see ED-3), registers four tools + one resource (per F1–F5).
5. Connects the server to stdio transport (`StdioServerTransport`).
6. `await server.connect(transport)`.
7. The process stays alive until stdin closes or the client disconnects. Then it exits 0.

```ts
// src/bin.ts (sketch)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerShipTool } from "./tools/ship.js";
// ...
import { createDefaultShipService } from "@ship/core";

if (process.env["CURSOR_API_KEY"] === undefined) {
  process.stderr.write("error: CURSOR_API_KEY is not set\n");
  process.exit(1);
}

const factory = createDefaultShipService({ dbPath, runsDir });
const server = new McpServer(
  { name: "ship", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);
registerShipTool(server, factory);
registerGetWorkflowRunTool(server, factory);
registerListWorkflowRunsTool(server, factory);
registerCancelWorkflowRunTool(server, factory);
registerRunsResource(server, factory);
await server.connect(new StdioServerTransport());
```

### ED-3 — Tool layout

The MCP protocol exposes tools through a single `tools/call` JSON-RPC method that dispatches by `params.name`, not through one method per tool — registering `setRequestHandler(toolASchema, ...)` then `setRequestHandler(toolBSchema, ...)` would have the second registration replace the first on the low-level `Server` API. Likewise, `tools/list` and `resources/list` are not auto-installed when per-item handlers are registered; they have to be wired explicitly.

The high-level `McpServer` class (`@modelcontextprotocol/sdk/server/mcp.js`) handles both concerns: it owns a single `tools/call` dispatcher, a single `tools/list` enumerator, and the same pair for resources. Each tool registers via `server.tool(name, description, zodInputSchema, handler)`; the SDK collects them into the dispatcher and exposes them via `tools/list` automatically. We use that.

Each tool still lives in `src/tools/<name>.ts` and exports a `register<Name>Tool(server: McpServer, factory: ServiceFactory): void`. The function:

1. Calls `server.tool(toolName, description, inputZodSchema, handler)` once.
2. The handler:
   - Receives the already-validated `args` (the SDK runs the Zod schema before calling).
   - Calls the matching service method.
   - Validates the result against the `@ship/mcp` output schema (defense-in-depth — schema drift between core and the wire shouldn't reach a client).
   - Returns a `CallToolResult` with the JSON-stringified output as a single text content block.
3. Errors propagate via `mapErrorToJsonRpcError` (see ED-4).

```ts
// src/tools/ship.ts (sketch)
import { shipInputSchema, shipOutputSchema } from "@ship/mcp";

export function registerShipTool(server: McpServer, factory: ServiceFactory): void {
  server.tool(
    "ship",
    "Start a workflow run from an approved task doc.",
    shipInputSchema.shape,
    async (args) => {
      const out = await factory().ship(args);
      const validated = shipOutputSchema.parse(out);
      return { content: [{ type: "text", text: JSON.stringify(validated) }] };
    },
  );
}
```

Because `McpServer` accepts the Zod schema directly, we don't need a `zod-to-json-schema` conversion step: the SDK derives the JSON Schema for `tools/list` from the Zod schema's `.shape`. (This is a small win over the `Server` + manual approach — one fewer dep, one fewer conversion to keep in sync.)

### ED-4 — Error mapping

| Error | JSON-RPC code | Meaning |
|---|---|---|
| `WorkdirNotFoundError`, `DocNotFoundError`, `DocPathEscapesWorkdirError` | `-32602` invalid params | Pre-row caller-input validation. |
| `WorkflowRunNotFoundError` | `-32602` invalid params | Unknown id passed to `get_workflow_run` / `cancel_workflow_run`. |
| `ZodError` (from input schema validation) | `-32602` invalid params | Malformed payload. |
| `RangeError` (e.g. `--limit` cap) | `-32602` invalid params | Built-in user-input-out-of-range. |
| Anything else thrown out of the service | `-32603` internal error | Default. |

Mirrors the CLI's user-vs-internal split from Phase 7 § ED-4. The mapping table lives in a single `mapErrorToJsonRpcError(err): JsonRpcError` helper so the four tool handlers stay uniform.

### ED-5 — Resource handler

`ship://runs/{id}` registers via `server.resource(name, uriTemplate, handler)` on the `McpServer` (matches the per-tool `server.tool(...)` registration in ED-3 — same dispatch ergonomics). The handler:

1. Parses the URI to extract `{id}` (regex against `/^ship:\/\/runs\/([^/]+)$/`).
2. Calls `factory().getRun(id)`.
3. `null` → JSON-RPC `-32602` "not found: <id>".
4. Otherwise validates the returned run against `getWorkflowRunOutputSchema` and returns a `ReadResourceResult` with `application/json` content.

The resource is **read-only**; the server doesn't advertise resource subscriptions in V1.

### ED-6 — Test transport

Smoke tests use the SDK's `InMemoryTransport` (a paired transport that lets a `Client` and `McpServer` talk in-process). For each test:

1. Construct a `ShipService` factory wired with `FakeCursorRunner`.
2. Build an `McpServer` with the four tools + resource registered.
3. Connect a `Client` over `InMemoryTransport`.
4. Call each tool / read the resource and assert on the response.

```ts
// src/tools/ship.test.ts (sketch)
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
const cursor = new FakeCursorRunner();
cursor.enqueue({ events: [], result: { status: "succeeded", durationMs: 0, branches: [] } });
const factory = createDefaultShipService({ dbPath: ":memory:", runsDir: tmp, cursor });
const server = buildServer(factory);
const client = new Client(...);
await server.connect(serverTransport);
await client.connect(clientTransport);
const result = await client.callTool({ name: "ship", arguments: { workdir: tmpWorkdir, repo: "ship", docPath: "docs.md" } });
expect(JSON.parse(result.content[0].text).status).toBe("succeeded");
```

### ED-7 — Subprocess integration tests

`e2e/integration/mcp-server.integration.test.ts` spawns `tsx src/bin.ts` as a child process, attaches a `Client` via `StdioClientTransport` over the spawned process's stdio, and exercises each tool/resource. Mirrors Phase 7's `cli-binary.integration.test.ts` pattern. Catches stdio framing / capability-declaration / startup-pre-flight bugs the in-memory tests miss. To keep it from needing a real API key, the binary detects `SHIP_TEST_FAKE_CURSOR=1` and substitutes `FakeCursorRunner` (single-line override; the env var is only checked by `bin.ts` and never crosses into production paths).

Alternative considered: import the server module in-process. Rejected because `bin.ts`'s top-level `await server.connect(...)` and pre-flight env checks are exactly what we want to exercise.

### ED-8 — Capability declaration

The MCP `McpServer` constructor still needs a capabilities block. V1:

```ts
new McpServer(
  { name: "ship", version: "0.1.0" },
  {
    capabilities: {
      tools: {},          // four tools registered via server.tool(...)
      resources: {},      // one URI template registered via server.resource(...)
      // no prompts, no logging, no completion
    },
  },
);
```

`tools` and `resources` are empty objects (per MCP convention) since we just signal "this server supports them." With the high-level `McpServer` class, `tools/list` and `resources/list` JSON-RPC methods are wired automatically once tools/resources are registered via `server.tool(...)` / `server.resource(...)` — there's no separate `ListToolsRequestSchema` / `ListResourcesRequestSchema` handler to install. (This was an error in revision 0 of this doc that conflated `McpServer`'s behavior with the lower-level `Server` API; on `Server` the list handlers DO have to be wired explicitly.)

### ED-9 — Repo-wide isolation test

`packages/mcp-server/test/dep-direction.test.ts` mirrors `core`'s + `cli`'s tests: `packages/mcp-server/src/**` MUST find zero `from "@ship/cli"` matches.

## API boundaries / contracts

The `mcp-server` package exports nothing. It's a binary with no public TS API. The internal modules (`tools/*.ts`, `resources/*.ts`, `errors.ts`) are private to the package.

`package.json` shape:

```json
{
  "name": "@ship/mcp-server",
  "private": true,
  "type": "module",
  "main": "./src/bin.ts",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@ship/core": "workspace:*",
    "@ship/cursor-runner": "workspace:*",
    "@ship/mcp": "workspace:*",
    "@ship/store": "workspace:*",
    "@ship/workflow": "workspace:*"
  },
  "devDependencies": {
    "@ship/test-harness": "workspace:*",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0"
  }
}
```

Unlike the CLI, this package DOES depend on `@ship/mcp` directly because it consumes the input/output schemas at runtime (the CLI only consumes the inferred TS types, which Phase 7 routed through `@ship/core` re-exports). The schemas need to be available as Zod values for the MCP SDK request/response handlers.

V1 omits the `bin` entry for the same reason as the CLI: no build step yet. Local invocation is `pnpm --filter @ship/mcp-server exec tsx src/bin.ts`. The `bin` entry + build land in V2.

## Validation plan

Tests live in `packages/mcp-server/src/**/*.test.ts` (unit) plus `packages/mcp-server/test/dep-direction.test.ts` (isolation) plus `e2e/integration/mcp-server.integration.test.ts` (subprocess).

### Each tool: argv → service call

For `ship`, `get_workflow_run`, `list_workflow_runs`, `cancel_workflow_run`:

- ✅ Happy path: in-memory client calls the tool with valid input → handler invokes the right service method → response payload matches the output schema → status code is success.
- ❌ Malformed input (Zod rejects) → JSON-RPC error with code `-32602` and the Zod issue path in the message.
- ❌ Service throws a typed user-error → `-32602`.
- ❌ Service throws a generic internal error → `-32603`.

### Resource: `ship://runs/{id}`

- ✅ Existing run → response body is JSON of the hydrated `WorkflowRun`.
- ❌ Unknown id → `-32602` "not found".
- ❌ Malformed URI (e.g. `ship://other/123`) → `-32602`.

### Bin pre-flight (in unit + integration)

- ❌ Missing `CURSOR_API_KEY` → exit 1; stderr names the missing env var.
- ✅ Tools list: `client.listTools()` returns the four registered tools with metadata.
- ✅ Resources list: `client.listResources()` returns the one template.

### Subprocess integration (`e2e/integration/mcp-server.integration.test.ts`)

- ✅ Spawn the binary with `SHIP_TEST_FAKE_CURSOR=1`, connect a stdio `Client`, call `list_workflow_runs` against an empty store → response is `{ runs: [] }`, exit 0 on graceful disconnect.
- ✅ `ship` tool with the fixture task doc → returns a `succeeded` `ShipOutput`; runs dir + db file land on real disk.
- ❌ Without `CURSOR_API_KEY` and without `SHIP_TEST_FAKE_CURSOR=1` → child exits 1 within ~500ms.

### Repo-wide isolation

- ✅ `packages/mcp-server/src/**` finds zero `from "@ship/cli"` matches.

### Acceptance

- `pnpm --filter @ship/mcp-server test` exits 0.
- `pnpm typecheck` / `lint` / `format:check` from repo root pass.
- `make coverage` clears the 80/75 threshold for `@ship/mcp-server`.
- `make integration` includes the mcp-server scenarios and stays green.
- Manual smoke: in Cursor or Claude Code, configure the server entry, restart, see all four tools listed in the MCP panel, call `list_workflow_runs` against a fresh local store and observe `{"runs":[]}`.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| MCP TS SDK API changes between minor versions | Brittle handlers | Pin `^1.0.0` (semver-compatible). Test the actually-installed version in a smoke test that exercises every tool + resource. |
| `await server.connect(stdio)` blocks; tests can hang if a handler throws synchronously | Test runner deadlock | The `InMemoryTransport` pattern in tests doesn't share this concern; subprocess tests use a hard `timeout` in `spawn` options. |
| MCP SDK JSON-Schema derivation drift | MCP clients see a different `tools/list` shape than the runtime Zod validator accepts | The high-level `McpServer.tool(...)` registration takes the Zod schema directly and the SDK derives `tools/list`'s JSON Schema from it — single source of truth, nothing to keep in sync manually. A smoke test calls `client.listTools()` once and asserts the returned schema matches the Zod schema's `.shape` keys. |
| Long-running `ship` tool call holds an MCP request open for minutes | Driver-agent times out | Document this in the MCP server's README; V2 adds streaming responses (per spec.md). V1 advice: agents call `ship` then poll `get_workflow_run` if they need to multitask. |
| `mapErrorToJsonRpcError` drift from the CLI's `isUserError` | Same logical error → different exit semantics across the two consumers | Both helpers consult the same set of typed errors; an integration test pins the user-vs-internal split for both consumers. Could share a helper later if drift surfaces. |
| Stdio framing bugs the in-memory transport doesn't catch | Real MCP clients fail in ways tests miss | The L3 subprocess integration test runs the actual binary over real stdio. Phase 7's bug-smash showed this is the layer that catches `bin.ts`-only regressions. |

## Open questions

1. **Should the MCP server expose a `tools/call` audit log?** Proposed: V2. V1 already writes per-run artifacts (events.ndjson) for the `ship` flow, which is the loudest one; the read-only tools are uninteresting for now.
2. **`ship` tool: stream events.ndjson lines back as MCP notifications?** Proposed: V2 once the SDK supports streaming responses ergonomically. V1 returns once the run terminates.
3. **Single binary or split (`ship-mcp-server` vs `ship-mcp-server-cloud` later)?** Proposed: single. Cloud transport is V2; we'll add a flag (`--transport=sse`) when it lands.
4. **Server name + version exposed in the `McpServer` constructor.** Proposed: `name: "ship"`, `version: "0.1.0"` for V1. Bumps with the npm package version once we publish.
5. **Should the `--repo` "label" parameter be required at the MCP boundary?** Per Phase 7's CLI, yes (it's `requiredOption`). The schema in `@ship/mcp` already marks it required, so the MCP boundary inherits that. No action needed here.

## Implementation plan

After review/approval, implement as **a single PR** in this order:

1. **`packages/core/src/default-wiring.ts` + tests** — `createDefaultShipService(opts)` factored from `@ship/cli/src/service.ts`. The CLI's `createCliService` becomes a thin wrapper that supplies the path-resolution defaults; tests in `@ship/cli` carry forward unchanged. Re-export the new helper from `@ship/core/src/index.ts`.
2. **`packages/mcp-server/{package.json, tsconfig.json, vitest.config.ts}`** — workspace wiring matching the Phase 7 pattern. Deps per § "API boundaries / contracts". `vitest.config.ts` sets the 80/75 coverage threshold.
3. **`src/errors.ts` + tests** — `mapErrorToJsonRpcError(err): JsonRpcError`. Tests pin the typed-error-to-code mapping per ED-4.
4. **`src/tools/ship.ts` + tests** — `registerShipTool(server, factory)`. The Zod input schema is passed straight to `server.tool(...)`; no separate JSON-Schema conversion module needed. In-memory transport tests exercise happy path + each error path.
5. **`src/tools/get-workflow-run.ts` + tests** — `registerGetWorkflowRunTool(server, factory)`.
6. **`src/tools/list-workflow-runs.ts` + tests** — `registerListWorkflowRunsTool(server, factory)`.
7. **`src/tools/cancel-workflow-run.ts` + tests** — `registerCancelWorkflowRunTool(server, factory)`.
8. **`src/resources/runs.ts` + tests** — `registerRunsResource(server, factory)`. Tests cover URI parse + null → not-found + happy path.
9. **`src/server.ts`** — `buildServer(factory)` factory that constructs the `McpServer` and registers all tools + the resource. Pure factory; no transport, no env. Tests in step 10 use this with `InMemoryTransport`.
10. **`src/bin.ts`** — entrypoint. Reads env, builds the service factory + server, connects to stdio. Lightly tested (smoke).
11. **`packages/mcp-server/test/dep-direction.test.ts`** — `packages/mcp-server/src/**` MUST find zero `from "@ship/cli"` matches.
12. **`e2e/integration/mcp-server.integration.test.ts`** — subprocess test. Spawns the binary with `SHIP_TEST_FAKE_CURSOR=1`, connects via stdio, exercises each tool + the resource + the missing-API-key pre-flight.
13. **`make check`** + **`make coverage`** + **`make integration`** — green.
14. **Mark Phase 8 done in [plan.md](../plan.md).**

Total LOC estimate (per CLAUDE.md weighting): ~250 src + ~280 tests = **390 weighted**. Single PR, comfortably inside the < 500 amazing band.
