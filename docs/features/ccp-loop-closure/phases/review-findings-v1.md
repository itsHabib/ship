**Status**: draft
**Owner**: @michael
**Date**: 2026-07-10
**Related**: Workbench closure TDD Phase 1; `driver address` PR #184

# `ReviewFindingsV1` at the Ship address boundary

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---:|---:|
| Production | `packages/driver/src/review-findings.ts`, `engine.ts`, `gh-port.ts`; `packages/store/src/review-artifacts.ts`, `store.ts`; migration 0015 | ~360 | 360 |
| Tests | parser/property tests, address engine tests, store migration/reopen tests | ~420 | 210 |
| **Total** | | | **~570** |

This is one PR because parsing without durable consumption still permits duplicate
dispatch, while durable consumption without exact-head validation can make stale
review text authoritative. They are one boundary transition.

## Functional

`driver address --findings <path>` currently accepts any non-empty text and
carries it opaquely. Replace that weak edge with one versioned JSON artifact while
keeping review selection and judgment outside Ship.

A valid artifact has this transport shape:

```json
{
  "schema_version": 1,
  "artifact_id": "rf_...",
  "decision": "address",
  "subject": {
    "type": "pull_request",
    "repo": "owner/repo",
    "number": 184,
    "head_sha": "40-hex"
  },
  "producer": {
    "id": "review-coordinator",
    "harness": "codex",
    "generated_at": "RFC3339"
  },
  "panel": {
    "requested": ["codex", "claude", "copilot"],
    "completed": ["codex", "copilot"],
    "missing": ["claude"]
  },
  "findings": [{
    "id": "finding-stable-id",
    "severity": "critical",
    "summary": "bounded summary",
    "evidence": "verbatim supporting evidence",
    "sources": [{
      "reviewer": "codex",
      "comment_id": "3560695758",
      "url": "https://github.com/owner/repo/pull/184#discussion_r...",
      "file": "packages/driver/src/engine.ts",
      "line": 900
    }]
  }]
}
```

Objects tolerate unknown optional fields so compatible producers can add receipt
metadata. Unknown schema majors, decisions, subject types, and malformed known
fields refuse. `severity` is a non-blank bounded string, not a Ship-owned enum:
the engine transports it but never ranks or acts on coordinator vocabulary.

The 1 MiB input cap is enforced at the file-read boundary and maps to
`findings-unreadable`. The parser additionally enforces:

- at least one finding and one source per finding;
- non-blank evidence, summary, producer id, reviewer id, and stable finding id;
- unique finding ids and unique entries in each panel set;
- `completed` and `missing` are disjoint and their union equals `requested`;
  members absent from `requested` therefore refuse rather than becoming extras;
- every finding source reviewer appears in `panel.completed`;
- at most 100 findings, 32 sources per finding, and 16 panel members;
  ids/reviewer/producer values at most 128 bytes, summaries 512 bytes,
  evidence 32 KiB, URLs 2048 bytes, and file paths 1024 bytes.

The engine validates the artifact against live state before any write:

1. manifest repo, PR URL number, and artifact subject agree;
2. `gh view` reports the PR open and returns `headRefOid`;
3. artifact `head_sha` equals that exact current PR head;
4. artifact id and canonical content SHA-256 digest have not been consumed;
5. the normal landed/cloud/cycle guards still pass.

On success Ship writes the synthesized address document, then atomically records
the consumed artifact, advances the stream to the next address cycle, persists
`workOnCurrentBranch: true`, appends the address attempt, and sets the stream to
`dispatching`. The engine then starts that already-prepared attempt through the
existing continuation path. A failed dispatch is recovered through `decide retry`,
which reuses the recorded address document; the same artifact is never submitted
again.

## Tradeoffs

Parsing without durable consumption permits duplicate dispatch; durable consumption
without exact-head validation can make stale review text authoritative. Both
invariants must hold at the same boundary, so they ship as one atomic unit.

## EDs

1. **Ship validates transport and routing facts, not finding truth.** It checks
   sources exist and agree with panel metadata; it does not decide whether a bot
   is correct, merge findings semantically, or choose which findings to address.
2. **Engine-owned review cycles stay engine-owned.** The artifact has no cycle
   counter. A producer must not read deep Ship state merely to manufacture one;
   the durable consumption row links artifact, stream, and resulting engine cycle.
3. **Replay identity is semantic, not byte-level.** `artifact_id` catches replay
   of the same envelope. A canonical SHA-256 digest catches a producer retry that
   regenerates the envelope id or timestamp, reformats JSON, or reorders sets.
   The digest input is a fixed known-field projection containing
   `schema_version`, `decision`, `subject`, normalized `panel`, and normalized
   `findings`; it excludes `artifact_id`, all of `producer`, and every unknown
   optional/receipt field. Canonicalization writes object keys in a fixed order,
   sorts each panel array, sorts findings by finding id, sorts each finding's
   sources by `(reviewer, comment_id, url, file, line)`, serializes stable JSON,
   and hashes those UTF-8 bytes. Thus transport metadata and collection ordering
   cannot turn one review result into a second dispatch. Both artifact id and
   canonical digest are unique.
4. **Consumption and dispatch preparation are one store transaction.** Recording
   consumption before a separate stream update creates a crash window; updating
   the stream first permits duplicate dispatch. The store method inserts the
   consumption row and compare-and-updates the expected landed stream and current
   review cycle in one SQLite transaction. That update appends the attempt with
   its synthesized `docPath` and leaves the stream in `dispatching` before any
   external call. A crash before `startShip` is therefore handled by Ship's
   existing dispatch-recovery path: no matching candidate resets the stream to
   `pending` while preserving its attempts, and the next dispatch tick resolves
   the latest attempt's `docPath` and re-dispatches that recorded document.
   The synthesized document write intentionally precedes this transaction. Its
   path and content are deterministic for `(stream, next cycle, artifact)`, and no
   external dispatch occurs before commit. A crash between file write and commit
   can leave only an orphan file; retry overwrites the same path, then performs
   the first and only dispatch. Moving filesystem rename "inside" SQLite would
   not make the two resources atomic.
5. **Missing reviewers do not block address.** Addressing known findings may
   proceed while a reviewer is absent. The artifact preserves `panel.missing`;
   the later Gate path must not reinterpret that as clean evidence.
6. **Existing free-form findings stop being accepted.** This is a versioned
   boundary break, not an auto-detection shim. A markdown fallback would preserve
   the untestable path the contract is meant to remove.
7. **`decision` is closed to `address` in v1.** Unlike severity, the command acts
   on this field by dispatching work. A future no-action/reject artifact is a new
   schema major or a different consumer, not an unknown value Ship passes through.

## Data model

Migration `0015_driver_review_artifacts.sql` adds:

```sql
CREATE UNIQUE INDEX driver_streams_run_id_id_idx
  ON driver_streams (driver_run_id, id);

CREATE TABLE driver_review_artifacts (
  artifact_id TEXT PRIMARY KEY,
  canonical_sha256 TEXT NOT NULL UNIQUE,
  driver_run_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  address_cycle INTEGER NOT NULL,
  doc_path TEXT NOT NULL,
  consumed_at TEXT NOT NULL,
  UNIQUE (driver_run_id, stream_id, address_cycle),
  FOREIGN KEY (driver_run_id, stream_id)
    REFERENCES driver_streams(driver_run_id, id) ON DELETE CASCADE
);
```

The store exposes one sharp operation:
`consumeReviewArtifactAndPrepareDispatch(input)`. It refuses duplicate artifact
id/canonical digest,
non-landed state, and stale expected cycle with typed store errors; inserts the
row; appends the prepared attempt; updates `review_cycles`,
`work_on_current_branch`, and status `dispatching`; and bumps the parent timestamp
inside one transaction.

The artifact row retains `doc_path` as audit history; the attempt copy is the
operational recovery source used by `resolveDispatchDocPath`. Foreign-key
violations mean the engine/store contract was called with impossible run or
stream identity and remain programming errors rather than user-facing address
refusals.

## Refusals

Extend `AddressRefusalCode` with:

- `findings-invalid` — malformed JSON or schema/consistency failure;
- `findings-subject-mismatch` — repo or PR number differs;
- `findings-stale-head` — reviewed head differs from live `headRefOid`;
- `findings-duplicate` — artifact id or canonical digest already consumed;
- `address-raced` — compare-and-update found a non-landed stream or a different
  current review cycle after validation.

Existing `findings-unreadable` remains for missing, unreadable, empty, or
over-limit files. Every refusal occurs before dispatch and leaves stream/cycle
state unchanged.

## Validation

Example tests pin every refusal code and one successful address flow.

Bounded deterministic `fast-check` properties run at least 100 cases each with
a printed seed/counterexample:

1. **Exact head:** replacing a valid artifact head with any different 40-hex head
   never dispatches and never consumes.
2. **Unsourced input:** removing all findings, evidence, sources, or the source
   reviewer's completed-panel membership never dispatches. Adding one invalid
   source among otherwise valid findings/sources also always refuses. Blank and
   whitespace-only evidence, summary, producer id, reviewer id, and finding id
   refuse as well.
3. **At most once:** for generated repeated sequences of one artifact, same-id
   variants, and canonical replay variants with regenerated artifact ids and
   timestamps, reformatted JSON, and reordered panel/finding/source arrays, Ship
   dispatches at most once.
   A dedicated `Promise.all` example sends two concurrent calls; SQLite serializes
   the writes and exactly one consume-and-prepare transaction wins.
4. **Extension tolerance:** adding unknown optional fields at any object level,
   including individual source objects, preserves the routing projection,
   canonical digest, and outcome.
5. **Panel partition:** generated valid requested/completed/missing partitions
   parse; overlap, omission, and extras refuse.
6. **Transaction recovery:** store reopen preserves consumption, resulting cycle,
   and the prepared address attempt. A fake start port that throws after the
   transaction commits simulates crash-before-start; a reopened engine then runs
   existing dispatch recovery and re-dispatches the recorded doc. Store tests
   install a temporary SQLite `BEFORE UPDATE` trigger that raises after the
   artifact insert; the transaction must roll back both rows without a production
   test hook. A filesystem-port write failure proves no consume/dispatch occurs;
   a write followed by forced transaction rollback leaves an orphan that a retry
   deterministically overwrites before the first dispatch.

The existing `driver address` state/refusal suite remains green. `make check`
must pass on Windows and Ubuntu.

## Risks

- **Schema becomes coordinator policy.** Avoided by limiting Ship to evidence
  presence, source/panel consistency, and exact routing identity.
- **Idempotency blocks recovery.** The atomic transition also prepares a normal
  `dispatching` attempt with the synthesized `docPath`. Existing recovery can
  adopt a started run or reset/re-dispatch one that never started; failed starts
  stay `decide retry`, never a second address call.
- **GH adapter drift.** `viewPullRequest` adds `headRefOid` to its existing
  query and fake port; exact-head behavior is tested at the port and engine.
- **Oversized bot evidence.** Hard bounds fail closed before prompt construction.
- **Concurrent address calls.** SQLite's write lock plus the unique artifact id /
  canonical digest and expected-cycle compare-and-update serialize the winner;
  the loser maps to `findings-duplicate` or `address-raced` and never starts Ship.

## Out of scope

- GitHub comment ingestion or reviewer selection.
- Semantic dedupe, false-positive adjudication, or merge authorization.
- Updating the producer skills; that follows after this boundary merges.
- MCP `driver_address` parity.
- The two live Claude/Codex Gate B dogfood runs.

## Implementation plan

1. Land parser/types, a narrow injectable address-file port, and generated
   contract tests.
2. Add migration 0015, transactional consume-and-prepare operation, and
   uniqueness/reopen/crash-before-start tests.
3. Extend the GH view with `headRefOid`; refactor address dispatch to start an
   already-prepared attempt after validation and durable consumption.
4. Update CLI fixtures/docs from markdown to JSON and run the full check matrix.
