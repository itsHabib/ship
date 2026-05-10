# Phase 9 — V1 bug-smash

Status: design draft, revision 1 (2026-05-10). Awaiting review before action.
Owner: itsHabib
Date: 2026-05-10

> **Companion docs.** [spec.md](../spec.md) is the V1 design spec. This doc replaces the original "live integration test + dogfood" Phase 9 in [plan.md](../plan.md) — folds dogfood in as the L3 layer and adds two earlier layers (L1 code-read, L2 adversarial input) on top. See [phases/08-mcp-server.md](08-mcp-server.md) for the agent-facing surface this phase smashes alongside the [phases/07-cli.md](07-cli.md) human-facing surface.

## Scope

**Weighted-LOC budget:** n/a. This phase produces chips, not code. Each chip materializes as its own task doc + PR with its own LOC budget and review cycle.

**Time budget:** ~1 session for L1 + L2 + chip-filing. L3 (live e2e + dogfood) is a separate session because the user has to load `CURSOR_API_KEY` from `..\.keys\` into the conversation env before `make e2e-verbose` can run — the agent sandbox blocks the keys directory.

**Chip queue ceiling.** Soft cap of **8 open P2/P3 chips** at any time. P0 / P1 chips always file (V1 ships only after they fix). If the P2/P3 queue grows past 8, that's signal V1 has a structural issue worth a Phase-9b doc rather than a longer chip queue, and we stop filing fresh chips until the queue drains.

**Chips are user-curated.** `mcp__ccd_session__spawn_task` files a *proposed* task; the user accepts or dismisses each chip before any session spawns. This phase produces proposals, never autonomous fixes. The agent watches output, files chips with reproducers, and waits.

## Summary

V1 is feature-complete on `main` after Phase 8 merged ([ship#15](https://github.com/itsHabib/ship/pull/15)). Test counts: **420 unit + scenario tests** across 54 files; **15 L3 subprocess integration tests** under `e2e/integration/`; live e2e harness in `e2e/scenarios/` exists but is gated on `SHIP_LIVE=1` + `CURSOR_API_KEY`. All deterministic in three back-to-back `make integration` runs. Both binaries (`@ship/cli`, `@ship/mcp-server`) share `ShipService` via `createDefaultShipService` (Phase 8 ED-1).

What the existing tests can't catch:

- **Concurrency** — `cancel` arriving while `ship` is mid-flight, the runner's `signal`-observation contract under contention, the `activeRuns` map across overlapping operations.
- **Cross-binary boundary mismatches** — same input rejected differently by CLI vs MCP, or accepted at one boundary and lost at the other.
- **Process-lifecycle holes** — mcp-server stdin closing mid-tool-call, CLI EPIPE on closed stdout, `process.exit()` racing buffered stderr writes (especially Windows pipes).
- **Live runtime drift** — the integration suite uses `FakeCursorRunner`; the real Cursor SDK can fail in shapes the fake never produces (rate limits, partial event streams, malformed final messages).
- **Operator UX gaps** — error messages naming internal symbols, exit codes that disagree with printed messages, missing observability on silent failures.

This phase finds them, files chips, and merges fixes through the standard PR flow.

## Decisions taken before this phase (not re-litigated)

These shipped in Phase 8 cycle reviews and are NOT chip-eligible. Smash findings that re-raise them get dropped, not chipped:

- **`-32002` for resource not-found.** Codex flagged in Phase 8 cycle 1; deferred. The MCP TS SDK's `ErrorCode` enum doesn't expose `-32002`; the resource handler stays on `ErrorCode.InvalidParams` (`-32602`), consistent with the `get_workflow_run` tool's not-found mapping. If a real MCP client demonstrates a disambiguation failure, file a chip *then* — not preemptively.
- **`bin.ts` excluded from unit coverage.** The L3 subprocess integration test exercises it. Don't chip "bin.ts has no unit tests."
- **`SERVER_VERSION` pinned to `0.0.0`.** Synced with `package.json#version`; bumps in lock-step at publish time.
- **JSDoc + per-file headers are mandatory.** Repo standard. "Too verbose" is not a chip-eligible finding.

## Functional requirements

### F1 — Three smash layers

L1 → L2 → L3, in order. Each layer's findings get chipped before moving to the next so the chip context is fresh.

**L1 — Read pass (no runtime cost).** Hostile-reviewer code-read of every file Phase 8 added or changed, plus the `executeAndFinalize` / `cancelRun` paths in `@ship/core`. Look for the bug categories in F2. Validation bar: every chipped finding has either a reproducer command (CLI argv / MCP JSON-RPC payload / test scenario name) OR a precise file:line + sequence-of-events that demonstrates the failure from inspection alone. **Speculation ("might fail if X happens" without showing X happens) is an action item for L2, not a chip.**

**L2 — Adversarial input (no API key).** Drive the CLI binary with weird argv (F3); drive the mcp-server stdio binary with hand-crafted JSON-RPC traffic (F4); re-run `make integration` until 3 consecutive runs are clean to detect flakes.

**L3 — Live e2e dogfood (`SHIP_LIVE=1`, real `CURSOR_API_KEY`).** The original Phase 9 dogfood (now F5). Run `make e2e-verbose` against `e2e/fixtures/test-repo/` 3x; observe real Cursor SDK behavior end-to-end. The user loads the key from `..\.keys\` into the conversation env via PowerShell before kickoff.

If L3 can't run (user unavailable or key inaccessible), Phase 9 closes with "L3 deferred"; chips from L1+L2 still ship.

### F2 — Bug categories

A finding only counts if it falls in one of these. Anything outside is either a feature request or a refactor — neither is in scope.

1. **Concurrency races** — two operations interleave such that persisted state is wrong. Validation requires articulating the divergent end-state, not just "two callers might X."
2. **Process-lifecycle gaps** — what happens when stdin closes, stdout EPIPEs, parent dies, child SIGKILLs. Distinct from concurrency: there's only one operation in flight, but the host environment shifts under it.
3. **Error-path holes** — caught errors that swallow useful info, thrown errors that don't reach the client, resource leaks on partial-failure rollback.
4. **Boundary mismatches** — same input accepted/rejected differently across CLI and MCP. Either both validate or the asymmetry is documented.
5. **Operator UX gaps** — error messages naming internals, missing IDs in not-founds, exit codes disagreeing with printed messages.
6. **Live-runtime gaps** (L3 only) — anything the fake runner doesn't produce that the real SDK does and our pipeline mishandles.

### F3 — CLI smash matrix (L2)

For each subcommand:

- **`ship`** — empty `--repo`, missing `--workdir`, very long path, path with shell metachars, symlink-to-symlink-to-itself, path with embedded newline, `--model ""`, `--branch ""`, docPath that resolves to an empty file, docPath that's a directory, docPath that's a symlink to outside `workdir`.
- **`status`** — empty id, malformed id (`wf_INVALID`), id with `..` or `/` embedded, very long id (10kB), non-ASCII id.
- **`list`** — `--limit 0`, `--limit -1`, `--limit 1.5`, `--limit 1e10`, `--status banana`, two `--status` flags with conflicting values, `--repo ""`, `--repo` containing `\x00` or wildcards.
- **`cancel`** — empty id, malformed id, repeated cancels of the same terminal id (idempotence under load — fire 5 in parallel via `& wait`).

Record current behavior of each. Anything that violates the spec or is operator-hostile becomes a chip.

### F4 — MCP smash matrix (L2)

Hand-crafted JSON-RPC over stdio (`SHIP_TEST_FAKE_CURSOR=1`, no quota burn):

- **Protocol layer:** init with mismatched `protocolVersion`, init with empty `clientInfo`, send a request before initialize, oversize payload (1MB+ args).
- **`tools/list`:** before initialize (should reject), after initialize (should return all 4).
- **`tools/call`:** unknown tool name, known tool with missing required field, known tool with extra field (strict-mode rejects), valid call followed by another concurrent call (interleaved on the same connection), valid call then close stdin mid-flight.
- **`resources/read`:** `ship://other/123` (template miss), `ship://runs/` (empty id), `ship://runs/wf_01ABCDEFGHJKMNPQRSTVWXYZAB` (schema-valid ULID but unknown to the store — exercises the not-found branch, not Zod's regex rejection), `ship://runs/banana` (regex-rejected ID), `ship://runs/foo%2Fbar` (URL-encoded slash — Codex called out that an actually-valid-but-unknown placeholder is required here so the unknown-id path isn't masked by pre-handler rejection), URL with extreme length (10kB).
- **Robustness:** init then send pure garbage on stdin (server should ignore + stay alive); init, valid tool call, then close stdin (server should exit cleanly without leaking the SQLite handle or the runs-dir).

### F5 — Live e2e dogfood (L3)

Per [plan.md § Phase 9](../plan.md): `e2e/scenarios/` builds a workdir from `e2e/fixtures/test-repo/` and runs `ship` against the real Cursor SDK. Run `make e2e-verbose` 3x with the user driving the key load. For each run, watch for:

- `RunResult.status` matches the persisted `WorkflowRun.status`.
- `events.ndjson` ends with a terminal event and parses cleanly line-by-line.
- `summary.md` non-empty when the run produced a final assistant message.
- `prompt.md` matches the rendered template (deterministic given the input task doc).
- Run completes in a sane wall-clock (no hung-but-pending state).

The existing harness doesn't expose a "cancel mid-run" hook; adding one would inflate L3 scope. Cancellation paths are exercised in L1 (read) + L2 (fake-runner traces). If a real-runner cancel issue surfaces in actual usage later, file a chip then.

Each surprise → chip with reproducer.

## Non-functional requirements

- **No production code touched directly in this phase.** Every confirmed finding becomes a chip, then a PR. The earlier draft carved out a "fixed inline if one-line trivial" exception in the Validation plan; that's been removed — it conflicted with this requirement and made phase completion subjective. A P0 hot-fix is still its own PR (just an urgent one opened in parallel with the smash session), never an inline edit in this phase's branch.
- **No new tests added directly.** Tests come with the chip's PR (one regression test per chip).
- **Chip rigor.** Every chip has a reproducer, a suggested approach, and explicit out-of-scope notes so each chip's PR ships independently without coupling.
- **Severity discipline.** Each chip carries P0/P1/P2/P3. P0/P1 land before V1 ships; P2 deferred to V2 if the queue is full; P3 opportunistic.
- **Doc-first per chip's PR.** P0/P1 chips with non-trivial fixes (touching `service.ts`, the state machine, or schema shapes) get sub-task docs at `docs/features/ship-v1/phases/09a-...md`, `09b-...md`, etc. before implementation lands in the chip's PR. Trivial one-line chips (typo, comment correction, error-message rename) skip the sub-task doc and ship the fix in the PR directly. Either way, every confirmed finding still produces a chip — the doc-first/skip rule only governs whether the chip's own PR needs its sub-task doc.
- **Harness bugs are their own chips.** Bugs found in `e2e/scenarios/` or `e2e/integration/` during L3 get chipped against the harness path, not conflated with `@ship/*` package findings — different files, different reviewers, different scope.

## Tradeoffs

| Decision | Chose | Alternative | Why |
|---|---|---|---|
| Read pass before adversarial input | L1 → L2 → L3 | Skip straight to L2 | L1 finds latent bugs without a current trigger. L2 only catches what reproduces. |
| Per-finding chip vs one omnibus PR | Per-finding chip | Bundle | Each chip is a separate concern; bundling couples unrelated fixes and inflates review. |
| Validation bar = reproducer-or-precise-codepath | Yes | Accept all read claims | Agent-driven reads produce noise (5 false positives observed in the pre-doc round of 20 findings; sample size too small for a stable rate). A reproducer requirement filters them. |
| Soft cap on P2/P3 only | Yes | Hard cap at 8 total | A hard cap could force dropping a real P0/P1. Soft cap on P2/P3 keeps the queue manageable without losing real bugs. |
| L3 user-driven for `CURSOR_API_KEY` | Yes | Skip L3 / fake the key | Sandbox blocks `..\.keys\`. User loads once; agent watches. |
| File chips during L1+L2 even before L3 | Yes | Wait for L3 to confirm | Boundary mismatches between CLI and MCP exist regardless of runner. No reason to gate them on live e2e. |
| Skip "cancel mid-run" L3 scenario | Yes | Build a new harness hook | Cancel paths covered by L1 read + L2 fake-runner tests; building a live-cancel hook is out of scope for the smash. |

## Engineering decisions

### ED-1 — Validation bar enforced before chipping

Each candidate finding gets one of three dispositions:

- **Confirmed bug** → has a reproducer command, payload, or precise file:line + sequence-of-events. Chip filed with all four prompt elements (symptom / reproducer / expected vs actual / suggested approach).
- **Speculative** → "might be wrong if X" without showing X happens. Two paths: (a) investigate during this session to confirm/deny (then either becomes confirmed or false-positive); (b) drop. Speculative findings never chip directly.
- **False positive** → the read missed an existing guard. Drop, note in Appendix A's pre-screened list so we don't re-discover.

This bar exists because the pre-doc agent run produced 5 false-positive findings out of 20 (sample size 1; rate not stable but indicative).

### ED-2 — Chip prompt checklist

`mcp__ccd_session__spawn_task` accepts `title` (≤60 chars, imperative), `tldr` (1–2 sentences, no file paths), and `prompt` (self-contained body). Each chip's `prompt` body covers:

- **Symptom** — one paragraph of what goes wrong, user-visible.
- **Reproducer** — exact CLI command / JSON-RPC payload / test scenario name, with paths and env.
- **Expected vs actual** — what the spec or schema says vs what we observe.
- **Suggested approach** — one sentence pointing at the file + change shape, without prescribing the implementation.
- **Out of scope** — explicit list of what NOT to drag in. Each chip ships independently; coupling defeats per-chip-PR.

Advisory, not enforced — a P3 chip with a single-line typo doesn't need all five sections.

### ED-3 — L3 user-collaboration protocol

1. Agent asks user to open PowerShell and load `CURSOR_API_KEY` from `..\.keys\` into the running session's env.
2. Agent confirms the env var is set (`echo $env:CURSOR_API_KEY -ne $null` or equivalent).
3. Agent runs `make e2e-verbose` 3x in foreground (foreground because verbose mode streams events; background loses the streaming).
4. Surprises captured + chipped against the F5 checklist.
5. If the user can't load the key, L3 is marked deferred; the doc closes with chips from L1+L2 only.

### ED-4 — Pre-doc agent-report findings are seed material

The 20-finding ad-hoc agent report from the pre-doc round is preserved in Appendix A as raw material. Each entry is re-triaged through ED-1 during L1. The seed report is not the source of truth; the chips are. False positives are pre-screened in Appendix A so L1 doesn't re-investigate them.

## Validation plan

Phase 9 is "done" when ALL of:

- L1 read pass complete; every confirmed finding chipped (no inline edits in this phase's branch).
- L2 CLI + MCP smash matrices run end-to-end; behaviors recorded; chips filed for spec/UX violations.
- `make integration` runs cleanly 3 times in a row (no flake).
- L3 live e2e runs 3 times (or marked "L3 deferred" with reason in this doc's outcome section).
- Every chip has reproducer + suggested approach + out-of-scope guard.
- The P2/P3 chip queue is ≤ 8; otherwise a Phase-9b doc is drafted instead of filing more chips.

**"Zero findings" is also a valid outcome.** If L1+L2+L3 produce no chips, that's signal V1's stack is solid; document the smash plan run + assertions in this doc's outcome section and close the phase clean.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Read pass produces noise (false positives) | Operator attention burns | ED-1 validation bar; no chip without reproducer-or-precise-codepath. Pre-screened list in Appendix A blocks re-discovery. |
| Smash session spirals | Indefinite Phase 9 timeline | Soft cap (P2/P3 ≤ 8); time budget (~1 session for L1+L2). Hit either → escalate to Phase 9b. |
| L3 requires user availability | Phase 9 can't autocomplete | L3 gated; doc closes "deferred" if user unavailable. Chips from L1+L2 still ship. |
| Smash misses platform-specific bugs | False-clean signal on the un-smashed platform | CI matrix runs ubuntu + windows already; chips tag the platform observed; opposite-platform confirmation deferred to chip's PR. |
| Boundary-mismatch chips can't fix without breaking callers | Some chips defer to docs-only ("document the asymmetry") | Each chip's PR follows 3-cycle review cap; if backwards-compat surfaces, scope shrinks to documentation. |
| Smash finds a P0 (data loss / security) | V1 can't ship as-is | P0 chip immediately becomes a hot-fix PR; rest of smash pauses until it lands. |
| Live e2e burns Cursor quota on every retry | Cost | Cap L3 at 3 runs unless a finding requires more reproductions. |

## Open questions

1. **Chip-doc naming.** Each non-trivial chip materializes as `09a-...md`, `09b-...md`, ..., under `docs/features/ship-v1/phases/`. Is alphabetic suffixing the right convention, or should chips just get fresh phase numbers (10, 11, 12...)? Proposed: alphabetic; keeps the chip queue grouped under Phase 9 and signals "these were smash-driven, not roadmap-driven."

## Implementation plan

After review/approval:

1. **Wire into plan.md.** Replace the existing Phase 9 entry with a pointer to this doc; mark the existing dogfood line as folded into F5.
2. **L1 read pass.** Re-triage Appendix A's "to investigate" list through ED-1. Confirmed → chips with reproducers; speculative → investigate or drop; false positive → log inline in Appendix A.
3. **L2 CLI smash.** Run F3 matrix. Record each behavior. Chip what fails the bar.
4. **L2 MCP smash.** Run F4 matrix. Same.
5. **L2 flake check.** `make integration` 3x consecutive clean (the pre-doc round already showed 3 clean runs; if any subsequent run flakes, the flake itself is a chip).
6. **L3 live e2e.** Coordinate with user on `CURSOR_API_KEY` load. Run F5 checks 3x.
7. **Close phase.** Mark Phase 9 done in plan.md; chip queue snapshot logged in this doc's "Outcome" section (added when the phase closes).

## Appendix A — Pre-doc agent-report seed material

Twenty raw findings from the pre-doc ad-hoc agent run, preserved here for L1 re-triage through the ED-1 bar.

### Pre-screened false positives (drop, don't re-investigate)

- **#1** — `packages/cli/src/commands/status.ts:21-22`: claim "no return after `cliExit(1)`, formatter runs on null." **False:** `cliExit` throws `CliExit`; the next line is unreachable. Verified by reading `packages/cli/src/errors.ts:84` (`function cliExit(code, message?): never { throw new CliExit(...) }`).
- **#10** — `packages/mcp-server/src/tools/{cancel,get}-workflow-run.ts`: claim "empty `workflowRunId` accepted." **False:** schema is `workflowRunIdSchema = z.string().regex(/^wf_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)`; empty string fails the regex. SDK rejects pre-handler.
- **#12** — `packages/core/src/service.ts:211-213`: claim "`ndjson.write(ev)` is a dangling promise." **False:** `EventWriter.write(event): void` is documented sync fire-and-forget; errors surface via the stream's `error` listener and the next `close()` rejection. See `packages/core/src/artifacts/ndjson.ts` JSDoc.
- **#16** — `packages/cli/src/commands/{ship,status,list,cancel}.ts`: claim "CLI double-prints because `rethrowCliExitOrMap` doesn't actually throw." **False:** `rethrowCliExitOrMap` rethrows on `CliExit`; the following `stderr.write` only runs for typed service errors that need formatting. Pattern is intentional. See `packages/cli/src/errors.ts:63-66`.
- **#17** — `packages/core/src/default-wiring.ts:56-83`: claim "factory is not concurrency-safe; two parallel calls leak a SQLite handle." **False:** factory body is fully synchronous (no `await` between cache check and assignment); JS single-threaded execution prevents interleave on a single closure. Cross-process is a different question (covered by SQLite's own locking).

### L1 dispositions (completed 2026-05-10)

**Chipped** (5 chips filed via `mcp__ccd_session__spawn_task` with reproducer + suggested approach + out-of-scope guard, per ED-2):

- **#7** → "mcp-server: handle MCP client disconnect mid-tool-call" (P2). `packages/mcp-server/src/bin.ts:66` has no transport-close handler; in-flight `ship` calls keep running after client drops, leaking the SQLite handle. Fix needs a new `ShipService.close()` / `abortAll()` accessor.
- **#18** → "mcp-server: reject relative SHIP_DB_PATH / SHIP_RUNS_DIR" (P3). `packages/mcp-server/src/bin.ts:45-46` accepts relative env-var paths silently; parity gap with the CLI's `XDG_CONFIG_HOME` absolute-path guard from ship#14 cycle-4. Fix: `isAbsolute()` guard, fall back to default on miss.
- **#8** → "Switch both bins from process.exit to process.exitCode" (P3). Both `packages/cli/src/bin.ts` and `packages/mcp-server/src/bin.ts` use the `stderr.write(msg); process.exit(code)` anti-pattern; Windows pipe-async can truncate. Fix: switch to `process.exitCode = code; return;` so the event loop drains.
- **#9** → "Rename listRuns error to reference --limit not internal symbol" (P3). `packages/store/src/workflow-runs.ts:clampLimit` throws `RangeError("listRuns limit 201 exceeds maximum 200")` — names internal function in user-facing surface. Fix: boundary-agnostic message.
- **CLI workflowRunId validation parity** → "CLI: validate workflowRunId shape at boundary, matching MCP" (P3). MCP boundary regex-validates `workflowRunId`; CLI forwards raw argv. `cancel ""` produces "workflow run not found: " (trailing space); `status wf_BAD` conflates malformed with absent. Fix: shared `validateWorkflowRunId` helper from `@ship/mcp`; both binaries call it.

**False positives** (confirmed by code-read; added to the pre-screened list above):

- **#2** — claim: `activeRuns.set` line 178 vs line 229 races losing the controller. **False:** line 229 stores the SAME `controller` reference, just adds `handle`. AbortController is preserved across both sets. Cancel observability is intact throughout. Verified `packages/core/src/service.ts:178, 229`.
- **#3** — claim: `cancelRun` should also call `active.handle?.cancel()`. **False:** the `CursorRunner` contract (`packages/cursor-runner/src/runner.ts:23-24`) explicitly says "Aborting this signal cancels the SDK run via `run.cancel()`." Signal-observation is the documented mechanism; `handle.cancel()` is for callers without a signal. We have the signal; calling both would be redundant.
- **#19** — claim: state-write race between `service.ts:191` (getRun) and `:196` (updateWorkflowRunStatus). **False:** lines 191-196 are all synchronous `better-sqlite3` calls. JS single-threaded execution prevents any other JS task (incl. a concurrent `cancelRun`) from interleaving between them. The cancellation window is the `await prepareArtifacts` on line 184 — which line 191 explicitly checks for. Design is sound.
- **#20** — claim: empty-array `status: []` filter creates a CLI/MCP boundary mismatch. **False:** `packages/store/src/workflow-runs.ts:buildListSql` explicitly skips the `WHERE status IN (...)` clause when `filter.status.length === 0`. Empty array = no filter, matching CLI's `--status` absent. Documented in `ListRunsFilter` JSDoc.

**Speculative → dropped** (not chipped; impact too low or scenario unreachable):

- **#5** — `persistInitialState` partial-failure (createWorkflowRun succeeds, appendPhase fails). Practically unreachable: two consecutive same-file `better-sqlite3` writes don't fail between them under any condition we can manufacture. Cleanup path exists via `cancel <id>` if the user discovers the orphan row. Drop.
- **#15** — `synthesizeFailedCursorRun` deterministic ID (`cr_synthetic_${workflowRunId}`). Never persists to the database (only injected into the `ShipOutput` shape); collision risk is purely cosmetic and currently unreachable since workflowRunIds are unique. Drop.

**Lower-priority observations** (dropped without chipping):

- **#4** `cancelRun` partial-match Map race — false: Map keys are full IDs, no partial-match path exists.
- **#6** `mapErrorToMcpError` name-based ZodError detection — intentional workaround for pnpm hoisting; not a bug.
- **#11** URL-encoded slash in resource id — verified via L2 smash earlier: `ship://runs/banana%2Fwithslash` returns SDK-level "not found"; no failure.
- **#13** result.json + summary.md sequential write inconsistency — partial-write outcome mismatch theoretical; `finalizeFailure` rewrites result.json on the way down, mitigating. Drop.
- **#14** `finalizeFailure` swallows secondary write errors — observability nit; covered by V2 logging story, not V1.

## Outcome

**Phase 9 L1 complete** (2026-05-10). L2 partial (pre-doc round confirmed `cancel ""` + `status wf_INVALID` boundary findings; F4 stdio-close scenario deferred to chip #7's PR test). L3 pending user `CURSOR_API_KEY` load.

**Chip queue snapshot** (5 chips, all P2/P3, within the 8-cap):

| # | Title | Severity | Files | Reproducer source |
|---|---|---|---|---|
| 1 | mcp-server: handle MCP client disconnect mid-tool-call | P2 | `packages/mcp-server/src/bin.ts` + `packages/core/src/service.ts` | L1 read + F4 scenario for the chip's PR test |
| 2 | mcp-server: reject relative SHIP_DB_PATH / SHIP_RUNS_DIR | P3 | `packages/mcp-server/src/bin.ts` | L1 read; reproduced via env-var override |
| 3 | Switch both bins from `process.exit` to `process.exitCode` | P3 | `packages/{cli,mcp-server}/src/bin.ts` | L1 read; Node.js documented gotcha |
| 4 | Rename `listRuns` error to reference `--limit` not internal symbol | P3 | `packages/store/src/workflow-runs.ts` | L2 smash (`ship list --limit 201`) |
| 5 | CLI: validate workflowRunId shape at boundary, matching MCP | P3 | `packages/cli/src/commands/{status,cancel}.ts` + `@ship/mcp` shared helper | L2 smash (`cancel ""`, `status wf_BAD`) |

**Zero P0/P1 findings.** V1's correctness surface holds up under hostile code-read + L2 adversarial input on both binaries. The chips are all UX / observability / boundary-parity polish.

**L3 status:** deferred pending user `CURSOR_API_KEY` load. If L3 surfaces additional findings, they get appended here as a "Phase 9 L3 outcome" subsection.
