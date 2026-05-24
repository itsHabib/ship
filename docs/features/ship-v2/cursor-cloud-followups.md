# Cursor cloud followups — post-phase-04 backlog

Survey of the cursor-SDK leverage opportunities that phase 04 ([`phases/04-cursor-cloud-runner.md`](phases/04-cursor-cloud-runner.md)) deliberately punted to keep the cloud-runner PR sequence in the "amazing" band. Now that `CloudCursorRunner` is wired end-to-end (PRs #51–#54 merged 2026-05-18), these become coherent next-phase candidates.

Date: 2026-05-18
Companion: [`docs/cursor-sdk-leverage.md`](../../cursor-sdk-leverage.md) — the canonical tiered inventory of unused SDK surface.

## How this doc is organized

Each candidate has:
- **What** — the SDK surface or behavior we'd lean on.
- **Why it matters** — concrete operator workflow it unlocks.
- **Rough shape** — files / interfaces / persistence the impl would touch. Not a phase doc; just enough to scope.
- **Dependencies** — what has to land first, or open questions to resolve.
- **Estimated band** — "amazing" / "ideal" / "stretch" per CLAUDE.md PR sizing.

Listed roughly by leverage-per-effort, highest first. When any of these is picked up, it gets its own `phases/<NN>-<slug>.md` and a dossier task per the doc-first rule.

---

## B — `Agent.resume` for cloud runs across Ship-process restart

**What.** The SDK's `Agent.resume(agentId)` re-attaches to a cloud agent that's still running on the Cursor side. Cloud agents survive Ship-process death (the VM keeps running), so Ship could in principle restart, look up "what runs were in flight when we died," and resume each one to receive its terminal result.

**Why it matters.**
- Long cloud runs (~10-30 min) no longer require Ship to stay alive end-to-end.
- A crash, OS reboot, or accidental Ctrl-C during `ship.ship` doesn't waste the run.
- Composable with parallelism: spawn N cloud agents in parallel, walk away, restart Ship later to collect.
- Unlocks the original Tier 3 #6 ("Agent reuse across phases") — phase 1's agent stays alive, phase 2 resumes it without re-priming the codebase.

**Rough shape.**
- `CursorRunHandle.result` is a one-shot promise today — needs to become resumable. Either a new `attach(agentId)` factory on `CursorRunner` or a redesigned handle shape.
- `CloudCursorRunner` — implement `attach(agentId)` that calls `Agent.resume` and re-streams events.
- `cursor_runs.agent_id` — already persisted; that's the recovery key.
- `ShipService` — on startup, scan `cursor_runs WHERE status IN ('running', 'pending') AND runtime = 'cloud'`, call `cloudCursor.attach(agentId)` for each, re-wire the event stream + terminal write-back.
- New error: `CursorAgentNotFoundError` (cloud agent gone — disposed, expired, or revoked).
- L3 scenario: spawn ship, kill the process mid-run, restart, assert the run completes.

**Dependencies.**
- Open design question: do resumed runs share `events.ndjson` (append from the resume point) or branch a `events.resumed.ndjson`? Operator preference: append, with a `resumed_at` marker event.
- Open design question: how does the MCP `get_workflow_run` poll path interact with a still-running cloud run that nobody's currently streaming? Today's polling reads SQLite; events.ndjson only fills when someone's streaming. Probably want a background event-pump task per active cloud run.

**Estimated band.** Stretch (~1000 weighted LOC; this is a real interface redesign on `CursorRunHandle`). Split into a design-only PR first.

---

## C — Multi-repo cloud runs

**What.** The SDK's `cloud.repos` is `Array<{ url, startingRef?, prUrl? }>` — phase 04 narrows this to a single-element tuple via Zod. The SDK admits 1..N repos in a single agent.

**Why it matters.** Cross-repo refactors / dep-bumps that need coordinated changes (e.g. "update API X in service-A and consumer-B in lockstep, open two PRs"). Today's flow is N sequential single-repo runs with the human gluing.

**Rough shape.**
- Lift the `.tuple([...])` constraint in `cloudRunSpecSchema` to `.array(...).min(1).max(8)` or similar.
- Resolve `workflowRun.workdir` semantics. Today it's the agent's working repo's path; multi-repo means there's no single workdir. Options:
  - Primary repo's path; secondary repos are "context" the agent has access to but the workflow row doesn't track separately.
  - Drop `workdir` for cloud-multi-repo runs (nullable) and document the asymmetry.
  - New `cursor_runs.repos_json` column listing all repos involved.
- Re-think `result.git.branches`: today it's `Array<{ repoUrl, branch?, prUrl? }>` — already shaped for multi-repo, so the SDK side maps cleanly.
- L3 scenario: multi-repo agent that opens PRs in two sandbox repos.

**Dependencies.**
- A's `cursor_runs.branches_json` column (the multi-repo branch info needs the same column).
- Need at least two sandbox repos on GitHub for L3 testing.
- Operator decision on workdir semantics.

**Estimated band.** Ideal (~700 weighted LOC). Most of the work is design + schema; impl is small.

---

## D — Artifact pickup (`agent.listArtifacts` / `downloadArtifact`)

**What.** Cloud agents can produce non-git artifacts (logs, generated data files, screenshots, build outputs) — the SDK surfaces `agent.listArtifacts()` returning `SDKArtifact[]` and `downloadArtifact(id)` for retrieval.

**Why it matters.**
- Operator runs a cloud agent that builds + tests a binary → artifact is the binary, downloadable post-run.
- Cloud agent runs a profiling pass → artifact is the flamegraph SVG.
- Composable with GUI testing (E below) — the agent's screenshots become artifacts.

**Rough shape.**
- `CursorRunResult` grows `artifacts?: SDKArtifact[]` (in-memory).
- New persistence: `cursor_runs.artifacts_json` column (or a separate `cursor_run_artifacts` table if artifact counts could be high).
- `CloudCursorRunner` on terminal-success: `await agent.listArtifacts()` and persist refs (not contents).
- New MCP tool: `ship.download_artifact { workflowRunId, artifactId }` returning a file path under the run's artifacts dir.
- CLI: `ship artifacts list <wf>` + `ship artifacts download <wf> <id>`.
- Security: artifacts are arbitrary bytes from a cloud VM — Ship doesn't trust them. Document the threat model.

**Dependencies.**
- Where does the file land on disk? Probably under `<runs-dir>/<wf>/artifacts/`.
- Quota: a single artifact could be huge. Cap? Stream-to-disk?

**Estimated band.** Ideal (~700 weighted LOC). The MCP tool + CLI surface accounts for most of it; persistence + runner integration is small.

---

## E — GUI / browser testing via cloud VM desktop

**What.** Cloud VMs ship with a desktop environment + Chrome/Firefox pre-installed. The SDK exposes them via the `playwright-mcp` server (or similar) the agent can invoke. Ship doesn't currently wire any MCP server through to cloud agents.

**Why it matters.**
- Run e2e tests against a real browser inside the cloud VM as part of a `ship.ship` run.
- The operator's roxiq dogfood (per `project_roxiq.md` in memory) — desktop e2e against a real Chrome.
- Closes the loop on visual regression / accessibility / interaction testing that wasn't tractable from a stdio-only local agent.

**Rough shape.**
- Wire `playwright-mcp` (or `puppeteer-mcp`) into the cloud agent's `mcpServers` config. This intersects with Tier 1 #1 from the leverage doc (mcpServers in default wiring) — the cloud path resolves it differently than local since cloud has http.
- New `ship.ship` flag: `--mcp-server playwright` (or repeated `--mcp-server <name>`) — pre-registered named servers Ship wires in.
- Cloud-only initially: the SDK's `local.mcpServers` is stdio, which means MCP-via-cloud is the easier transport story (cloud agents have full http).
- L3 scenario: cloud agent against a known web app, asserts a screenshot artifact (links to D above).

**Dependencies.**
- D — artifact pickup is how screenshots leave the cloud VM.
- Open design question: which MCP servers does Ship know about by name? A registry file? Hardcoded?

**Estimated band.** Stretch (~1000 weighted LOC because it spans mcpServers wiring + new CLI flag + cloud-specific path + artifact handoff). Split into design + impl.

---

## F — Cloud agent lifecycle management (`Agent.archive` / `unarchive` / `delete`)

**What.** Cloud agents persist on the Cursor side until explicitly archived/deleted. The dashboard shows accumulating agents from every `ship.ship` cloud run. The SDK exposes `Agent.archive(id)` / `Agent.unarchive(id)` / `Agent.delete(id)` / `Agent.list({ includeArchived })`.

**Why it matters.**
- Operator hygiene — the dashboard fills up with completed agents.
- Cost transparency — `Agent.list` + token-usage tracking (Tier 1 #2 in the leverage doc) together produce a per-workflow cost report.
- Garbage collection on Ship-side terminal: archive the cloud agent automatically once `cursor_runs.status` is terminal.

**Rough shape.**
- Auto-archive on terminal: `CloudCursorRunner` finally-block calls `agent.archive()` after the run's result is captured. Opt-out via env var or runner config.
- New CLI subcommand: `ship cloud-agents list` / `ship cloud-agents archive <id>` / `ship cloud-agents prune --older-than 30d`.
- New MCP tool: `ship.list_cloud_agents { archived? }` — wraps `Agent.list({ runtime: "cloud" })`.

**Dependencies.** None; standalone.

**Estimated band.** Amazing (~400 weighted LOC: 1 runner change + 1 CLI subcommand + 1 MCP tool + tests).

---

## G — `workOnCurrentBranch` flag (single-PR iteration)

**What.** Phase 04's `CloudRunSpec.workOnCurrentBranch?: boolean` is documented as experimental and passes through to the SDK, but Ship's `workflowRun = one new branch` model doesn't anticipate it. When `true`, the cloud agent pushes to an existing branch instead of creating a new one — useful for iterating on a PR that's already open.

**Why it matters.**
- Cycle-1 / cycle-2 fix flow against a cloud-produced PR. Today's only options: spawn a new cloud run that creates a new branch, then manually rebase / cherry-pick (defeats the iteration story).
- Pairs well with B (`Agent.resume`) — resume the same agent on the same branch.

**Rough shape.**
- Decide what `workflowRun.workdir` / `worktree.branch` mean when the agent pushed to a branch the workflow row didn't create.
- Probably make `worktree` optional on the workflow row for `workOnCurrentBranch: true` cloud runs.
- L3 scenario: cloud agent run twice with `workOnCurrentBranch: true`, both pushing to the same branch.

**Dependencies.** Mostly design-side — interface implications are real.

**Estimated band.** Ideal (~600 weighted LOC; mostly design + schema).

---

## H — Self-hosted cloud env (`env.type: "machine"` / `"pool"`)

**What.** Phase 04's `cloudRunSpecSchema` admits `env.type: "cloud" | "pool" | "machine"` but Ship doesn't ship a self-hosted setup. The SDK passes the field through; operator-config-driven.

**Why it matters.**
- Pinned-environment requirements (specific OS image, pre-installed tools, internal-only deps).
- Cost: self-hosted pools can be cheaper than Cursor-managed cloud for sustained workloads.

**Rough shape.**
- Almost no Ship-side code — schema already admits the values.
- Docs: how to set up a Cursor-compatible self-hosted environment, what `env.name` resolves to in each mode.
- Maybe a CLI flag: `--cloud-env-name <name>` for `pool` / `machine` modes (today only `--cloud-env-var KEY=VAL` exists).

**Dependencies.** Operator needs an actual self-hosted setup to validate against.

**Estimated band.** Amazing (~300 weighted LOC: mostly docs + a CLI flag).

---

## Suggested ordering

Pick by leverage-per-effort. A natural sequence:

1. **F — Lifecycle management** (amazing, no deps). Quick win, removes dashboard clutter. Sets up Tier 1 #2 (token tracking) by giving us a list of agents to ask about.
2. **D — Artifact pickup** (ideal, no hard deps). Standalone unlock; sets up GUI testing (E).
3. **B — `Agent.resume`** (stretch, real interface redesign). The biggest leverage but the most design work. Design-only PR first.
4. **E — GUI testing** (stretch, deps on D). Big-ticket feature once D lands.
5. **C — Multi-repo cloud** (ideal). Specialized use case; pick up when there's a real cross-repo refactor to dogfood against.
6. **G — `workOnCurrentBranch`** (ideal, mostly design). Iteration QOL; pick up after we've done a few cloud PRs to understand the iteration pain.
7. **H — Self-hosted env** (amazing, ops-driven). Pick up when operator has a self-hosted setup to validate against.

## What this doc doesn't cover

The cursor-sdk-leverage doc has a Tier 1 list of non-cloud opportunities still on the table:

- **mcpServers in default wiring** (Tier 1 #1) — transport question for local agents
- **Token-usage tracking via `onDelta`** (Tier 1 #2) — `cursor_runs.token_usage_json`
- **`ship doctor` CLI subcommand** (Tier 1 #3) — `Cursor.me` + `Cursor.models.list`
- **Multimodal task docs (`images:`)** (Tier 2 #5) — front-matter `images: [...]` → `agent.send({ images })`

These don't lean on phase 04's cloud work and are tracked separately in [`docs/cursor-sdk-leverage.md`](../../cursor-sdk-leverage.md). When any of them moves to active, they get their own phase doc the usual way.

## Cross-refs

- Phase 04 design: [`phases/04-cursor-cloud-runner.md`](phases/04-cursor-cloud-runner.md) (§ Out of scope is the source-of-truth list for the items A–H above)
- Cursor SDK leverage inventory: [`docs/cursor-sdk-leverage.md`](../../cursor-sdk-leverage.md)
- Cursor SDK reference: [`docs/cursor-sdk-typescript.md`](../../cursor-sdk-typescript.md)
- E2E execution how-to: [`docs/e2e-execution.md`](../../e2e-execution.md)
- V2 spec: [`spec.md`](spec.md)
