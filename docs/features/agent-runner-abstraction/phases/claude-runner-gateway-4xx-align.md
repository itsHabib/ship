# claude-runner gateway classifier — narrow to 5xx-only

Status: ready
Owner: claude-code:michael
Scope: ~5 LOC + 1 test in `packages/claude-runner/src/classify-failure.{ts,test.ts}`. Weighted budget < 50.

## Problem

`isGatewayUnreachableError` in `packages/claude-runner/src/classify-failure.ts` currently
matches **both** 4xx and 5xx status codes when the text mentions a gateway:

```
/gateway/i.test(text) && /\b[45]\d{2}\b/.test(text)
```

A 4xx from a gateway is **not** transport unreachability — a `401`/`403` is an auth failure
and a `400`/`404` is a wrong-endpoint config error. Only a **5xx** means the gateway itself is
unreachable/erroring. The codex-runner classifier was mirrored from this one and has already
been narrowed to 5xx-only (PR #155, commit 271c271); claude-runner carries the same latent
over-match. This only mislabels the `FailureCategory` on a claude run that hits a gateway 4xx —
no functional break — so it is low priority, but the label should be correct.

## Change

1. In `packages/claude-runner/src/classify-failure.ts`, narrow the status-code regex inside
   `isGatewayUnreachableError` from `/\b[45]\d{2}\b/` to `/\b5\d{2}\b/` (5xx only). Leave the
   `/gateway/i` text requirement unchanged.
2. In `packages/claude-runner/src/classify-failure.test.ts`, add a test asserting a gateway
   error message carrying a **4xx** status (e.g. a `401` containing the word "gateway") does
   **not** classify as `gateway-unreachable`. Keep or add a positive case confirming a **5xx**
   with "gateway" still **does** classify as `gateway-unreachable`.

## Validation

- `pnpm --filter @ship/claude-runner test` passes, including the new 4xx-negative case.
- Typecheck/lint clean for the changed files.
- No behavior change outside the classifier's 4xx branch.

## Out of scope

- codex-runner / cursor-runner classifiers (already handled / separate).
- Any broader refactor of the failure taxonomy.
