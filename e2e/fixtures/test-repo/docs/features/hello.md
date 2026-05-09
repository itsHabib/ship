# Add a `hello` function

A trivial task doc used by Ship's e2e suite to exercise the full
implementation flow.

## Goal

Add a `hello()` function that returns the string `"world"`, plus a unit test
that asserts the return value.

## Acceptance criteria

- A new file `src/hello.ts` exports `hello()` returning `"world"`.
- A new file `src/hello.test.ts` (or `tests/hello.test.ts`) imports `hello`
  and asserts the return value.
- `pnpm test` exits 0 in the worktree.

## Notes

- Don't open a pull request — Ship handles that as a separate phase.
- Don't expand scope; stay inside the worktree.
