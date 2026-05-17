# `@ship/workflow`

Workflow domain schemas (Zod), types, workflow/phase state helpers, and ID factories.

## Property-based tests

Phase transition and schema invariants are also checked with fast-check in `src/transitions.properties.test.ts`. By default each property runs **100** examples; set **`SHIP_PROP_ITER`** (e.g. `1000`) for a heavier local or nightly run. Optional **`SHIP_PROP_SEED`** fixes the fast-check seed (integer); the default seed is stable across machines so CI stays deterministic.

```bash
pnpm --filter @ship/workflow test
SHIP_PROP_ITER=1000 pnpm --filter @ship/workflow test
```

On failure, fast-check prints a shrinked counterexample and the seed used for that run. Re-run with the same `SHIP_PROP_SEED` (integer) to reproduce; this is separate from Vitest’s optional `--sequence.seed` shuffle knob.
