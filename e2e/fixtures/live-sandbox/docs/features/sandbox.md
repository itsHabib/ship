# Sandbox feature slice

Small task doc for live e2e runs against an operator-owned sandbox repo.

## Goal

Add a tiny TypeScript module under `src/` (for example `src/sandbox.ts`) exporting a single function with a unit test, and ensure `pnpm test` passes in the worktree.

## Acceptance criteria

- At least one new `src/*.ts` file and a matching test file.
- `pnpm test` exits 0 when run from the worktree root (if the repo has no test script yet, add a minimal `package.json` + `vitest` devDependency suitable for the scaffold).

## Notes

- Do not open a pull request; the test harness handles cleanup.
- Stay inside the worktree path.
