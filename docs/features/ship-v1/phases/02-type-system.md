# Phase 2 — V1 type system (`packages/workflow` + `packages/mcp`)

Status: implemented 2026-05-06.
Owner: itsHabib
Date: 2026-05-06

> **Companion docs.** [spec.md](../spec.md) is the V1 design spec; types listed there are normative. [plan.md](../plan.md) lists this phase as a checkbox; this file is the per-phase task doc the plan now points to.
>
> **Revision 1 changes** (from adversarial review + user feedback): renamed package `@ship/shared` → `@ship/domain` (matches tower's `internal/domain/` convention; "shared" was too generic); fixed barrel-export pattern for `verbatimModuleSyntax`; committed to non-composite TS build wiring (no `dist/`, no project refs in V1); added `modelSelectionSchema`; clarified domain-vs-row contract for `Phase.inputJson` / `WorkflowRun.phases`; switched `CursorRunRef.runtime` to a one-element enum (V2-extension friendly); cut speculative ID validators + `ID_PREFIXES` export; rewrote stability promise to be coherent with `.strict()`; resolved all four open questions inline.
>
> **Revision 2 changes** (post-implementation, 2026-05-06): renamed package `@ship/domain` → `@ship/contracts`. "Domain" reads as DDD-flavored in a TS-monorepo context where Habib's instinct (Go-shaped) is to put types next to the code that owns them; "contracts" describes what the package actually contains.
>
> **Revision 3 changes** (post-implementation, 2026-05-06): split `@ship/contracts` into two packages — `@ship/workflow` (workflow entities, state machine, ID factories) and `@ship/mcp` (MCP tool I/O schemas, depends on `@ship/workflow`). Driven by import-pattern analysis: of the six V1 consumers, four (`store`, `tower-adapter`, `cursor-runner`, `cli`) only need workflow types; only `core` and `mcp-server` need both. Splitting keeps the dep surface tight and makes it impossible for, e.g., `store` to accidentally produce wire-shaped data internally. The two packages preserve the same export set; `mcp.ts` now imports `cursorRunRefSchema` / `workflowRunSchema` / etc. from `@ship/workflow` instead of a sibling file. ID factories live with `workflow` (IDs are entity-shaped). No source-code logic changed.

## Summary

The V1 type system, split across two TypeScript packages:

- **`@ship/workflow`** — every Zod schema and inferred type for the workflow domain (`WorkflowRun`, `Phase`, `CursorRunRef`, `WorktreeRef`, `WorkflowPolicy`, `ModelSelection`, status enums, etc.), the state-machine helpers (`canTransition`, `isTerminal`), the default policy constant, and the three prefixed-ULID ID factories. Runtime deps: `zod`, `ulid`. No `@ship/*` deps.
- **`@ship/mcp`** — input and output schemas for each of the four V1 MCP tools (`ship`, `get_workflow_run`, `list_workflow_runs`, `cancel_workflow_run`), plus `shipArtifactsSchema`. Runtime deps: `zod`, `@ship/workflow` (workspace).

Both packages are pure-types: no I/O, no side effects on import.

The phase exists for two reasons:

1. **Single source of truth for the V1 type system.** Define `WorkflowRun`, `Phase`, `WorktreeRef`, `CursorRunRef`, and the MCP tool I/O shapes once, consume them everywhere. If `store` writes a row that `mcp-server` cannot deserialize, that's a compile error here, not a runtime mystery later.
2. **Validation seam at every boundary.** Zod schemas validate data at MCP tool inputs, on store row hydration, when parsing `RunResult` from the SDK, and when reading config files. Internal code (between Ship packages) trusts the type system; data crossing a system boundary always goes through `schema.parse(...)`.

This phase ships both packages; subsequent phases consume them.

## Functional requirements

### F1 — Export schemas + types for the V1 data model

Every type listed in [spec.md § Data model](../spec.md#data-model) ships as a Zod schema plus a `z.infer`-derived TypeScript type:

- `workflowStatusSchema` / `WorkflowStatus`
- `phaseStatusSchema` / `PhaseStatus`
- `phaseKindSchema` / `PhaseKind` (V1: `z.enum(["implement"])` — single value, declared as enum so V2 phase kinds are a one-line diff)
- `cursorRunStatusSchema` / `CursorRunStatus`
- `cursorRunRuntimeSchema` / `CursorRunRuntime` (V1: `z.enum(["local"])` — single value; V2 adds `"cloud"`)
- `modelSelectionSchema` / `ModelSelection` — structural mirror of `@cursor/sdk`'s `ModelSelection`: `{ id: string; params?: Array<{ id: string; value: string }> }`. Defined locally rather than re-exported from the SDK so `domain` keeps its zero-`@ship/*`-dep promise and the SDK is a runtime-only concern of `cursor-runner`. A type-level `satisfies` test in `domain`'s test suite asserts the shapes stay structurally compatible.
- `worktreeRefSchema` / `WorktreeRef`
- `cursorRunRefSchema` / `CursorRunRef`
- `workflowPolicySchema` / `WorkflowPolicy`
- `phaseSchema` / `Phase` — **the domain shape**, not the SQL row. `Phase.inputJson` and `Phase.outputJson` are stringly-typed in V1 (only one `PhaseKind` exists; no need to schema-type their payload yet). When V2 adds review/ci-fix/etc. phases, those payloads get their own per-`PhaseKind` schemas in this package.
- `workflowRunSchema` / `WorkflowRun` — **the domain shape**, hydrated. Includes `phases: Phase[]`. The store package owns the row → domain hydration logic; `domain` does not know about SQL layout.

### F2 — Export schemas + types for the V1 MCP tool surface

For each of the four V1 MCP tools (`ship`, `get_workflow_run`, `list_workflow_runs`, `cancel_workflow_run`) ship an input schema and an output schema:

- `shipInputSchema` / `ShipInput`, `shipOutputSchema` / `ShipOutput`
- `getWorkflowRunInputSchema` / `GetWorkflowRunInput`, `getWorkflowRunOutputSchema` / `GetWorkflowRunOutput`
- `listWorkflowRunsInputSchema` / `ListWorkflowRunsInput`, `listWorkflowRunsOutputSchema` / `ListWorkflowRunsOutput`
- `cancelWorkflowRunInputSchema` / `CancelWorkflowRunInput`, `cancelWorkflowRunOutputSchema` / `CancelWorkflowRunOutput`

Plus supporting shapes (e.g. `shipArtifactsSchema` for the paths object inside `ShipOutput`).

### F3 — ID generators

Three ID factories that emit prefixed ULIDs:

- `newWorkflowRunId() → "wf_<ulid>"`
- `newPhaseId() → "ph_<ulid>"`
- `newCursorRunId() → "cr_<ulid>"`

That's it. No matching validators, no exported `ID_PREFIXES` constant. If an MCP tool input wants to validate an incoming ID's format, the input schema in `mcp.ts` uses `z.string().regex(...)` directly on that field — closer to the validation seam, no extra exported function. ID-format checks are not load-bearing in V1 (store reads strings out of TEXT columns and trusts them; `core` only ever sees IDs it generated). Validators get added later when an actual caller asks for one.

### F4 — Workflow state-machine helpers (pure, advisory)

Two functions that encode the rules from [spec.md § State transitions](../spec.md#state-transitions):

- `canTransition(from, to) → boolean` — returns `true` iff `to` is a permitted next state from `from`.
- `isTerminal(status) → boolean` — `true` for `succeeded`, `failed`, `cancelled`.

These live in `domain` because they're pure derivations from the type system. They are **advisory** — `core` is the sole writer of `WorkflowRun.status` and owns the canonical state machine. If `core` ever adds a transition `domain` doesn't know about, `core` is right and the helpers must be updated. `domain`'s helpers exist so `mcp-server` and `cli` can answer "is this run already terminal?" without reaching into `core`.

### F5 — Default workflow policy (fallback only)

Export `DEFAULT_WORKFLOW_POLICY` matching the values in [spec.md § WorkflowPolicy](../spec.md#workflowpolicy):

```ts
export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  baseRef: "main",
  maxRunDurationMs: 30 * 60 * 1000,
  agentTimeoutMs: 30 * 60 * 1000,
};
```

This is the **fallback** used by `core` only when no config or per-call override is provided. Once V2 adds richer policy (max review cycles, max CI fix attempts, reviewer roster), the default likely moves to a `core/config.ts` module that can layer YAML config + env + per-call overrides on top. The constant lives here in V1 because policy is so thin that one source of truth is fine.

## Non-functional requirements

- **Zero side effects on import.** No log lines, no process listeners, no env var reads at module load. Importing `@ship/workflow` or `@ship/mcp` is free.
- **Zero dependencies on other `@ship/*` packages.** This is the leaf of the dependency graph.
- **Minimal runtime deps.** Only `zod` and `ulid`. No utility libraries.
- **TypeScript-strict-clean.** Compiles under the root `tsconfig.base.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`).
- **No `any`.** No `as unknown as ...`. Inferred or explicit types only.
- **Tree-shake friendly.** All exports are top-level named exports; no default exports, no namespace re-exports of huge modules.
- **Test coverage:** every schema has at least one positive and one negative case. Every helper is exercised. Every ID factory + validator pair is exercised including cross-prefix rejection.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Schema library | **Zod 3.24+** | Valibot, ArkType, TypeBox, hand-rolled | Mature, ubiquitous, the MCP TS SDK already uses it, error messages are good. Cost: bundle size (~80KB), runtime overhead. Acceptable — we validate at edges, not in hot loops. Zod 4 is in alpha; revisit when stable. |
| ID format | **Prefixed ULID** (`wf_01ARZ3NDEKTSV4RRFFQ69G5FAV`) | UUID v4, UUID v7, KSUID, plain `wf_{counter}` | ULIDs are sortable by creation time (good for log scanning), URL-safe, 26 chars (shorter than UUID), and a stable `ulid` package exists. Prefix means a stray ID in a log line tells you what kind of entity it is. |
| Branded types for IDs | **No** | `type WorkflowRunId = string & { __brand: "WorkflowRunId" }` | Branded types would prevent passing a phase ID where a workflow run ID is expected. Real benefit, but adds friction (cast functions, runtime parse boundaries). For V1 with three ID types and small surface, the prefix + validator + naming discipline is enough. Revisit if we get a "wrong ID type" bug. |
| Direct `z.infer` types vs explicit interfaces | **`z.infer`** | Hand-written `interface WorkflowRun { ... }` parallel to schema | Two declarations drift. `z.infer<typeof x>` keeps the type the schema enforces. Trade-off: editor "go to definition" jumps to the schema, not a clean type body. Acceptable. |
| Object schema strictness | **`.strict()`** on every object | `.passthrough()` (allow unknown keys), default (silently strip) | Unknown keys at boundaries are bugs (typos, version drift) — fail them loud. Cost: when a future field lands, every parser needs the new field declared. That's the point. |
| Module shape | **One barrel `index.ts` per package** | Sub-path exports within a single package (`@ship/contracts/workflow`, `@ship/contracts/mcp`) | Each of the two packages stays small (<1k LOC); the package boundary itself is now what separates workflow vs MCP, which is more honest than sub-path exports inside one package. Tree-shakers handle dead-code elimination either way. |
| Source layout | **One file per logical group** (`workflow.ts`, `mcp.ts`, `id.ts`) | Single `types.ts` | One file is easier to navigate; co-locates schema + helpers. Three files is small enough that the file count doesn't bloat the package. |
| Test layout | **Co-located `*.test.ts` next to source** | `test/` directory | Vitest's default; `eslint.config.js` already exempts `**/*.test.ts` from `max-lines-per-function`. Co-location keeps tests next to the schemas they exercise. |
| Test framework | **Vitest** (already in workspace) | Node's `node:test` | Already wired. No reason to introduce a second runner. |
| Package layout | **Two packages: `@ship/workflow` + `@ship/mcp`** | One package (`@ship/contracts`); three packages (`@ship/workflow` + `@ship/mcp` + `@ship/id`) | Two packages match the actual import patterns: `store` / `tower-adapter` / `cursor-runner` / `cli` only need workflow types; `core` / `mcp-server` need both. Splitting keeps the dep surface tight. Three packages would over-fracture for ID — the factories are 3 functions with no internal consumers and they're entity-shaped, so they live with `workflow`. |
| Build wiring | **No `composite`, no `dist/`, no project refs in V1.** Consumers import `@ship/workflow` and `@ship/mcp` directly from `src/index.ts`; vitest transforms `.ts` at test time; root `tsc --noEmit` typechecks everything in one pass. | Composite + project refs + `dist/` outputs + `tsc -b` builds | Composite/refs are useful when packages publish independently or when build caching matters across many packages. We don't publish, the workspace has 7 packages max, and the simpler wiring eliminates a class of "what's `dist/` for if nothing uses it" confusion. We pay this back if/when we publish or hit slow incremental builds. |
| Schema strictness vs stability | **`.strict()` on every object schema; treat any schema change as a tracked breaking change.** | `.strict()` on inputs + `.passthrough()` on outputs | Mixed strictness invites silent skew between the schema and its consumers, and outputs in V1 are produced by Ship itself (not by external services we can't control), so forward-compat isn't actually buying us anything. When a field changes, every consumer must declare the new field — which is the discipline we want. |

## Engineering decisions

### ED-1 — Schemas first, types via `z.infer`

Every shape is defined as a `z.object(...)` schema; the corresponding TypeScript type is `z.infer<typeof xSchema>`. Two declarations that can drift become one declaration that cannot.

```ts
export const workflowStatusSchema = z.enum([...]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
```

### ED-2 — Prefixed ULIDs for at-a-glance entity recognition

ID factories emit `<prefix>_<ulid>`. Prefix is two letters (`wf`, `ph`, `cr`); separator is `_`; body is a 26-char Crockford-base32 ULID. The prefix appears in logs, NDJSON archives, error messages, and store rows — anywhere an opaque ID would otherwise force a context look-up.

### ED-3 — `.strict()` on every object schema

Every `z.object({...})` ends with `.strict()`. Unknown keys at any boundary cause a parse error. Catches typo-driven bugs and version-drift surprises early.

### ED-4 — Pure helpers co-located with their schema

`canTransition`, `isTerminal`, `DEFAULT_WORKFLOW_POLICY` all live in `workflow.ts`. ID factories live in `id.ts`. This avoids a thin `helpers.ts` whose only purpose is to gather things.

### ED-5 — `verbatimModuleSyntax` discipline

The root `tsconfig.base.json` enables `verbatimModuleSyntax: true`. Consumers must `import type { WorkflowRun }` for type-only imports and plain `import { workflowRunSchema }` for runtime values. This package's source obeys the same rule internally (`import type { z } from "zod"` would be wrong — Zod is runtime).

### ED-6 — `module: NodeNext` + `.js` extension in relative imports

Inside each package's `src/`, relative imports between files use `.js` extensions (`import { ... } from "./id.js"`). This is required by `module: NodeNext` and gives us correct ESM behavior at runtime when the tooling resolves to `.ts` source via `main: "./src/index.ts"`. Cross-package imports (e.g. `@ship/mcp` → `@ship/workflow`) use the bare workspace name; pnpm symlinks resolve it to the sibling source tree.

### ED-7 — No build artifact in V1; everyone imports from source

Both packages use the same minimal `package.json` shape (the example below shows `@ship/workflow`; `@ship/mcp` is identical except for `name`, the absence of `ulid`, and the addition of `"@ship/workflow": "workspace:*"` under `dependencies`):

```json
{
  "name": "@ship/workflow",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  }
}
```

No `dist/`, no `composite`, no project references. Three things must be true for this to work:

1. **Root TS configs drop composite.** `tsconfig.base.json` removes `composite`, `declaration`, `declarationMap`, `sourceMap`, `incremental` (or sets them to false). Root `tsconfig.json` becomes a plain include-everything `noEmit: true` config covering `packages/*/src/**/*`. Root `package.json` script changes from `"typecheck": "tsc -b"` to `"typecheck": "tsc --noEmit"`. **This is a precondition for Phase 2 implementation** — done as the first step of the phase, not a separate phase.
2. **Vitest transforms `.ts` at test time.** Already true with the V1 vitest config; no change needed.
3. **No code path tries to `require()` or load `.ts` from Node directly without a transform.** The eventual `cli` and `mcp-server` packages will be the first ones invoked from a Node binary; when they ship, they'll either build themselves to `dist/` (publishable) or stay TS-only with `tsx` as the entry shim. Decided per-package then; not now.

Per-package `tsconfig.json` is small:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src" },
  "include": ["src/**/*"]
}
```

No `outDir`, no `noEmit` override needed (it inherits from the base, which is `noEmit: true` after the precondition above is applied).

### ED-8 — Cross-package source imports work via pnpm symlinks + workspace `*` ranges

Once `packages/workflow` and `packages/mcp` are in the pnpm workspace, dependent packages declare them as `"@ship/workflow": "workspace:*"` (and / or `"@ship/mcp": "workspace:*"`) in their `package.json`. pnpm symlinks `node_modules/@ship/workflow` to `packages/workflow/`, and `main: "./src/index.ts"` resolves to the source. Vitest's TS transform handles the `.ts` import. TypeScript's `moduleResolution: "NodeNext"` follows the symlink and reads the source for type info. No build step in the loop. The same applies to the `@ship/mcp` → `@ship/workflow` edge inside this phase.

Phase 3 (`packages/store`) will be the first concrete user of this; if anything is wrong, we fix it then.

## API boundaries / contracts

The public surface — everything re-exported by each package's `src/index.ts`. `@ship/workflow` exports the schemas / types / helpers from `workflow.ts` plus the ID factories from `id.ts`; `@ship/mcp` exports just the MCP tool I/O schemas from `mcp.ts`. With `verbatimModuleSyntax: true`, type-only re-exports must use `export type`:

```ts
// === workflow.ts ===
// runtime values (schemas + helpers + constants)
export {
  workflowStatusSchema,
  phaseStatusSchema,
  phaseKindSchema,
  cursorRunStatusSchema,
  cursorRunRuntimeSchema,
  modelSelectionSchema,
  worktreeRefSchema,
  cursorRunRefSchema,
  workflowPolicySchema,
  phaseSchema,
  workflowRunSchema,
  DEFAULT_WORKFLOW_POLICY,
  isTerminal,
  canTransition,
} from "./workflow.js";
// types (z.infer-derived)
export type {
  WorkflowStatus,
  PhaseStatus,
  PhaseKind,
  CursorRunStatus,
  CursorRunRuntime,
  ModelSelection,
  WorktreeRef,
  CursorRunRef,
  WorkflowPolicy,
  Phase,
  WorkflowRun,
} from "./workflow.js";

// === mcp.ts ===
export {
  shipInputSchema,
  shipArtifactsSchema,
  shipOutputSchema,
  getWorkflowRunInputSchema,
  getWorkflowRunOutputSchema,
  listWorkflowRunsInputSchema,
  listWorkflowRunsOutputSchema,
  cancelWorkflowRunInputSchema,
  cancelWorkflowRunOutputSchema,
} from "./mcp.js";
export type {
  ShipInput,
  ShipArtifacts,
  ShipOutput,
  GetWorkflowRunInput,
  GetWorkflowRunOutput,
  ListWorkflowRunsInput,
  ListWorkflowRunsOutput,
  CancelWorkflowRunInput,
  CancelWorkflowRunOutput,
} from "./mcp.js";

// === id.ts ===
export { newWorkflowRunId, newPhaseId, newCursorRunId } from "./id.js";
```

Nothing else is part of the contract. Internal helpers, regex constants, the `ulid` re-export — none of those.

### Stability promise (within V1)

Any schema change — adding a field, removing a field, renaming a field, tightening a constraint — is a V1 breaking change. The PR that lands the change updates every consumer (`store`, `core`, `mcp-server`, `cli`) in the same commit.

This is stricter than "minor revisions accept the same inputs," and that's deliberate: with `.strict()` on every schema, an "additive" change still rejects clients that constructed objects with the new field name as something else, and outputs with new fields hard-fail every consumer that hasn't upgraded. Ship is a single repo; we don't gain anything by pretending consumers are independent versioned clients. We DO gain by making schema drift impossible to land silently.

When V1 is shipped and we have a real "Ship deployed N versions ago, talking to clients M versions ago" problem, we revisit. Not yet.

## Data model

Refer to [spec.md § Data model](../spec.md#data-model) for the canonical definitions. This phase implements them as Zod schemas; the schemas are the runtime expression of those types.

Refinements vs raw spec.md:

1. **`WorkflowPolicy` numeric fields** are `z.number().int().positive()` — must be positive integers. Spec lists them as plain numbers; runtime validation rejects 0, negative, and non-integer values.
2. **Timestamps** are validated as ISO-8601 with offset (`z.string().datetime({ offset: true })`). Stricter than just "string."
3. **`CursorRunRef.runtime`** uses `z.enum(["local"])` rather than `z.literal("local")`. Same semantics today; one-line diff to add `"cloud"` in V2.
4. **`PhaseKind`** likewise uses `z.enum(["implement"])`.
5. **`Phase.inputJson` / `Phase.outputJson`** stay as opaque strings in V1. Per-`PhaseKind` payload schemas land here when V2 introduces the second phase kind. Today there's only `implement`, and `core` writes whatever JSON the phase needs.
6. **`WorkflowRun` is the hydrated domain shape**, not the SQL row. `phases` is an array, not a separate FK relation. The `store` package handles row → domain hydration; `domain`'s schema is what `store` produces and `core`/`mcp-server` consume.
7. **`ModelSelection`** is locally defined in `domain`, structurally mirroring `@cursor/sdk`'s exported `ModelSelection`. A `satisfies` test in `workflow.test.ts` asserts the structural compatibility so an SDK upgrade that breaks the shape fails CI in `domain`, not as a runtime parse error in `cursor-runner`.

No new types beyond what spec.md describes (or implies via the SDK).

## Validation plan

Tests live in `packages/workflow/src/*.test.ts` and `packages/mcp/src/*.test.ts`, run by `vitest run` (root config) or per-package `pnpm --filter` invocations.

### Schemas

For each exported object schema:

- ✅ Accepts a valid object that satisfies every field.
- ❌ Rejects an object with an unknown key (`.strict()` enforcement).
- ❌ Rejects an object with an empty string in any required string field.
- ❌ Rejects an object with a missing required field.
- ✅ Accepts an object without optional fields populated.

For each enum schema:

- ✅ Accepts every documented value.
- ❌ Rejects a string outside the enum.

For schemas with numeric fields:

- ❌ Rejects negative durations / counts where `nonnegative` / `positive` applies.

### ID factories

- Format: every factory emits `^<prefix>_[0-9A-HJKMNP-TV-Z]{26}$`.
- Uniqueness: three rapid-fire calls to the same factory produce three distinct strings.
- (No validators in V1; no test for them.)

### State-machine helpers

- `canTransition`:
  - permits documented happy-path transitions (`pending→running`, `running→succeeded|failed|cancelled`).
  - permits cancellation from `pending` and `running`.
  - rejects all transitions out of terminal states.
  - rejects `pending→succeeded` (must go through `running`).
- `isTerminal`:
  - `true` for `succeeded`, `failed`, `cancelled`.
  - `false` for `pending`, `running`.

### Acceptance

- `pnpm --filter @ship/workflow test` and `pnpm --filter @ship/mcp test` both exit 0.
- `pnpm typecheck` passes from the repo root.
- `pnpm lint` passes from the repo root.
- Coverage report shows every exported function and every schema branch hit by at least one test.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Schema drift between `domain` and `store` (e.g. SQL column added without schema update) | Runtime parse failure, hard-to-debug data loss | Store hydrates rows via `workflowRunSchema.parse()`; CI test asserts a round-trip from store to domain schema for fixtures. |
| Zod runtime cost on hot paths | Slowdown if we validate per-event from the SDK stream | Validate at *edges* only — MCP input, store hydration, file deserialization. NDJSON event archive does NOT validate every event; it writes raw bytes. Documented in the runner phase. |
| Zod 3 → 4 migration | Future major upgrade pain | Pin to `^3.24` for V1; revisit when 4 is stable; keep schemas in their own files so migration is a search-and-replace. |
| `verbatimModuleSyntax` friction (constant `import type` discipline) | Productivity drag, easy to get wrong | ESLint `consistent-type-imports` rule (already configured) auto-fixes most cases; CI catches the rest. |
| ULID body collisions (in theory, after 2^80 IDs) | Theoretical only | Ignored — ULIDs are designed for this. |
| Branded-types regret if we hit "wrong ID type passed" bugs | Refactor to add brands later | Rename refactor across the monorepo is mechanical; not a forever decision. Skip for V1, revisit if it bites. |

## Open questions

None remaining. Four were raised in revision 0; all four are resolved below for the record.

### Resolved during review (revision 1)

1. **`z.infer` vs explicit interface for editor UX.** **Decision: `z.infer`.** Drift cost beats editor-UX cost. If "go to definition" landing on a schema annoys in practice, swap individual types to explicit interfaces case-by-case. Not a blanket switch.
2. **Exposing `ID_PREFIXES`.** **Decision: don't.** No V1 caller needs it; the factories are the only legitimate way to construct an ID. If V2 grows a generic ID router or migration tool, the constant lands then.
3. **A `parseOrThrow` convenience wrapper.** **Decision: skip.** `schema.parse()` already throws; wrapping it adds nothing but a name.
4. **`formatZodError` helper.** **Decision: not in `domain`.** Error rendering is a presentation concern. When `core` (Phase 6) or `mcp-server` (Phase 8) needs human-readable Zod errors in tool responses, the helper lives next to the consumer, not next to the schemas.

## Implementation plan

After review/approval, implement in this order:

1. **Precondition — drop composite/project-refs from the workspace.** Edit `tsconfig.base.json` to remove `composite`, `declaration`, `declarationMap`, `sourceMap`, `incremental` (or set them all to false). Edit root `tsconfig.json` to add `packages/*/src/**/*` to `include` and drop the `references` array. Change root `package.json` script from `"typecheck": "tsc -b"` to `"typecheck": "tsc --noEmit"`. Verify `make check` is still green on the empty workspace before continuing.
2. `packages/workflow/{package.json, tsconfig.json, vitest.config.ts}` and `packages/mcp/{package.json, tsconfig.json, vitest.config.ts}` — workspace wiring per ED-7. `workflow` adds `zod ^3.24` + `ulid ^2.4` (and `@cursor/sdk` as a devDep for the structural-compat test); `mcp` adds `zod ^3.24` + `"@ship/workflow": "workspace:*"`. Add the `test` script in each.
3. `src/id.ts` + `src/id.test.ts` — easiest, no schema dependencies.
4. `src/workflow.ts` + `src/workflow.test.ts` — types + schemas + state-machine helpers + `DEFAULT_WORKFLOW_POLICY` + `modelSelectionSchema` + the `satisfies` test for SDK structural compatibility.
5. `src/mcp.ts` + `src/mcp.test.ts` — depends on `workflow.ts`.
6. `src/index.ts` — barrel export, with the `export type { ... }` discipline from the API surface section.
7. `pnpm install` from repo root — links the `@ship/workflow` and `@ship/mcp` workspace symlinks, pulls `zod` + `ulid`, and wires the `@ship/mcp → @ship/workflow` edge.
8. `make check` from repo root — must be green. Specifically verify:
   - `pnpm typecheck` (now `tsc --noEmit`) passes.
   - `pnpm lint` passes.
   - `pnpm format:check` passes.
   - `pnpm test` (now actually running tests) shows both `@ship/workflow` and `@ship/mcp` tests passing.
9. Mark Phase 2 done in [plan.md](../plan.md).

Total LOC estimate: ~280 source + ~300 tests. Wall time: 1–2h.
