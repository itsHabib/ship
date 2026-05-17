# Long-running scaffold (L4 cancel)

Designed to keep a real Cursor agent busy long enough (~30s+) to cancel mid-flight.

## Goal

Scaffold a **small Node.js CLI** in the worktree with:

- Entry `src/cli.ts` using a CLI parser (e.g. `commander` or hand-rolled `process.argv`) exposing subcommands **`a`**, **`b`**, and **`c`**.
- Each subcommand prints a distinct string to stdout and exits 0.
- Under `test/` (or `src/`), add **Vitest** tests that spawn the CLI (or invoke parsed handlers) and assert each subcommand output.
- Root `package.json` with `pnpm test` → `vitest run` (or equivalent).

## Acceptance criteria

- `pnpm install` then `pnpm test` exits 0 in the worktree.
- All three subcommands exist and are covered by tests.
- Keep the scope minimal — no network, no extra packages beyond what a tiny CLI needs.

## Notes

- Do not open a pull request; Ship covers that separately.
- Stay inside the worktree path.
