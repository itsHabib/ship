# Phase 04 impl 03 — CLI flags for cloud runtime

Status: ready for impl
Owner: ship (cursor)
Date: 2026-05-18

> Parent design: [04-cursor-cloud-runner.md](04-cursor-cloud-runner.md) (PR #50). Predecessor impl: PR #51 (`CloudCursorRunner` skeleton, merged 2026-05-18) + PR #52 (`ShipService` routing + MCP schema + handler re-parse, merged 2026-05-18 at `ba4d48e`).

## Scope

**Weighted LOC budget — ~80, "amazing" band.**

- `packages/cli/src/commands/ship.ts` — add cloud-related flags + their translation to `ShipInput.cloud`. ~40 src LOC.
- `packages/mcp/src/mcp.ts` — export `cloudRunSpecSchema` so the CLI can `.parse()` a `--cloud <json>` file at the CLI boundary. **~1 LOC** (re-export only — schema already exists in the file from PR #52's cycle-1 fix).
- `packages/mcp/src/index.ts` — re-export the schema as a value (not just a type). ~1 LOC if needed.
- Tests in `packages/cli/test/ship-command.test.ts` — extend the existing suite. ~80 test LOC (0.5×) = ~40 weighted.

Scope language deliberately allows ripple changes across `@ship/mcp` (one-line schema export) because the CLI needs the schema as a *value* to call `.parse()` on JSON-file input.

## Summary

The MCP tool path (`ship` tool in `@ship/mcp-server`) already accepts `runtime: "cloud"` + `cloud: CloudRunSpec` per PR #52. The CLI surface (`ship ship <docPath>` subcommand) doesn't expose these yet — operators driving cloud runs from the terminal would have to construct an MCP request by hand. This PR adds the CLI mirror per phase 04 design § ED-6.

The CLI is its own input boundary: it doesn't go through the MCP server's `.superRefine` re-parse, so validation belongs here. The `--cloud <path>` JSON-file flag exists for power-user fields (`envVars`, `env.type`) that don't translate cleanly to flags.

## Functional requirements

### F1 — `--runtime <local|cloud>` flag

Optional. Defaults to `local` semantically (omit on the wire so the service applies its own default; don't inject `"local"` from the CLI). Validate via `z.enum(["local", "cloud"])` at flag parse — produce `InvalidArgumentError` for bad values (`"cloud "`, `"Cloud"`, `"remote"`).

### F2 — `--cloud-repo <url>` flag (single-repo per phase scope)

Optional. Maps to `cloud.repos[0].url`. Single-repo enforced this phase by the existing `z.tuple([{...}])` schema; if the CLI accumulates two `--cloud-repo` values, parse fails (caller sees a typed error at the CLI boundary).

For this phase: model `--cloud-repo` as a *single-value* flag (not repeatable). A second `--cloud-repo` overwrites the first per Commander default semantics — that's acceptable single-repo UX. The schema does the final shape enforcement.

### F3 — `--cloud-auto-create-pr` / `--cloud-skip-reviewer-request` boolean flags

Both optional. Each maps to the same-named `cloud.*` field. Defaults: omitted on the wire so the runner applies its own default per F2 of the phase doc (`autoCreatePR: true` for cloud, `skipReviewerRequest` conditional on `autoCreatePR`).

### F4 — `--cloud-env-var KEY=VAL` (repeatable)

Repeatable Commander flag. Accumulates into `cloud.envVars: Record<string, string>`. Each value must split exactly once on `=` into a non-empty key and a (possibly empty) value; otherwise throw `InvalidArgumentError` with the bad arg.

Empty value (`--cloud-env-var KEY=`) is accepted — Cursor's SDK passes the empty string through to the cloud VM. Duplicate keys: last-write-wins (Commander's natural accumulator order).

### F5 — `--cloud <path-to-json>` file flag

Optional. Reads + parses the file's JSON contents, validates with `cloudRunSpecSchema.parse`. Errors:

- File doesn't exist / not readable → `InvalidArgumentError` with the path.
- JSON parse fails → `InvalidArgumentError` with the parse error message.
- Zod parse fails → re-throw the `ZodError` so its multi-issue message reaches stderr.

### F6 — `--cloud <path>` is authoritative when present

When `--cloud <path>` is set, ignore all `--cloud-*` field flags (don't try to merge — keeps the CLI surface small + avoids precedence ambiguity). Document in the help text. The phase doc § ED-6 explicitly supports this pattern: "expose `--cloud` as a JSON-file pointer for power-user flows, and a small set of flags for the common case."

### F7 — Translation to `ShipInput`

When `--runtime cloud` is set OR any `--cloud-*` / `--cloud` flag is set, build `input.cloud: CloudRunSpec` from the resolved spec. When `--runtime cloud` is set but no cloud spec is buildable (no `--cloud-repo`, no `--cloud <path>`), don't synthesize an empty cloud field — let the schema's `.superRefine` fire downstream with its own clean error. The CLI doesn't pre-empt the schema; it just translates.

When `--runtime` is omitted but `--cloud-*` flags are set, still build `cloud: {...}` and forward — the service will route based on `runtime` field (which defaults to local), and the `cloud` field will be silently ignored per F2 of the phase doc ("LocalCursorRunner silently ignores `cloud`"). Some callers may set `--cloud-*` flags without `--runtime cloud` while testing.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| `--cloud-repo` repeatability | single-value flag (last write wins for now) | Repeatable Commander accumulator | Schema's `.tuple([{...}])` enforces single-repo this phase. Repeatable would just lower the error surface; a single-value flag is simpler UX. Multi-repo is a follow-up phase. |
| Flag conflict with `--cloud <json>` | JSON file authoritative; field flags ignored | Merge field-flag overrides on top of JSON | Merge introduces a precedence rule that users have to remember + test. Sticking with "one source wins" keeps the surface small. Operators who need merge behavior craft the JSON file. |
| Validation timing | Eager: parse + validate at CLI flag-resolution time, before factory call | Lazy: forward unvalidated, let service throw | The CLI is the user-facing boundary. Typed errors here produce better UX than ZodErrors deep in the service. The MCP path validates separately. |
| `--cloud-env-var KEY=VAL` parsing | Single `=` split, key required, value can be empty | Allow `=` in the value (split-once semantics) | Single split-once on first `=` is Commander/POSIX-conventional and matches `docker run -e KEY=VAL`. Cursor's `envVars` is `Record<string, string>`; if a value naturally contains `=`, the user can use `--cloud <json>`. |

## Engineering decisions

### ED-1 — Schema reuse, not duplication

`cloudRunSpecSchema` already exists in `packages/mcp/src/mcp.ts` from PR #52's cycle-1 fix. Re-export it from `@ship/mcp`'s public surface (`packages/mcp/src/index.ts`) and use it in the CLI. Duplicating the Zod shape in `@ship/cli` would let it drift; one source of truth.

### ED-2 — Validation lives in `commands/ship.ts`, not a separate helper

Per phase doc § ED-6, the CLI's job is to mirror the MCP tool's input. The flag parsing + spec resolution is small enough (~30 LOC) to live in `commands/ship.ts` directly. A separate `cloud-flags.ts` adds a file boundary for no reuse benefit — only `ship.ts` consumes these flags.

### ED-3 — No CLI-side `runtime` validation when `--runtime` is absent

The CLI doesn't synthesize `runtime: "local"` when the flag is omitted. Forwarding `undefined` lets the service apply its own default — symmetric with how `--thinking` is handled (`parseThinking` returns undefined for unset; CLI never invents a value).

## Validation plan

### Unit tests (added to `packages/cli/test/ship-command.test.ts`)

- `--runtime cloud --cloud-repo <url>` → `input.runtime === "cloud"` + `input.cloud.repos[0].url === <url>`.
- `--runtime local` → `input.runtime === "local"`, `input.cloud` absent.
- `--runtime` absent → `input.runtime` absent (CLI never injects a value).
- `--runtime cloud2` (invalid) → exit 1, stderr names the bad value.
- `--cloud-auto-create-pr` and `--cloud-skip-reviewer-request` → forwarded as booleans `true`.
- `--cloud-env-var FOO=bar --cloud-env-var BAZ=qux` → `cloud.envVars === { FOO: "bar", BAZ: "qux" }`.
- `--cloud-env-var FOO=` → `cloud.envVars.FOO === ""` (accepted).
- `--cloud-env-var KEY` (no `=`) → exit 1, stderr explains the format.
- `--cloud <path>` reads + validates JSON → `input.cloud` matches the file's contents.
- `--cloud <path-that-does-not-exist>` → exit 1, stderr names the path.
- `--cloud <path-with-malformed-json>` → exit 1, stderr includes parse-error position.
- `--cloud <path-with-shape-mismatch>` → exit 1, stderr includes Zod error message.
- `--cloud <path> --cloud-auto-create-pr` → file wins; the flag is silently dropped (or noted in stderr-as-warning — pick whichever lints/reads cleanest).

### `make check` + `pnpm run coverage`

Both must pass locally + on ubuntu/windows CI before declaring the task done. Coverage is the hard CI bar per PR #51's earlier coverage failure.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Commander's `.action()` typing requires the `ShipOpts` interface to grow significantly | TypeScript noise without functional gain | Add the new fields as optional and let TS infer; only widen `ShipOpts` to a discriminated union if a downstream check requires it. |
| `--cloud-env-var KEY=VAL=extra` parsing surprises operators | Subtle bug in env-var translation | Split on the *first* `=` only. Document in help text. |
| Zod's `ZodError` from `cloudRunSpecSchema.parse` is verbose on stderr | Operator sees a wall of issues for a typo | Format the error to one line per issue via `err.issues.map(...)`; or just print the default `.toString()` and let the operator see the full context. Default is fine; readability is a follow-up if needed. |

## Out of scope

- Repeatable `--cloud-repo` (multi-repo). Schema enforces single-repo this phase.
- Merge semantics between `--cloud <json>` and `--cloud-*` field flags. File-wins is the rule.
- `--cloud-env` / `--cloud-env-name` flags for `env.type` + `env.name`. Power-users go through `--cloud <json>`.
- CLI-side warnings on `--cloud-*` field flags being silently dropped when `--cloud <json>` is present. Acceptable inline if cheap; otherwise defer.

## Implementation plan

1. **`pnpm install`** in the worktree.
2. Export `cloudRunSpecSchema` from `@ship/mcp`'s `index.ts` (one-line addition).
3. Extend `ShipOpts` in `commands/ship.ts` with the new optional fields.
4. Add the Commander `.option(...)` calls for the new flags.
5. Add a helper `resolveCloudSpec(opts: ShipOpts): CloudRunSpec | undefined` that:
   - Returns the parsed JSON file if `--cloud <path>` is set, else
   - Builds a `CloudRunSpec` from the individual flags, else
   - Returns undefined.
6. Add a helper `parseRuntime(raw)` mirroring `parseThinking`.
7. Validate the resolved `CloudRunSpec` (either path) against `cloudRunSpecSchema.parse` — for the file path, this is the boundary check; for the flag-build path, it's defense-in-depth (`runtime: "cloud"` without `repos[0].url` will fail).
8. Translate to `factory().ship(...)` input.
9. Add the tests per Validation plan.
10. Run `pnpm run coverage` locally; verify green.
11. Run `make check` locally; verify green.
12. Commit + push.

## Acceptance

- `make check` green on ubuntu + windows CI.
- `pnpm run coverage` green (the hard CI bar).
- New tests pass; no regressions on existing `ship-command.test.ts` (10 existing tests).
- Diff stays under the "amazing" 500-LOC band.
- Commit trailer per `@ship/cursor-runner` convention.
