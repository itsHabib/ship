# `@ship/driver`

Strict input contract for work-driver `driver.md` manifests (`driver_version: 1`).

This package parses and validates the YAML frontmatter produced by `/work-driver-prep` into typed structures with actionable, line-precise errors. It is the single entry point consumed by later driver-extraction phases (store import, batch walker).

See [docs/features/driver-extraction/spec.md](../../docs/features/driver-extraction/spec.md) for the full design.

## Public surface

- `parseManifest(text)` — parse a manifest string; never throws
- `DriverManifest`, `ManifestBatch`, `ManifestStream` — typed manifest shapes
- `driverManifestSchema`, `manifestBatchSchema`, `manifestStreamSchema` — zod schemas for hydration

## Boundaries

This package is leaf-level (yaml + zod only). It does not touch the store, ship runs, or CLI/MCP surfaces. `@ship/receipt`'s lenient manifest adapter is a separate contract.
