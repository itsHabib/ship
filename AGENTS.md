# Ship — Agent Instructions

Read [CLAUDE.md](CLAUDE.md) for the authoritative repository workflow, architecture, shipping process, staging rules, and local-first guidance. This file adds environment-specific notes.

## Cursor Cloud specific instructions

This is a pnpm monorepo (Node.js ≥22, pnpm 10.13.1). The VM comes with both pre-installed via nvm.

### Quick reference

| Action | Command |
|--------|---------|
| Install deps | `pnpm install` |
| Full check (CI-equivalent) | `make check` |
| Typecheck only | `make typecheck` |
| Lint only | `make lint` |
| Format check | `make format-check` |
| Unit tests (L1/L2) | `make test` |
| Integration tests (L3) | `make integration` |
| Run CLI | `cd packages/cli && npx tsx src/bin.ts <command>` |
| Run MCP server (fake) | `cd packages/mcp-server && SHIP_TEST_FAKE_CURSOR=1 npx tsx src/bin.ts` |

### Notes

- All L1/L2 tests (604+) run with fake/in-memory runners and embedded SQLite — no external services or API keys needed.
- The MCP server requires `CURSOR_API_KEY` for real Cursor SDK calls. Use `SHIP_TEST_FAKE_CURSOR=1` to bypass this for local testing.
- L3 integration tests (`make integration`) also use the fake runner and require no external keys.
- L4 live/cloud tests (`make e2e`) require `CURSOR_API_KEY`, `GITHUB_TOKEN`, and `SHIP_E2E_SANDBOX_REPO`. These are opt-in.
- `better-sqlite3` is a native addon; the `pnpm.onlyBuiltDependencies` allowlist in root `package.json` handles non-interactive builds.
- There is a cyclic workspace dependency warning between `@ship/core` and `@ship/test-harness` — this is intentional and harmless (test-harness imports core for fake wiring).
- **Local runtime parallelism:** at most **2** concurrent local `ship` runs against the same `state.db` (`<UserConfigDir>/ship/state.db`). Three or more local streams contend on ship-store and the Cursor SDK's SQLite; failures surface as `local run contention — reduce parallelism`. Cloud runs do not share a local DB — use cloud when fanning out more than two streams.

<!-- BEGIN dev-workbench (managed by /dev-workbench skill - re-run to refresh; hand-edits inside this block will be overwritten) -->
## Dev workbench

These MCPs, planes, and skills are available in Claude and Codex sessions on this machine; each harness injects tool signatures, so this is the map of how they compose, not a second verb manual. **This is ship - the Execution plane driver - so Ship workflows are most directly relevant here.** When the signal matches, call the verb. Knowledge questions about another portfolio repo go to `/consult`; authority questions - direction, spend, credentials, irreversible actions - go to the operator.

**MCPs (in-session):**
- **dossier** - durable project memory: projects -> phases -> tasks -> artifacts.
- **ship** - dispatch an agent and persist dispatch -> poll -> judgment -> land -> record.
- **channel** - optional append-only agent message bus (`channel.post/read/list`); off the normal PR path and supersedes huddle.
- **playwright** - browser automation when the task requires a real DOM.

**Planes (workbench CLIs composed through exit codes and JSONL, not MCPs):**
- **gate** - authorization at the exact PR head against an operator-minted grant; findings are not authorization. Exit 0 pass / 1 block / 2 park / 3 refuse / 4 error.
- **flare** - best-effort notification sink over authoritative receipts; never gates.
- **console** - read-only local view of Gate's inbox and grant ledger; explains, never decides.
- **escalate** - agent -> human -> agent resolution channel for a parked Gate run.

**Skills:**
- **/work-driver** + **/work-driver-prep** - drive implementation; prep builds specs and conflict-safe batches.
- **/pr-risk** - decide how much review a change needs; reviewers perform it.
- **/review-coordinator** + **/review-digest** - consolidate reviewer findings; digest is the deterministic pre-pass.
- **/shipped** / **/status** / **/wip** - retrospective / current-session / portfolio-liveness views.
- **/consult** - ask a sibling repo's steward; knowledge to peers, authority to the operator.
- **/worktree-*** - add / list / remove / transfer / locate isolated checkouts.

### The loop

```text
dossier task -> /worktree-add -> spec -> ship driver (dispatch -> poll -> judgment -> land -> record)
  -> PR + CI -> /pr-risk -> reviewer panel -> /review-coordinator -> one findings artifact
  -> gate evaluates the exact head -> 0: emitted head-pinned merge command -> merge
  -> authoritative receipts -> dossier close-out -> /worktree-remove
       \-> 2: park -> console / gate next -> human decision -> escalate -> gate resolve -> gate next
       \-> attention or terminal receipt -> flare -> Slack (best effort; never gates)
```

`/work-driver` coordinates dispatch -> poll -> land and runs its own review triage inline. `/pr-risk` and `/review-coordinator` are explicit steps; the driver does not invoke them automatically.

### Why this shape

Each layer owns one responsibility and can be replaced without rippling: dossier owns what needs doing; worktree skills own where work happens; Ship owns agent execution and durable run state; pr-risk owns review depth; reviewer bots are swappable finders; review-coordinator owns their consolidated artifact; Gate alone owns exact-head merge authorization; Escalate carries a human resolution without deciding it; Console explains Gate state; Flare notifies; Consult handles cross-repo knowledge; Channel owns optional agent-to-agent messaging and supersedes Huddle. The workbench is a menu, not a checklist.

### The shape underneath

The contract planes are **State** (dossier plus run, verdict, grant, and receipt artifacts), **Execution** (Ship), **Verification** (review and Gate's escalate-only verifier ladder), **Capability** (scoped operator-minted grants), and **Observability** (Console, Flare, /wip, /shipped, /status). This section is **Composition**. Planes share typed artifacts - evidence -> verdict -> action - rather than call stacks.
<!-- END dev-workbench -->

<!-- BEGIN eng-philo (managed by /eng-philo — re-run to refresh; hand-edits inside this block will be overwritten) -->
## Engineering principles

How code is written here — Dave Cheney lineage ([Practical Go](https://dave.cheney.net/practical-go)): simplicity, clarity, line-of-sight. Apply on every change; the lint below catches the slips.

1. **No `else` — line-of-sight.** Handle errors / edge cases with early returns and guard clauses; keep the happy path un-indented, flowing down the left margin. Reaching for `else` → return early instead.
2. **Shallow nesting — ≤2 levels *per scope*.** A `for` + an `if` is the ceiling in one scope. The budget is per-scope, not per-function — a closure / anon fn is its own scope, so a `for`+`if` inside a closure is fine. Deeper in one scope → extract a function.
3. **Policy vs mechanism.** Separate the decisions (policy: validation, state machines, business rules) from the plumbing (mechanism: persistence, transport, I/O). Mechanism is dumb and swappable; policy lives in a layer above it. Never let policy leak into a mechanism layer.
4. **Composition of single-responsibility layers.** Each layer / package owns ~one responsibility; the app is a *composition* of them; any piece is swappable without rippling into the others. Dependencies flow one direction.
5. **Small, sharp APIs.** Export the least callers need. Intention-revealing names. Accept the narrowest input, return concrete types. Make the zero value useful.
6. **Errors are values; simplicity over cleverness.** Handle or propagate errors explicitly — never swallow. Readable > clever > short. A little copying beats a premature abstraction or dependency.

### Node / TS idioms + enforcement

Early-return; no nested ternaries; no `else` after `return`; narrow exported surface.

*Enforce:* eslint — `complexity`, `max-depth`, `no-else-return`, `sonarjs/cognitive-complexity`.
<!-- END eng-philo -->
