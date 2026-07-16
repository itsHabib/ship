# `@ship/driver`

Strict input contract for work-driver `driver.md` manifests (`driver_version: 1`).

This package parses and validates the YAML frontmatter produced by `/work-driver-prep` into typed structures with actionable, line-precise errors. It is the single entry point consumed by later driver-extraction phases (store import, batch walker).

See [docs/features/driver-extraction/spec.md](../../docs/features/driver-extraction/spec.md) for the full design.

## Public surface

- `parseManifest(text)` — parse a manifest string; never throws
- `DriverManifest`, `ManifestBatch`, `ManifestStream` — typed manifest shapes
- `driverManifestSchema`, `manifestBatchSchema`, `manifestStreamSchema` — zod schemas for hydration

## Repo dispatch policy (`.ship.json`)

A repo can pin dispatch policy in-tree with a `.ship.json` at (or above) the manifest's directory, discovered by walking up to the repo root (the directory holding `.git`):

```json
{
  "runtime":  { "default": "local",  "allow": ["local"] },
  "provider": { "default": "claude", "allow": ["claude"] }
}
```

Both top-level keys are optional; within each, both `default` and `allow` are optional.

- **`default`** fills a runtime/provider only when neither the stream nor the manifest `default_*` field sets one. Precedence (highest wins): stream field > manifest default > policy default > hardcoded fallback (`local` / `cursor`).
- **`allow`** is a hard ceiling on the *resolved* value. After precedence resolution, a runtime/provider outside the list is rejected — at import, at dispatch pre-flight, and on `flip-cloud` — no matter where the value came from.

A malformed policy file, or a value outside the runtime (`local | cloud | rooms`) or provider enum, is a hard error (fail closed). Unknown keys warn. No `.ship.json` means no constraints — behavior is identical to before.

`loadDispatchPolicy(startDir)` is the pure entry point; `import`/`engine` call into it.

## Boundaries

This package is leaf-level (yaml + zod only). It does not touch the store, ship runs, or CLI/MCP surfaces. `@ship/receipt`'s lenient manifest adapter is a separate contract.
