**Status**: draft
**Owner**: @michael
**Date**: 2026-05-31
**Related**: dossier task `cloud-runs-make-ci-coverage` (id: `tsk_01KSZQEKQCMRVVN2GFRXH9P1JX`)

# One validation surface — coverage in `make check` — design spec

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Build config | `Makefile` (+ maybe `.github/workflows/ci.yml`) | ~10 | 0 (config) |
| **Total** | | | **~0–10** |

Band: **amazing** (near one-liner).

## Goal

Cursor agents validate with `make check` (`typecheck lint format-check test`), but CI's coverage gate (lines 90% / branches 85%) lives only in `make ci`'s `coverage` target. Result: all three cloud-phase PRs (#94/#95/#96) came back "green" from the agent yet failed CI on coverage — each needed a follow-up. The agent structurally can't see the gate it must pass. Close the skew: one validation command that includes coverage.

## Behavior / fix

Prefer **(b)**: fold the coverage gate into `make check` so there's a single validation surface the agent and CI share.

- Today: `check: typecheck lint format-check test` ; `ci: install check coverage integration`.
- Option (b): make `check` depend on `coverage` (which runs `vitest run --coverage` with the thresholds), and drop the now-redundant `test` step if `coverage` subsumes it (coverage runs the same suite). `ci` then becomes `install check integration`.
- Trade-off: `make check` gets slightly slower (coverage instrumentation). Acceptable — it's the price of the gate being visible. If speed matters, keep a `make test-fast` for inner-loop iteration, but `check` (the validation command) must include coverage.

Alternative (a), if (b) is rejected: leave `make check` as-is but update the cursor task convention / spec-doc template to instruct `make ci` (or `make coverage`) as the validation command. Weaker — relies on every spec remembering it.

## Acceptance

- `make check` fails when coverage is below threshold (lines 90% / branches 85%), on the same DB/test set CI uses.
- A cursor agent running the repo's stated validation command sees the coverage gate before pushing.
- CI (`make ci`) stays green and non-redundant.

## Non-goals

- Changing the coverage thresholds themselves.
- Per-package vs global threshold restructuring.
