# claude-runner gateway classifier — regression test for the 5xx-only boundary

Status: ready
Owner: claude-code:michael
Scope: test-only, +~10 lines in `packages/claude-runner/src/classify-failure.test.ts` — the production classifier is already 5xx-only. Weighted budget < 20.

## Problem

`isGatewayUnreachableText` in `packages/claude-runner/src/classify-failure.ts` already narrows
gateway status matching to **5xx-only**:

```
/gateway/i.test(text) && /\b5\d{2}\b/.test(text)
```

This mirrors the codex-runner fix (PR #155, commit 271c271): a 4xx from a gateway is **not**
transport unreachability — a `401`/`403` is an auth rejection and a `400`/`404` a wrong-endpoint
config error; only a **5xx** means the gateway itself is unreachable. The source narrowing had
already landed; what was missing was a **regression test** pinning the 4xx boundary so it can't
silently drift back to a `[45]xx` match.

## Change

Test-only — no production change. Add the missing regression coverage:

1. In `packages/claude-runner/src/classify-failure.test.ts`, add a negative case asserting a
   gateway `404` classifies as **`sdk-throw`** (i.e. not `gateway-unreachable`). Asserting the
   exact category — rather than merely "not `gateway-unreachable`" — also catches an accidental
   mis-route into any other wrong category. The existing `502` / `5xx` positive cases already
   lock the other side of the boundary.

## Validation

- `pnpm --filter @ship/claude-runner test` passes, including the new gateway-`404` → `sdk-throw` case.
- Typecheck/lint clean for the changed file.
- No production behavior change — coverage only.

## Out of scope

- codex-runner / cursor-runner classifiers (already handled / separate).
- Any broader refactor of the failure taxonomy.
