# `@ship/workflow`

## What this package owns

Domain layer for Ship — Zod schemas, inferred TypeScript types, workflow/phase transition helpers, and ULID ID factories. No I/O, no MCP wire schemas (those live in `@ship/mcp`), no SQLite. Every persisted row hydrates through these schemas in `@ship/store`.

## Public surface

**Schemas & types**

- `workflowRunSchema`, `phaseSchema`, `phaseKindSchema`, status enums
- **`cursorRunRuntimeSchema`** — `"local" | "cloud"` discriminator for cursor runs
- `modelSelectionSchema`, `canTransition`, `isTerminal`, `TransitionError`
- Types: `WorkflowRun`, `Phase`, `PhaseKind`, `CursorRunRuntime`, etc.

**Phase kinds**

- `"implement"` — active phase kind for agent runs.
- **`phaseKindSchema` tombstone** — the removed PR-opening phase kind keeps its enum literal (see `src/workflow.ts`) so SQLite can hydrate historical rows written before PR #81; Ship no longer appends rows of that kind.

**IDs & constants**

- `newWorkflowRunId`, `newPhaseId`, `newCursorRunId`
- `CLOUD_WORKTREE_SENTINEL`, `DEFAULT_WORKFLOW_POLICY`

## How it composes

Leaf package (`zod`, `ulid`). Consumed by `@ship/store` (hydration), `@ship/mcp` (wire schema composition), `@ship/cursor-runner` (model selection), and `@ship/core` (state machine). Adding a phase kind or status value starts here, then propagates to store SQL and MCP schemas.

## When to swap it

Unlikely to swap wholesale — this IS the domain model. Extracting to a shared protobuf or external schema registry would mean replacing Zod parse boundaries across store and mcp. New V2 surfaces (review cycles, CI fix phases) add literals and transition rules here first.

## Develop / test

```bash
pnpm --filter @ship/workflow test
SHIP_PROP_ITER=1000 pnpm --filter @ship/workflow test   # heavier property run
```

**Property-based tests** in `src/transitions.properties.test.ts` (fast-check) cover transition invariants (I1–I8), schema round-trips, and `cursorRunRuntimeSchema` acceptance. Default **100** examples; set **`SHIP_PROP_ITER`** for more. Optional **`SHIP_PROP_SEED`** fixes the seed for reproducing counterexamples.

This file is the reference model for property-test style in the repo; the **`polish-1-property-track`** task expands coverage to sibling packages using the same conventions.

Hand-written unit tests complement properties in `src/workflow.test.ts`.
