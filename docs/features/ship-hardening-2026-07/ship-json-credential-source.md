**Status**: draft
**Owner**: @mh
**Date**: 2026-07-16
**Related**: dossier task `ship-json-credential-source` (id: `tsk_01KXP1381AR1TZBE8RY3KXPF8B`), design [docs/features/repo-dispatch-policy/spec.md](../repo-dispatch-policy/spec.md) + workbench `docs/features/driver-state/spec.md` §4 D5

# .ship.json credential-source constraint (token source + gh account per repo) — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | packages/driver/src/policy.ts (schema), packages/claude-runner/src/local-runner.ts (env construction), packages/driver/src/land.ts + gh-port.ts (gh identity check) | ~250 | 250 |
| Tests | policy.test.ts, local-runner tests, land/gh-port tests | ~350 | 175 |
| **Total** | | | **~425** |

Band: **ideal** per ship PR sizing.

## Goal

`.ship.json` v1 pins runtime/provider but not *identity*. On a machine carrying both personal (Max-sub `ANTHROPIC_AUTH_TOKEN`, itsHabib gh auth) and work credentials, nothing stops a work-repo dispatch from riding the personal token/account. The 2026-07-16 review of the work-machine setup flagged this as the remaining leak.

## Behavior / fix

Extend the `.ship.json` schema with a credentials constraint, e.g.:

```json
"credentials": {
  "claude_token_env": "WORK_ANTHROPIC_TOKEN",
  "forbid_env": ["ANTHROPIC_BASE_URL"],
  "gh_host_user": "<work-login>"
}
```

Exact keys are design freedom — keep the surface **minimal and fail-closed**. Enforced at:

1. **Dispatch (runner env construction, `packages/claude-runner/src/local-runner.ts`):** refuse when the required token source is absent or a forbidden env override is present. The error names the missing/offending source.
2. **`driver land` / gh operations (`packages/driver/src/land.ts`, `gh-port.ts`):** verify `gh api user` login matches `gh_host_user` before any write; refuse on mismatch.

Absent `credentials` key = today's behavior, byte-identical.

## Acceptance

- A repo pinning a work token env: dispatch with only the personal `credentials.json` present is refused with an error naming the missing source.
- gh writes under the wrong login are refused.
- Repos without the key are byte-identical to today.

## Test plan

- Policy schema tests: unknown-key warn, malformed hard error, fail-closed.
- Runner env-construction refusal.
- gh-login mismatch refusal (port-mocked).
- Absent-key passthrough.

## Non-goals

- Any secrets storage/brokering (keyproxy stays parked).
- Multi-account switching automation.
- The startShip runtime/provider ceiling (separate task `shipservice-dispatch-policy`).
