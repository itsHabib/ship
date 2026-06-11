**Status**: ready for impl
**Owner**: @michael
**Date**: 2026-06-10
**Related**: dossier task `driver-manifest-schema-parser` (id: `tsk_01KTRZR9R5BSY5BTFY56X2ZJ3Z`); locked design [docs/features/driver-extraction/spec.md](../spec.md) — §2 FR1, §5 (v2 render-fidelity note), §9 P1.

# @ship/driver bootstrap — strict manifest schema + parser + golden fixtures

## Scope

| Bucket | Files | Est. LOC | Weighted |
|---|---|---|---|
| Production source | `packages/driver/src/manifest.ts` (schema + frontmatter extractor + parser + line-precise error mapping + referential validation), `packages/driver/src/index.ts` | ~310 | 310 |
| Tests + fixtures | `manifest.test.ts`, `test/fixtures/*.driver.md` (synthetic + real historical) | ~680 | 340 |
| Configs / docs | `package.json`, `tsconfig.json`, `vitest.config.ts`, `stryker.conf.json`, `README.md`, `pnpm-lock.yaml` | — | 0 |
| **Total** | | | **~650** |

Band: **ideal** (< 700). No split — schema, parser, and fixtures are one contract; shipping half would pin an untested shape. If implementation pushes past ~700 weighted, cut the dependency-**cycle** check (keep duplicate-id and unknown-ref checks) and note the cut in the PR body; cycles can land with P3's walker.

## Goal

The `driver_version: 1` manifest (`/work-driver-prep` output) exists only as prose convention; nothing validates it. This phase turns the input contract into code: a new `@ship/driver` package whose strict zod schema + parser is the single typed entry point every later phase (P2 import, P3 engine) consumes. Parse errors must be actionable — line-precise where feasible, never a raw throw.

This is spec §9 **P1**. It needs only §2-FR1 and the manifest shape, which is locked by the existing real manifests — not by §5 (that's P2's store model; do not implement any of it here).

## Behavior

### 1. Package scaffold

`packages/driver/`, mirroring `@ship/receipt` exactly in shape:

- `package.json`: name `@ship/driver`, private, `"type": "module"`, main/types/exports → `./src/index.ts`, deps `yaml` + `zod` (same versions as receipt), devDeps mirroring receipt (vitest 2.1.9, stryker 9.6.1, tsx, @types/node). No `bin` (no CLI in this phase).
- `tsconfig.json` extends the repo base, same as receipt's.
- `vitest.config.ts` with coverage thresholds **statements 90 / branches 85 / functions 90 / lines 90**, excluding `src/index.ts` from the gate the way receipt excludes its entrypoints.
- `stryker.conf.json` mirroring receipt's.
- Short `README.md`: what the package is (the driver-manifest input contract as code), pointer to the spec.
- The `pnpm-workspace.yaml` glob `packages/*` already covers it; run `pnpm install` so the lockfile picks the package up.

**No dependency on `@ship/core`, `@ship/store`, or any other workspace package.** This package is leaf-level: `yaml` + `zod` only.

### 2. Strict zod schema (`manifest.ts`)

Model the full manifest shape as observed across every real portfolio manifest. `.strict()` at every level **except** the advisory blocks (see below). Required vs optional below is the contract — derived from the real corpus, where field presence varies by manifest age and form:

Top level (strict):

| Field | Type | Req? |
|---|---|---|
| `driver_version` | literal `1` — any other value → clear "unsupported driver_version" error | required |
| `generated_at` | string (keep as string — do NOT coerce to Date; YAML 1.2 core schema leaves timestamps as strings and render fidelity needs them byte-stable) | required |
| `generated_by` | string | required |
| `source` | strict object `{ project: string, phase: string }` | required |
| `repo` | string | required |
| `repo_url` | string | optional |
| `branch_prefix` | string | optional |
| `default_runtime` | enum `local \| cloud \| rooms` | optional |
| `batches` | array of batch (below); empty array is valid | required |
| `conflict_notes` | array, advisory (lenient — below) | optional |
| `skipped_during_resolution` | array, advisory | optional |
| `runtime_notes` | advisory | optional |

Batch (strict):

| Field | Type | Req? |
|---|---|---|
| `id` | int | required |
| `label` | string | optional |
| `depends_on` | int[] (empty valid) | required |
| `status` | enum `pending \| running \| in_progress \| done \| failed` | optional |
| `completed_at` | string | optional |
| `streams` | array of stream; empty valid | required |

Stream (strict):

| Field | Type | Req? |
|---|---|---|
| `spec_path` | string | **required** (the one thing the engine cannot work without) |
| `task_id` | string | optional (ad-hoc and some real manifests omit it) |
| `task_slug` | string | optional |
| `branch_name` | string | optional (cloud streams let cursor pick the branch) |
| `runtime` | enum `local \| cloud \| rooms` | optional (older manifests omit it; resolution against `default_runtime` is P3 policy, not schema defaulting) |
| `touches` | string[] | optional, default `[]` |
| `status` | enum `pending \| todo \| in_progress \| done \| failed \| skipped` | optional |
| `pr_number` | int | optional |
| `merge_commit` | string | optional |
| `merged_at` | string | optional |
| `cycles` | int | optional |

**Advisory blocks** (`conflict_notes`, `skipped_during_resolution`, `runtime_notes`): these are prep-time human notes, not engine input — entries vary freely (`kind`/`file`/`tasks`/`note`/`from`/`to`/`reason`/`workaround`, prose strings, etc.). Model them as lenient passthrough records (or unknown-but-present arrays) and document the choice in a comment: strictness guards the engine's input; it does not police advisory prose. Strict-unknown-field rejection applies everywhere *else*.

**Widening rule:** if the repo sweep test (below) surfaces a real manifest field this table misses, widen the schema to cover it and pin that manifest as a fixture — never loosen to passthrough outside the advisory blocks.

### 3. Frontmatter extractor

- Tolerates a leading UTF-8 BOM and CRLF line endings (Windows-authored manifests are CRLF — strip/normalize at the boundary, like receipt's `extractFrontmatter`).
- Missing leading `---` fence, or unterminated fence → `ok: false` with an actionable message (e.g. `missing driver manifest frontmatter (expected leading "---" fence)`), not a throw.
- Returns the frontmatter text **and its starting line offset in the file**, so YAML line numbers map back to real file lines.

### 4. Parser with line-precise errors

Result-shaped, total — never throws:

```ts
export function parseManifest(text: string): ParseManifestResult;

export type ParseManifestResult =
  | { ok: true; manifest: DriverManifest; rawFrontmatter: string }
  | { ok: false; errors: ManifestParseError[] };

export interface ManifestParseError {
  message: string;       // lowercase, actionable, names the field/value at fault
  path?: string;         // zod-style dotted path, e.g. "batches[1].streams[0].spec_path"
  line?: number;         // 1-based file line where the offending node sits
  column?: number;
}
```

- **`rawFrontmatter` is the frontmatter text verbatim (pre-parse).** P2 stores it as `source_json` per spec §5's v2 render-fidelity note — a `.strict()` parsed object would strip future fields and break render round-trip. Expose it now so P2 doesn't re-extract.
- **YAML syntax errors**: surface the `yaml` library's own line/col (`linePos`) in `ManifestParseError`, offset by the frontmatter's file offset.
- **Schema violations**: parse with `yaml`'s `parseDocument` (keeps node ranges, use its `LineCounter`); on zod failure, resolve each issue's path through the YAML AST to a node range → file line/col. Where a path can't resolve to a node (e.g. a missing required field), keep `path` and omit `line` — "line-precise where feasible," per the task.
- **Strict-mode rejections name the field**: an unknown key produces a message like `unknown field "branch_prefx" at batches[0].streams[1] — did you mean a known stream field?` (the "did you mean" nicety is optional; naming field + path is required).
- YAML that parses to a non-object (scalar/array at top level) → actionable error, not a zod stack.

### 5. Referential validation (post-zod, same error shape)

Cheap input-contract checks the P3 walker should never have to re-derive:

- duplicate batch `id`s → error naming the id;
- `depends_on` referencing a non-existent batch id → error naming both ids;
- self-dependency and dependency cycles → error naming the cycle (`1 → 3 → 1`).

These emit `ManifestParseError`s (with the offending batch's line where feasible) through the same `ok: false` channel.

### 6. Exports (the P2/P3 contract)

From `src/index.ts`: `parseManifest`, `ParseManifestResult`, `ManifestParseError`, `DriverManifest`, `ManifestBatch`, `ManifestStream`, and the schema objects themselves (P2 hydration reuses them). Keep the surface to exactly what P2/P3 need — nothing speculative.

## Golden fixtures

`packages/driver/test/fixtures/`:

1. **`synthetic-full.driver.md`** — synthetic, every schema field populated: `repo_url`, `default_runtime`, mixed-runtime streams (`local` + `cloud` + `rooms`), multi-batch with `depends_on` chains, a `failed` stream, all three advisory blocks, `cycles`, `completed_at`. The full-coverage pin.
2. **`hygiene-followups.driver.md`** — the REAL historical manifest from the dossier portfolio (the first full work-driver run, 2026-05-17, 6 batches / 9 streams, `conflict_notes` + `skipped_during_resolution`, streams with `branch_name` but **no** `runtime`). Its full content is **Appendix A** below — copy it into the fixture **byte-for-byte** (it is not otherwise reachable from this repo).

Plus a **repo sweep test**: glob `docs/features/**/driver.md` in this repo at test time and assert every file parses `ok: true` (ship has several real manifests in-tree — `polish-round-1`, `ship-hardening`, `observability/phases`). This is the task's acceptance line "every existing portfolio driver.md parses clean" made executable, and it catches future manifest-shape drift the day it lands.

## Acceptance

- Both golden fixtures + every in-repo `docs/features/**/driver.md` parse `ok: true` (fixture-pinned + sweep).
- Malformed YAML and schema violations produce actionable `ManifestParseError`s with path and (where feasible) line/col — never a throw, never a zod stack dump.
- Strict mode rejects unknown fields with a message naming the field and path; advisory blocks are exempt.
- BOM and CRLF inputs parse identically to clean LF input.
- `rawFrontmatter` is byte-identical to the input's frontmatter block.
- `parseManifest` is total (property: arbitrary string input never throws).
- Coverage thresholds met; stryker config present; `make check` green on ubuntu + windows CI.

## Test plan

L1 over schema + parser, table-driven where natural:

- valid: minimal manifest (only required fields), full synthetic, both real fixtures, empty `batches`, empty `streams`, stream with only `spec_path`;
- invalid: missing each required field (path named), unknown field at each strict level (field named), wrong `driver_version`, non-object YAML, malformed YAML (line/col asserted), unterminated fence, missing frontmatter;
- edge: BOM, CRLF, CRLF+BOM, duplicate batch id, unknown `depends_on` ref, self-dep, 3-cycle;
- totality: fuzz/property — `parseManifest(arbitrary string)` never throws;
- repo sweep test as above.

Mutation score not reduced (run stryker locally; CI doesn't gate it).

## Out of scope

- **P2** (migration `0005`, store verbs, `importManifest`, `render`) and **P3** (walker/dispatcher/poller) — export the types; implement nothing that touches a database or `ShipService`.
- Any CLI or MCP surface.
- **Do NOT refactor `@ship/receipt`.** Receipt's lenient `.passthrough()` manifest parser is a deliberately different contract — a forgiving recap adapter that must not fail on odd manifests, vs this package's strict input contract that must. Leave receipt untouched; any unification is a separate, later decision.
- Runtime defaulting / `default_runtime` resolution semantics (P3 policy).

## Implementation plan

1. Scaffold `packages/driver` (configs mirroring receipt) + `pnpm install`.
2. `manifest.ts`: schema → extractor → parser → error mapping.
3. Referential validation.
4. Fixtures (synthetic + Appendix A copy) + test suite + repo sweep.
5. README, exports, `make check` clean.

Single PR. Title: `feat(driver): strict manifest schema + parser + golden fixtures (P1)`. Include **this doc** in the PR at `docs/features/driver-extraction/phases/driver-manifest-schema-parser.md` (verbatim — it's the contract of record per the repo's phase-doc convention).

---

## Appendix A — real historical fixture (copy byte-for-byte to `test/fixtures/hygiene-followups.driver.md`)

````markdown
---
driver_version: 1
generated_at: 2026-05-17T23:00:00Z
generated_by: work-driver-prep
source:
  project: dossier
  phase: hygiene-followups
repo: dossier
branch_prefix: tower/hygiene-

batches:
  - id: 1
    label: ready now
    depends_on: []
    status: done
    completed_at: 2026-05-18T02:25:30Z
    streams:
      - task_id: tsk_01KRSZFXMNZYKCMWYV3Z85E6XJ
        task_slug: actor-on-update-verbs
        spec_path: docs/features/hygiene-followups/actor-on-update-verbs.md
        branch_name: tower/hygiene-actor-on-update-verbs
        touches: [src/server.rs]
        status: done
        pr_number: 24
        merge_commit: e966e87ddf963f19b0e7e13e5424cd9162893532
        merged_at: 2026-05-18T02:22:26Z
        cycles: 2
      - task_id: tsk_01KRV8788KM9JCS9YDWD0H6WJ5
        task_slug: sort-determinism-secondary-key
        spec_path: docs/features/hygiene-followups/sort-determinism-secondary-key.md
        branch_name: tower/hygiene-sort-determinism
        touches: [src/store.rs]
        status: done
        pr_number: 25
        merge_commit: d6085a7f1c4f7603f174170e5a1ee81423fc4792
        merged_at: 2026-05-18T02:24:10Z
        cycles: 2
      - task_id: tsk_01KRW29YMNAG063612PHZY4EH6
        task_slug: phase-slug-cross-project-collision
        spec_path: docs/features/hygiene-followups/phase-slug-cross-project-collision.md
        branch_name: tower/hygiene-phase-slug-collision
        touches: [PROTOCOL.md]
        status: done
        pr_number: 26
        merge_commit: 4cdcf075cf3716d1e249a5de3d5af2da0bf2fa18
        merged_at: 2026-05-18T02:23:28Z
        cycles: 2

  - id: 2
    label: after batch 1
    depends_on: [1]
    status: done
    completed_at: 2026-05-18T03:13:45Z
    streams:
      - task_id: tsk_01KRSZG60JG3S0JF294AA3459V
        task_slug: uniform-error-data-taxonomy
        spec_path: docs/features/hygiene-followups/uniform-error-data-taxonomy.md
        branch_name: tower/hygiene-uniform-errors
        touches: [src/server.rs]
        status: done
        pr_number: 28
        merge_commit: da40087f83bfe9e8d009a63eb973c99de67c8bf7
        merged_at: 2026-05-18T03:13:32Z
        cycles: 2
      - task_id: tsk_01KRSZFQNBR0HNTV12D2D97MTH
        task_slug: slug-validation-remaining-paths
        spec_path: docs/features/hygiene-followups/slug-validation-remaining-paths.md
        branch_name: tower/hygiene-slug-validation
        touches: [src/store.rs]
        status: done
        pr_number: 29
        merge_commit: c17ba6f82e4ce755db47466ae46d7a05c6713050
        merged_at: 2026-05-18T03:13:45Z
        cycles: 2

  - id: 3
    label: after batch 2
    depends_on: [2]
    status: done
    completed_at: 2026-05-18T05:25:10Z
    streams:
      - task_id: tsk_01KRSZFZY8DGTE19QSRYV0W3BA
        task_slug: phase-created-by-parity
        spec_path: docs/features/hygiene-followups/phase-created-by-parity.md
        branch_name: tower/hygiene-phase-created-by
        touches: [src/domain.rs, src/store.rs, src/server.rs, LAYOUT.md]
        status: done
        pr_number: 31
        merge_commit: 1efbd9288192a672a3d39f3760fbfe98a82d74fa
        merged_at: 2026-05-18T05:25:10Z
        cycles: 2

  - id: 4
    label: after batch 3
    depends_on: [3]
    status: done
    completed_at: 2026-05-18T05:48:07Z
    streams:
      - task_id: tsk_01KRSZFVCFPYRN3Q7RCFGQ89HQ
        task_slug: clean-update-project-not-found
        spec_path: docs/features/hygiene-followups/clean-update-project-not-found.md
        branch_name: tower/hygiene-clean-update-project
        touches: [src/store.rs]
        status: done
        pr_number: 33
        merge_commit: d9fc35c37f3d26fb8f4386ea7d7ef0e796c750dc
        merged_at: 2026-05-18T05:48:07Z
        cycles: 1

  - id: 5
    label: after batch 4
    depends_on: [4]
    status: done
    completed_at: 2026-05-18T05:48:52Z
    streams:
      - task_id: tsk_01KRSZG2ZYV3BTY6E8HCPHG8S1
        task_slug: frontmatter-field-drift-test
        spec_path: docs/features/hygiene-followups/frontmatter-field-drift-test.md
        branch_name: tower/hygiene-frontmatter-drift
        touches: [src/store.rs]
        status: done
        pr_number: 34
        merge_commit: 36ed39d57c9c04ea080f288c1da94c4f78c28476
        merged_at: 2026-05-18T05:48:52Z
        cycles: 1

  - id: 6
    label: after batch 5
    depends_on: [5]
    status: done
    completed_at: 2026-05-18T06:04:10Z
    streams:
      - task_id: tsk_01KRW29PGBCV2MDQ7KJTMJ27EJ
        task_slug: task-get-by-id-verb
        spec_path: docs/features/hygiene-followups/task-get-by-id-verb.md
        branch_name: tower/hygiene-task-get-by-id
        touches: [src/store.rs, src/server.rs, src/domain.rs]
        status: done
        pr_number: 36
        merge_commit: baad7bdeb4284c1f52b6088b2a1adcbd12b123ac
        merged_at: 2026-05-18T06:04:10Z
        cycles: 1

conflict_notes:
  - kind: file_overlap
    file: src/store.rs
    tasks: [slug-validation-remaining-paths, clean-update-project-not-found, sort-determinism-secondary-key, frontmatter-field-drift-test, task-get-by-id-verb, phase-created-by-parity]
  - kind: file_overlap
    file: src/server.rs
    tasks: [actor-on-update-verbs, uniform-error-data-taxonomy, clean-update-project-not-found, task-get-by-id-verb, phase-created-by-parity]
  - kind: dep_signal
    from: phase-created-by-parity
    to: actor-on-update-verbs
    reason: "actor field semantics — actor stays on create verbs; phase-created-by uses it in add_phase. naturally respected because file conflict puts them in different batches anyway."

skipped_during_resolution:
  - reason: "ship project_get response exceeded MCP output limit (94k chars); could not enumerate its phases"
    workaround: "no impact on this run — hygiene-followups exists only in dossier. file follow-up: dossier needs a project.get summary variant (no bodies). horizon.md already gestures at this."
---

# Hygiene-followups execution plan

Generated by `/work-driver-prep phase:hygeine-followups` (operator typed `hygeine` — resolved to `hygiene-followups` in dossier via close-spelling match) on 2026-05-17. Consumed by `/work-driver docs/features/hygiene-followups/driver.md`.

## Source

Phase `hygiene-followups` in project `dossier` — 9 todo tasks at time of prep.

## Topology

Six batches, sequenced by file-overlap conflicts on `src/store.rs` and `src/server.rs` (the hotspots). Wall-clock estimate: ~4–6 hours depending on review cadence; most of it idle wait between batches.

## Batches

### Batch 1 — ready now (3 parallel-safe)

| Task | Touches |
|---|---|
| `actor-on-update-verbs` | `src/server.rs` (arg struct edits, narrow) |
| `sort-determinism-secondary-key` | `src/store.rs` (sort fns only, narrow) |
| `phase-slug-cross-project-collision` | `PROTOCOL.md` (docs only) |

### Batch 2 — after Batch 1 merges (2 parallel-safe)

| Task | Touches |
|---|---|
| `uniform-error-data-taxonomy` | `src/server.rs` (wide-blast: every handler) |
| `slug-validation-remaining-paths` | `src/store.rs` (wide-blast: every slug-derived path) |

### Batch 3 — after Batch 2 (1 stream)

| Task | Touches |
|---|---|
| `phase-created-by-parity` | `src/domain.rs` + `src/store.rs` + `src/server.rs` + `LAYOUT.md`. Dep on `actor-on-update-verbs` satisfied by Batch 1. |

### Batch 4 — after Batch 3 (1 stream)

| Task | Touches |
|---|---|
| `clean-update-project-not-found` | `src/store.rs` (probably `src/server.rs` indirectly) |

### Batch 5 — after Batch 4 (1 stream)

| Task | Touches |
|---|---|
| `frontmatter-field-drift-test` | `src/store.rs` test module |

### Batch 6 — after Batch 5 (1 stream)

| Task | Touches |
|---|---|
| `task-get-by-id-verb` | `src/store.rs` + `src/server.rs` + `src/domain.rs` |

## Conflict topology

The store.rs and server.rs hotspots dominate. The narrow / wide-blast distinction is heuristic — if the agent's actual edits prove narrower (e.g. `sort-determinism` truly only touches the sort functions), `/work-driver`'s Step 6 rebase pattern lets a subsequent merge proceed without redoing the whole batch.

## Dep signal

`phase-created-by-parity` depends on `actor-on-update-verbs` per the body of `phase-created-by-parity.md`. Both end up in different batches anyway due to file conflict, so the dep is naturally respected — but documented here so the dep doesn't surprise a future re-prep.

## Skipped during resolution

`mcp__dossier__project_get { slug: "ship" }` exceeded the MCP output limit (94k chars). No impact on this run — `hygiene-followups` is exclusive to dossier — but worth filing a follow-up: dossier needs a `project.get` summary variant (or pagination) so the corpus walk doesn't fail closed on projects with deep history.

````
