# test-repo

Throwaway fixture used by Ship's e2e suite. Each e2e scenario clones this
into a temporary directory, registers the clone with Tower, and runs `ship`
against it. The original under `e2e/fixtures/test-repo/` stays unchanged.

The repo intentionally has minimal scaffolding: a single task doc under
`docs/features/hello.md` describing a trivial implementation goal. The e2e
suite asserts the agent produces a worktree where that task is satisfied
(file added, test passing).
