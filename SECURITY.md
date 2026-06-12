# Security policy

## Reporting a vulnerability

For security concerns, **don't file a public issue**. Use [GitHub private vulnerability reporting](https://github.com/itsHabib/ship/security/advisories/new) or email the maintainer privately at michael.habib@hadrian.co.

Expect acknowledgment within 7 days. Coordinated disclosure timing depends on severity — for bugs whose blast radius is limited to the operator's own machine (local subprocesses, local SQLite, local config dir), the window is typically short (days, not months).

## Scope

Ship is a local dev-workflow toolkit: a CLI (`@ship/cli`) and an MCP server (`@ship/mcp-server`) running on the operator's machine. It dispatches Cursor coding agents (local subprocess or Cursor cloud) against task docs and persists run state in a local SQLite store.

**Security-relevant surfaces:**

- `@ship/cursor-runner` — reads and passes through `CURSOR_API_KEY` for Cursor SDK calls (local and cloud).
- Task-doc content — embedded into agent prompts; a malicious or crafted task doc is a prompt-injection surface.
- Run artifacts under the user config dir — `events.ndjson` and related logs can contain repo content from dispatched runs.
- MCP stdio surface — tool inputs are validated with zod at every boundary before dispatch.
- Spawned `git` subprocesses — invoked against the operator's configured workdirs and repos.

**Out of scope:**

- The Cursor SDK and Cursor cloud platform itself (report to Cursor).
- GitHub upstream.
- The operator's own repos that agents act on — ship orchestrates; it does not sandbox the target codebase.

## Threat model

Ship is not network-facing. It runs on the operator's machine, in their own session, against their own repos. Realistic threats:

1. **Malicious task-doc or repo content steering a dispatched agent** (prompt injection). Mitigated by operator-authored task docs and downstream PR review gates — ship does not vet third-party content before dispatch.
2. **Injection via crafted MCP tool input.** Mitigated by strict zod validation at every MCP tool boundary; invalid input is rejected before side effects.
3. **API-key leakage into logs or artifacts.** `CURSOR_API_KEY` must never appear in `events.ndjson`, stderr, or other run artifacts. Report any path that echoes the key.

Internet-facing attacks (RCE via external network, unsolicited inbound connections) aren't in scope — ship doesn't bind to ports or accept remote connections.
