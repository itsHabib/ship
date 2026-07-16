**Status**: draft
**Owner**: @michael
**Date**: 2026-07-15
**Related**: dossier task `repo-dispatch-policy-file` (id: `tsk_01KXMMF0R0NEAX2JM1F5MZV8G5`)

# Repo-level dispatch policy file (`.ship.json`) — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/driver/src/policy.ts` (new), `import.ts`, `engine.ts` | ~200 | 200 |
| Tests | `policy.test.ts` (new), `import.test.ts`, `engine.test.ts` additions | ~250 | 125 |
| Docs | README section | ~40 | 0 |
| **Total** | | | **~325** |

Band: **amazing** (< 500) per repo PR sizing.

## Goal

Give a repo a way to pin driver dispatch policy in-tree. Today dispatch runtime/provider
resolve from manifest frontmatter with hardcoded fallbacks (`runtime: "local"` in
`import.ts`, `DEFAULT_DISPATCH_PROVIDER = "cursor"` in `engine.ts`). There is no
repo-level control. For repos that must never dispatch to a cloud backend or a
non-approved provider (e.g. an employer repo where work must stay on the local session
and account), a *default* is not enough — any generated manifest can override it. The
safety property requires a hard **allowlist ceiling** that no manifest value can exceed.

## Behavior

A `.ship.json` file at the repo root:

```json
{
  "runtime":  { "default": "local",  "allow": ["local"] },
  "provider": { "default": "claude", "allow": ["claude"] }
}
```

Both top-level keys optional; within each, both `default` and `allow` optional.

- **`default`** fills in when neither the stream nor the manifest `default_*` field sets
  a value. Precedence (highest wins): stream field > manifest `default_runtime` /
  `default_provider` > `.ship.json` default > hardcoded fallback (`local` / `cursor`).
  Explicit manifest values beat the policy default — the policy default is a
  convenience, not an override.
- **`allow`** is a hard ceiling on the *resolved* value: after precedence resolution,
  a runtime/provider outside the list is an error, no matter where the value came from
  (stream field, manifest default, policy default — a policy `default` outside its own
  `allow` is a policy-file validation error).

### Discovery

Walk up from the manifest's directory to the repo root (stop at the directory containing
`.git`, or filesystem root), taking the **first** `.ship.json` found. Absent file → no
constraints, behavior identical to today (zero migration for existing repos).

### Validation of the policy file itself

- Malformed JSON, or values outside the known runtime/provider enums → **hard error**
  naming the policy file path. A broken policy file must never silently fall back to
  unconstrained dispatch (fail closed).
- Unknown top-level or nested keys → warning (consistent with manifest unknown-key
  handling), not an error.
- Runtime enum: the manifest's runtime schema (`local | cloud | rooms`). Provider enum:
  the manifest's provider schema.

### Enforcement points (all three; each is an existing chokepoint)

1. **`importManifest`** (`packages/driver/src/import.ts`) — load the policy relative to
   the manifest path; apply `default`s in the precedence order above when computing each
   stream's stored runtime/provider; reject any resolved value outside `allow` with an
   error in the existing manifest-validation style (name the policy file path, the
   stream, and the offending value). Rejection happens before anything is inserted into
   the store.
2. **`collectStreamPreflightErrors`** (`packages/driver/src/engine.ts`) — re-check the
   stream's stored runtime/provider against the policy at dispatch time (same place the
   `rooms` runtime is already rejected), so a stream that reached the store by any other
   path still cannot dispatch past the ceiling. Policy is re-loaded from the run's
   manifest path here.
3. **`flipStreamToCloud`** (`packages/driver/src/engine.ts`) — refuse the flip when
   `"cloud"` is not allowed by `runtime.allow`. This is the one verb that mutates a
   stream's runtime after import; without this check an import-only guard has a hole.

## Acceptance

- A manifest in a repo whose `.ship.json` has `"runtime": {"allow": ["local"]}` and a
  stream with `runtime: cloud` fails at import with an error naming `.ship.json` and the
  stream.
- The same repo: `driver flip-cloud` on an imported local stream is refused.
- A repo with no `.ship.json` behaves byte-for-byte as today (existing tests unaffected).
- A repo whose `.ship.json` sets only `provider.default: claude`: a manifest with no
  provider fields dispatches with provider `claude` instead of the hardcoded `cursor`.

## Test plan

- `policy.test.ts`: discovery walk-up (found at root / found mid-path / absent), malformed
  JSON hard error, unknown-key warning, default-outside-own-allow error.
- `import.test.ts` additions: default precedence (stream > manifest default > policy
  default > fallback), ceiling rejection at import, absent-file passthrough.
- `engine.test.ts` additions: preflight ceiling rejection for a store-resident stream,
  `flipStreamToCloud` refusal when cloud not allowed.

## Non-goals

- No env-var policy (`ANTHROPIC_BASE_URL` forbids etc.) — future follow-up if it bites.
- No model/effort/tier constraints — runtime + provider only.
- No CLI verb to generate or lint `.ship.json`.
- No change to the ship MCP tools' behavior beyond what flows through the shared
  `DriverService` paths.

## Engineering notes

Follow the repo's engineering principles (no `else`, ≤2 nesting per scope, policy vs
mechanism). The policy module is pure policy: `loadDispatchPolicy(startDir)` returning a
typed object + `resolveWithPolicy(...)` helpers; import/engine stay mechanism and call
into it. Keep the exported surface minimal.
