This task doc intentionally has **no H1** so `open_pr` title derivation falls back to the branch-name path (open-pr phase ED-5).

## Goal

Add a minimal `src/no-h1-marker.ts` file that exports a constant string, plus a one-line test, and make `pnpm test` pass.

## Acceptance criteria

- New source + test files under the worktree.
- `pnpm test` exits 0.

## Notes

- Do not open a pull request.
- Stay inside the worktree path.
