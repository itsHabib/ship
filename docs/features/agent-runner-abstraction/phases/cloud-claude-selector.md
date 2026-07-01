# Phase 3c — Legalize `(claude, cloud)`: CloudRunSpec + selector + wiring + MCP/CLI schema

> **Shipped** combined with 3b (`cloud-claude-branch-reconstruction`) as one PR. FR7 (orphan-resume provider routing) landed as specced: the resumable-row query is provider-agnostic, so the row now carries `provider` and `runResumeAttach` / `resumeCtxAsShipContext` route to `cloudClaude` by it — without this a claude-cloud orphan would attach via the cursor SDK.

**Status:** ready to ship (rebase on 3a + 3b merged)
**Owner:** human:mh (driven by claude-code:michael)
**Date:** 2026-06-27
**Dossier:** project `ship`, phase `agent-runner-claude-cloud`, task `cloud-claude-selector` (`tsk_01KW3NT8PHDHJRYRESFQHXK7P5`, depends_on `cloud-claude-runner`)
**Design:** [`docs/features/agent-runner-abstraction/spec.md`](../spec.md) — §6 (Selection + MCP input + required `prBranch`), §4 D1, §10.12 (cloud attach id-mapping). **Template: PR #154 (claude selector wiring) + the cursor-cloud legalization.**

## Already on `main` — do NOT re-add

- `agentProviderSchema = z.enum(["cursor","claude","codex"])` (`workflow.ts`) ✓ — claude is already a member.
- `selectRunner` has the `(provider, runtime)` capability matrix with `claude: { local: config.claude }` (`service.ts` ~L640) ✓; `ShipServiceConfig.claude?` ✓.
- `default-wiring` constructs `LocalClaudeRunner` for the `claude` slot ✓; `claudeDefaultModel` resolution ✓.
- MCP `refineClaudeProviderRuntime` (claude⇒local guard) + `provider` in `shipInputSchema` ✓; `cloudRunSpecSchema` ✓.
- CLI `--provider claude` + `LOCAL_ONLY_PROVIDERS` guard ✓.
- `agentWatchUrl("claude", …)` returns `undefined` (no claude watch URL) ✓ — leave it.
- Store: `cursor_runs.provider` column + the `runtime='cloud'` resumable query (provider-agnostic) ✓ — no store change.

**What is NOT yet legal (this task):** `(claude, cloud)` throws `IllegalProviderRuntimeError` in `selectRunner` (the `claude` row has no `cloud` key), and the MCP/CLI guards reject it first. This task legalizes + wires the cell end-to-end and routes the existing 3a `CloudClaudeRunner` into it.

## Scope

| Bucket | Files | Weighted |
|---|---|---|
| Production | `core/src/service.ts` (`claude.cloud` matrix row + `ShipServiceConfig.cloudClaude?` + orphan-resume provider routing), `core/src/default-wiring.ts` (`CloudClaudeRunner` import + `cloudClaude` slot), `mcp/src/mcp.ts` (`refineClaudeProviderRuntime` allow cloud + claude×cloud `prBranch` refinement + `prBranch` on `cloudRunSpecSchema` repo), `agent-runner/src/runner.ts` (`CloudRunSpec.repos[*].prBranch?`), `cli/src/commands/ship.ts` (drop claude from local-only + `--cloud-pr-branch` flag + help) | ~180 |
| Tests (0.5×) | `core/src/{service,default-wiring}.test.ts` (claude×cloud selection + FakeAgentRunner end-to-end + orphan-resume routing), `mcp/src/mcp*.test.ts` (claude×cloud legal + prBranch-required refinement + illegal rows), `cli/.../ship-command.test.ts` (`--provider claude --runtime cloud` + `--cloud-pr-branch`) | ~300 raw → ~150 |
| Docs (0×) | this doc | 0 |
| **Total** | | **~330** |

Band: **amazing** (`< 500`). One PR.

## Functional requirements

- **FR1 — `selectRunner` matrix** ([service.ts](../../../../packages/core/src/service.ts) ~L640). Add `cloud: config.cloudClaude` to the `claude` row. The presence-keyed logic already does the rest: configured → returns it; legal-but-unset → `CloudRunnerNotConfiguredError`; still-illegal cells (`claude × rooms`) → `IllegalProviderRuntimeError`. Add `readonly cloudClaude?: AgentRunner` to `ShipServiceConfig` (~L132, doc-comment mirroring `cloudCursor`).
- **FR2 — `default-wiring`** ([default-wiring.ts](../../../../packages/core/src/default-wiring.ts)). Import `CloudClaudeRunner` from `@ship/claude-runner`; add `readonly cloudClaude?: AgentRunner` to `DefaultShipServiceOpts` (JSDoc mirroring `cloudCursor`); `const cloudClaude = opts.cloudClaude ?? new CloudClaudeRunner();`; pass `cloudClaude` into `config`. Tests inject a `FakeAgentRunner`. (`CloudClaudeRunner`'s constructor must stay cheap/lazy-safe — no network at construction — so the lazy factory + `--help` are unaffected; confirm.)
- **FR3 — `CloudRunSpec.repos[*].prBranch`** ([agent-runner/src/runner.ts](../../../../packages/agent-runner/src/runner.ts)). Add `readonly prBranch?: string` to the `CloudRunSpec` repo tuple element (optional in the type; required-by-refinement for `claude × cloud` — FR5). Cursor ignores it (optional). This is the branch 3b prescribes + reconstructs.
- **FR4 — MCP schema** ([mcp.ts](../../../../packages/mcp/src/mcp.ts)).
  - `refineClaudeProviderRuntime` (~L168): allow `runtime === "cloud"` (currently returns early only for `local`). Keep `rooms` rejected (`claude × rooms` is Phase 4).
  - `cloudRunSpecSchema` (~L43) repo object: add `prBranch: z.string().min(1).optional()` (`.strict()` stays).
  - **Keep the core `_CloudKeysMatch` / `_RoomKeysMatch` drift assertions green** ([service.ts](../../../../packages/core/src/service.ts) ~L602) — `prBranch` is on the repo element, not the top-level cloud spec, so the top-level key-set assertion is unaffected; verify it still compiles.
- **FR5 — claude×cloud requires `prBranch`** (cross-field refinement, §6). When `provider === "claude" && runtime === "cloud"`, each `cloud.repos[*].prBranch` must be present + non-empty — a **schema error** (clear message: "claude × cloud requires cloud.repos[].prBranch (the branch the agent pushes)"), not a runtime "branch not found". Add to the schema's `.superRefine` (alongside `refineClaudeProviderRuntime`, or extend it). Cursor cloud does NOT require it (cursor's backend names the branch).
- **FR6 — CLI** ([cli/src/commands/ship.ts](../../../../packages/cli/src/commands/ship.ts)). Remove `"claude"` from `LOCAL_ONLY_PROVIDERS` (~L185) so `--provider claude --runtime cloud` passes the CLI guard (codex stays local-only). Update the `--runtime` help (~L60) to drop "cloud is cursor-only". Add a `--cloud-pr-branch <name>` flag that sets `cloud.repos[0].prBranch`; the CLI surfaces the schema error if it's omitted for claude×cloud. (The dogfood drive uses cursor cloud and won't pass it; a real claude-cloud run does.)
- **FR7 — orphan-resume routes by provider** ([service.ts](../../../../packages/core/src/service.ts) `resumeOrphanedRuns`). The resumable-cloud query is provider-agnostic, so it now returns claude-cloud rows too. The resume dispatch must call `attach()` on the runner selected by the **row's `provider`** (+ `runtime: "cloud"`) — i.e. route a `provider:"claude"` row to `cloudClaude.attach()`, not `cloudCursor.attach()`. Reuse `selectRunner(config, row.provider, "cloud")` (or an equivalent cloud-by-provider lookup). Verify the current resume path's runner selection and fix it if it hardcodes the cursor cloud runner. A claude-cloud orphan with no `cloudClaude` wired → resume-failure (finalized), not a crash.

## Engineering decisions

- **ED-1 — legalize only `(claude, cloud)`.** `claude × rooms` stays illegal (Phase 4). The selector/MCP/CLI all keep rejecting it; only the cloud cell opens.
- **ED-2 — `prBranch` is schema-required for claude×cloud, optional in the type.** The type stays permissive (cursor shares `CloudRunSpec`); the requirement is enforced at the provider×runtime boundary where it applies. Fail at schema time, not runtime (spec §6 / review).
- **ED-3 — secrets are NOT in the schema.** The GH PAT + GitHub-MCP endpoint are sourced by the runner from env/wiring (3a/3b), never the per-task MCP input (it's a logged tool call). The schema carries only `prBranch` (non-secret). This keeps the `no-confidential-in-public` + secret-handling rules intact.
- **ED-4 — reuse `selectRunner` for resume routing** (FR7). One selection function for both dispatch + resume keeps the matrix the single source of truth; no parallel cloud-runner switch.
- **ED-5 — no new store/migration.** The `provider` column + provider-agnostic resumable query already cover claude-cloud rows; `recordCursorRun({ provider: "claude", runtime: "cloud", agentId: <sessionId>, runId: <sessionId> })` round-trips with no schema change (add a store round-trip test for the claude-cloud row to lock it).

## Validation

- **L3 (CI) — the gate.** `ship.ship { provider:"claude", runtime:"cloud", cloud:{ repos:[{ url, prBranch }] } }` with a `FakeAgentRunner` wired into the `cloudClaude` slot drives the full service path → dispatch → terminal → a reconstructed `branches[0]` → `succeeded`. (The fake returns a `branches[0]`; 3a/3b own the real reconstruction.)
- **Selection (FR1).** `claude × cloud` returns `cloudClaude` when set; `CloudRunnerNotConfiguredError` when unset; `claude × rooms` → `IllegalProviderRuntimeError`. Cursor + codex + claude-local cells unchanged.
- **MCP (FR4/FR5).** `claude × cloud` with `prBranch` validates; without `prBranch` → schema error; `claude × rooms` → rejected; cursor×cloud unchanged (no prBranch required). The `_CloudKeysMatch` assertion compiles.
- **CLI (FR6).** `--provider claude --runtime cloud --cloud-pr-branch x` builds a valid `ShipInput`; omitting `--cloud-pr-branch` → schema error surfaced; `--provider claude --runtime local` still works; codex×cloud still fails fast.
- **Orphan-resume (FR7).** A persisted `provider:"claude", runtime:"cloud"` orphan row routes to `cloudClaude.attach()` (assert via a spy/fake), not `cloudCursor`.
- **Store round-trip (ED-5).** `recordCursorRun → getCursorRun` for a `provider:"claude", runtime:"cloud"` row.
- **`make check` green ubuntu + windows incl. coverage.** All existing cursor/claude-local/codex suites pass unmodified.

## Risks

- **Orphan-resume runner mis-routing** (FR7) — the highest-value correctness check. If the existing resume path hardcodes the cursor cloud runner, a claude-cloud orphan would attach with the wrong SDK. The provider-routed `selectRunner` reuse fixes it; the spy test locks it. **Read the current `resumeOrphanedRuns` runner-selection before editing.**
- **`_CloudKeysMatch` drift** — adding a top-level field to `CloudRunSpec` (vs the repo element) would break the assertion; `prBranch` is intentionally on the repo element to avoid it. Confirm the assertion still compiles after the change.
- **CLI flag ergonomics.** `--cloud-pr-branch` is claude×cloud-only; for cursor cloud it's ignored. Document it in the flag help as claude-cloud-specific to avoid confusion.

## Out of scope

- The `CloudClaudeRunner` adapter + branch reconstruction — **3a/3b** (this routes to them).
- Rooms (`claude × rooms`, Phase 4); codex cloud (not viable).
- The `cursor_runs` → `agent_runs` table rename (deferred hygiene).
- Cloud cancel idempotency hardening (§10.13) — the reused single-`cancel()` state machine + 3a's interrupt→archive is the V1 behavior; the two-step-retry nuance is deferred unless the L4 surfaces it.

## Implementation plan (PR boundary = this whole task)

1. Rebase on 3a + 3b (`CloudClaudeRunner` + reconstruction merged).
2. `agent-runner/src/runner.ts` — `CloudRunSpec.repos[*].prBranch?`.
3. `core/src/service.ts` — `claude.cloud` matrix row + `ShipServiceConfig.cloudClaude?` + orphan-resume provider routing (read the current path first).
4. `core/src/default-wiring.ts` — `CloudClaudeRunner` import + `cloudClaude` slot.
5. `mcp/src/mcp.ts` — allow claude×cloud + `prBranch` on the repo schema + the claude×cloud-requires-prBranch refinement.
6. `cli/src/commands/ship.ts` — drop claude from local-only + `--cloud-pr-branch` + help.
7. Tests: selection (legal/unset/illegal), MCP (legal + prBranch-required + illegal), CLI (flag/guard), orphan-resume routing spy, store round-trip, the FakeAgentRunner end-to-end claude×cloud run.
8. `make check` green (ubuntu + windows incl. coverage). Run `code-reviewer` + `validator` before the structured summary.
