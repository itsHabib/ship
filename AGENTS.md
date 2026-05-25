# Ship — Agent Instructions

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
