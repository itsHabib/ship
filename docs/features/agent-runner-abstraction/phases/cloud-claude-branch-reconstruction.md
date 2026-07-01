# Phase 3b — Claude cloud branch/PR reconstruction

> **Shipped** combined with 3c (`cloud-claude-selector`) as one PR — "make `(claude,cloud)` reachable end-to-end" — since 3b alone ships reconstruction code no selector reaches (the 3a situation). Two deviations from the plan below: (1) reconstruction is wired in the **runner** post-terminal (`cloud-runner.ts` `#reconstruct`), not in `cloud-terminal-map.ts` — the reducer stays a pure sync function and the `gh` fallback is async + post-terminal, so it can't live in the reducer; (2) the GitHub-MCP endpoint URL is sourced from `GITHUB_MCP_URL` (env/wiring) and MCP injection is skipped when unset — the agent then pushes via the mounted repo PAT and the `gh` fallback reconstructs the PR.

**Status:** ready to ship (rebase on `cloud-claude-runner` / 3a merged)
**Owner:** human:mh (driven by claude-code:michael)
**Date:** 2026-06-27
**Dossier:** project `ship`, phase `agent-runner-claude-cloud`, task `cloud-claude-branch-reconstruction` (`tsk_01KW3NSX1VHJ1HD9JK5Y5952DH`, depends_on `cloud-claude-runner`)
**Design:** [`docs/features/agent-runner-abstraction/spec.md`](../spec.md) — §7 Flow E (steps 4 & 6), §8 (reconstruction failure), §10.10 (primary/fallback), §10.15 (remote MCP transport)

## Scope

| Bucket | Files | Weighted |
|---|---|---|
| Production | `packages/claude-runner/src/cloud-branch-reconstruct.ts` (parse `create_pull_request` off the stream + `gh` fallback + branch-not-found failure, ~160), `packages/claude-runner/src/cloud-session.ts` (+GitHub-MCP `mcp_servers` on the per-run agent, ~25), `packages/claude-runner/src/cloud-runner.ts` (+prescribed-branch dispatch instruction, wire reconstruction into finalize, ~40), `packages/claude-runner/src/cloud-terminal-map.ts` (thread `branches[]` into the success result, ~15) | ~240 |
| Tests (0.5×) | `cloud-branch-reconstruct.test.ts` (stream-parse primary, `gh` fallback, not-found failure), `cloud-runner.test.ts` (+branches[0] on success, +branch-not-found failed path) | ~220 raw → ~110 |
| Docs (0×) | this doc | 0 |
| **Total** | | **~350** |

Band: **amazing** (`< 500`). One PR, layered on 3a.

## Context

Managed Agents returns **no branch/PR** in any terminal payload — the session edits a server-side checkout of the mounted `github_repository`, and the agent must itself push a branch + open a PR. Ship reconstructs `AgentRunResult.branches[] = [{ repoUrl, branch, prUrl }]` (the `CloudCursorRunner` shape) so the rest of the system — `get_workflow_run`'s `branches`, the work-driver merge step, `result.json` — works identically across providers.

3a left `branches: []` and a plain prompt. This task makes the agent push to a **prescribed** branch and open a PR, then reconstructs the result two ways: **primary** off the live stream, **fallback** via `gh`.

## Functional requirements

- **FR1 — inject the GitHub MCP server** (`cloud-session.ts`, `ensureAgent`). Add a **remote/HTTP** MCP server to the per-run agent's `mcp_servers` as a `BetaManagedAgentsURLMCPServerParams` = `{ name, type: "url", url }` — **note: this param has NO auth-header field** (confirmed against the installed 0.106.0 types). A hosted MA session **cannot** reach a local stdio MCP (§10.15), so this is the official remote GitHub MCP endpoint. **Auth path (no header field):** carry the GH PAT either token-in-URL (an authenticated MCP endpoint URL) or via a session **vault** credential (`SessionCreateParams.vault_ids`) — confirm which at L4. **Crucially, the server MUST be referenced by an `mcp_toolset` entry in the agent's `tools`** (`{ type: "mcp_toolset", mcp_server_name: <name>, default_config: { permission_policy: { type: "always_allow" } } }`) — Managed Agents **rejects an unreferenced `mcp_servers` entry** at agent-create. Source the endpoint URL + PAT from wiring (3c carries the field); never argv/logged.
- **FR2 — prescribed-branch dispatch instruction** (`cloud-runner.ts`). Append to the dispatched `user.message` an explicit instruction: *implement the task, commit, push to branch `<prBranch>`, and open a PR against `<baseRef>` using the GitHub MCP server* (there is no `autoCreatePR` flag — the agent does it via the tool). `prBranch` is required for `claude × cloud` (schema-enforced in 3c). Keep the instruction minimal + deterministic so the branch name is predictable for the fallback.
- **FR3 — primary reconstruction: parse the stream** (`cloud-branch-reconstruct.ts`). While consuming the SSE stream (3a's pipeline already records the bounded event tail), detect the GitHub-MCP PR-creation call: an `agent.mcp_tool_use` whose `name` is the PR-create tool (e.g. `create_pull_request`) paired with its `agent.mcp_tool_result` (matched by `mcp_tool_use_id`). Parse the PR URL + head branch out of the result `content` (text/JSON block). Fill `branches[0] = { repoUrl, branch, prUrl }`. **Confirm the exact tool name + result payload in this task's L4** (the GitHub MCP's PR-create tool name + its result schema) — build the L3 mock from a captured real payload.
- **FR4 — fallback: `gh` lookup** (`cloud-branch-reconstruct.ts`). When the stream yielded no parseable `create_pull_request` result (missing/malformed, or the agent pushed without the MCP), after `end_turn` run `gh pr list --head <prBranch> --repo <slug> --json url,headRefName --limit 1` (or `gh api`) on the **runner host** (which has `gh`). If a PR is found → `branches[0]`. If a branch exists but no PR, fall back to `{ repoUrl, branch: prBranch }` (no `prUrl`). The `gh` call is the robustness net; it races PR-creation timing, so it runs only after terminal (§10.10 — primary is the stream parse, NOT `gh`-first).
- **FR5 — branch-not-found is a distinct failure** (§8). If the session reached `end_turn` (a "success" terminal) but **neither** path yields a branch, the run is **`failed`**, not a silent empty `branches[]`: `{ status: "failed", errorMessage: "expected branch \`<prBranch>\` not found after end_turn (agent did not push / used a different branch)", failureCategory: "logic", sdkTerminalStatus: "branch-not-found" }`. This converts a "the agent said done but produced nothing mergeable" into an actionable failure. (A non-`end_turn` terminal stays its 3a failure category; this check only applies on the otherwise-successful path.)
- **FR6 — thread `branches[]` into the success result** (`cloud-terminal-map.ts`). The success mapper takes the reconstructed `branches` and emits them on the `succeeded` `AgentRunResult`; `result.json` then carries them (core's `loadRunBranches` already reads `result.json.branches` provider-agnostically — no core change).

## Engineering decisions

- **ED-1 — primary = stream parse, fallback = `gh`** (§10.10, the corrected ordering). The stream result is authoritative + immediate (no API race); `gh` is the net for a missing/malformed tool-result. The earlier "gh is more robust" framing was backwards — `gh pr list` races PR-creation timing, so it's the fallback run only post-terminal.
- **ED-2 — remote MCP transport only** (§10.15). The neutral `McpServerConfig` http variant + the MA `URLMCPServerParams` are remote endpoints. Do not attempt a stdio GitHub MCP for cloud — the hosted session can't reach the caller's machine.
- **ED-3 — reconstruction is cloud-claude-local mechanism.** It lives in `@ship/claude-runner` (not the neutral package) — it's specific to the MA stream shape + the GH-MCP tool result. `gh` is shelled via `node:child_process` inside the package (mirror any existing `gh` usage; if none, a tiny `execFile` wrapper with the repo slug + branch as args — never interpolate untrusted strings into a shell).
- **ED-4 — `prBranch` deterministic.** The runner uses the caller-supplied `prBranch` verbatim (3c makes it required). The dispatch instruction names it exactly so primary + fallback agree on the branch to find.

## Validation

- **L3 (CI) — the reconstruction gate.** A canned SSE stream carrying an `agent.mcp_tool_use{create_pull_request}` + matching `agent.mcp_tool_result{url, headRefName}` → `branches[0] = { repoUrl, branch, prUrl }` on a `succeeded` result. A second fixture with **no** PR tool-result + a mocked `gh` returning a PR → fallback fills `branches[0]`. A third with no tool-result + `gh` returning empty → **`failed`** with the branch-not-found message (FR5).
- **L2.** `gh` non-zero exit / unparseable JSON → fallback yields no branch → branch-not-found failed (not a throw). Malformed `create_pull_request` result content → falls through to `gh`.
- **Coverage + check.** `make check` green ubuntu + windows incl. coverage (branch-cover primary/fallback/not-found).
- **L4 (live, gated).** A real MA session against a fixture repo pushes `<prBranch>` via the GitHub MCP + opens a PR; the runner reconstructs `branches[0]` + the PR URL from the stream (primary), and a forced-missing-tool-result run reconstructs via `gh` (fallback). **Capture the real `create_pull_request` result payload** here to harden the L3 mock + confirm the tool name.

## Risks

- **GH-MCP tool name / result schema unknown until L4** (FR3). The PR-create tool name + result shape are assumed; the L3 mock is provisional until the L4 capture. The `gh` fallback (FR4) is the safety net if the primary parse is wrong — so a misparse degrades to fallback, not failure. Flag the assumed tool name in the PR body for operator confirmation.
- **Agent ignores the prescribed branch.** If the agent pushes to a different branch, primary finds the PR (if the MCP result is parsed) but the `gh --head <prBranch>` fallback misses it → branch-not-found. Acceptable (the contract is "push to `<prBranch>`"); the deterministic instruction (FR2) minimizes it.
- **`gh` auth on the runner host.** The fallback uses the host's `gh` auth (the operator's), not the session PAT. Fine for the dogfood/L4 host; a headless deployment without `gh` auth loses only the fallback (primary still works). Note it.
- **PAT scope.** The GH PAT needs repo-write (push + PR). Minimum scopes, env-only, redacted in any session-create/agent-create debug dump (3a FR8). Source = wiring (3c), not the per-task input.

## Out of scope

- The `CloudRunSpec` `prBranch`/PAT/MCP-endpoint **fields + schema** + the `(claude, cloud)` legalization — **3c**.
- The base runner pipeline + terminal map — **3a** (this layers on it).
- Reconstructing multiple repos (MA mounts one `github_repository` per session here; multi-repo is out).

## Implementation plan (PR boundary = this whole task)

1. Rebase on 3a (`cloud-claude-runner` merged).
2. `cloud-session.ts` — add the remote GitHub-MCP `mcp_servers` entry to `ensureAgent` (confirm the URL-MCP param shape).
3. `cloud-runner.ts` — append the prescribed-branch + open-PR instruction to the dispatched message.
4. `cloud-branch-reconstruct.ts` — stream-parse primary + `gh` fallback + branch-not-found failure.
5. `cloud-terminal-map.ts` — thread reconstructed `branches[]` onto the success result; wire the not-found check into the success path.
6. Tests: primary parse, `gh` fallback, branch-not-found failed, malformed-result degrade-to-fallback.
7. `make check` green (ubuntu + windows incl. coverage). Run `code-reviewer` + `validator`. Flag the assumed GH-MCP tool name for operator confirmation.
