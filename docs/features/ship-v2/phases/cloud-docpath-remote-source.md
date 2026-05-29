# Cloud docPath remote sourcing

Status: design draft
Owner: ship (cursor)
Date: 2026-05-29

> Predecessor: [09-cloud-parity.md](09-cloud-parity.md). Phase 09 made `workdir` optional for cloud and dropped the realpath-inside-workdir containment guard, but the **doc-existence** check survived: ship still reads the task doc off local FS to embed its content into the prompt + write the `task-doc.md` artifact. Trigger: operator friction (dossier `tsk_01KSE5GVZ5THWX9BPVKNN2CHDY`, 2026-05-24) — "cloud mode making me pass a local dir doesn't make sense." Operator decision 2026-05-29: fix in a PR (not document-and-accept).

## Scope

**Weighted LOC budget — ~350, "amazing" band, 1 PR.**

Files this phase touches:

- `packages/core/src/validate.ts` — `resolveValidatedDocForCloud` gains a remote-fallback path (local hit → embed local; local miss → fetch from repo@ref).
- `packages/core/src/service.ts` — `prepareRun` (cloud branch) passes the repo + ref through to the resolver; `prepareArtifacts` gets a **one-line change** (`validated.content ?? fs.readFile(absoluteDocPath)`) so a remote-fetched doc with no local file still embeds + writes `task-doc.md` — see ED-6.
- `packages/core/src/doc-source/` (new) — `remoteDocSource.ts`: thin `@octokit/rest` wrapper that fetches a blob at `{ owner, repo, path, ref }`. Behind an interface so it's swappable + fakeable.
- `packages/core/src/errors.ts` — new `RemoteDocFetchError` (network/auth/404 from the remote fetch, distinct from local `DocNotFoundError`); `DocNotFoundError` message gains cloud-aware guidance.
- `packages/core/src/service.ts` wiring — inject the doc source via `ShipServiceDeps` (default = octokit-backed; tests inject a fake).
- Test churn: unit tests for the three resolver paths (local-hit / remote-hit / both-miss) + a fake doc source in `@ship/test-harness`; one L3 scenario `cloud-no-local-doc.e2e.test.ts`.

`@octokit/rest` is **already a `@ship/core` dependency** (orphaned since `open_pr` removal — imported nowhere today). This phase repurposes it. If this phase is declined, that dep should be removed as dead-code hygiene instead.

## Summary

Today a cloud `ship.ship` call only succeeds if the task doc resolves on the **ship-process machine's** filesystem — because `prepareArtifacts` (`service.ts:611`) reads the doc and embeds its content into the prompt, and `resolveValidatedDocForCloud` (`validate.ts:21`) asserts the file exists locally first. The cloud agent never reads the doc as a file (it gets the embedded content), so requiring a local copy is a local-first residue that contradicts the "cloud = remote" mental model.

The fix sources the doc from the **repo the cloud agent will clone** when it isn't available locally. Net behavior:

- **Local hit** (caller passed `workdir` + the doc is there, or an absolute local `docPath`): embed from local — **unchanged**, zero regression for every current caller including this session's driver flow.
- **Local miss** on a cloud run: fetch `docPath` from `cloud.repos[0]` at the starting ref via octokit, embed that. A no-local-checkout cloud call now works **as long as the doc is committed to the branch**.
- **Both miss**: a single clear error naming both causes (not on local FS; not in `<repo>@<ref>`).

No new MCP surface, no new runtime, no change to `pool`/`machine` (operator: keep those — they're Cursor's). Local runs are untouched (`resolveValidatedDoc` unchanged).

## Functional requirements

### F1 — Cloud doc resolution is local-first, remote-fallback

`resolveValidatedDocForCloud(fs, docPath, { workdir?, repo?, ref?, docSource })`:

1. If `docPath` resolves to a readable file locally (absolute, or joined with `workdir` when present) → return its content (current behavior).
2. Else, if a remote repo + ref are known → fetch `docPath` (repo-root-relative) from `repo@ref` via `docSource`. Embed the fetched content.
3. Else → throw with both causes named.

The returned `ValidatedDoc` carries an optional **`content`**: set to the fetched bytes on a remote hit (path 2), left undefined on a local hit (path 1, where `absoluteDocPath` suffices). `prepareArtifacts` then embeds `validated.content ?? fs.readFile(validated.absoluteDocPath)` — local callers re-read from disk byte-for-byte as today, and the remote case embeds the fetched content with no local file. (Cycle-1 review caught that the original "prepareArtifacts unchanged" claim was wrong: a remote doc has no local path to re-read.)

### F2 — Remote source is an injected, fakeable seam

`DocSource` exposes **both** the fetch and the ref-resolution it depends on, so every GitHub call sits behind one fakeable seam:

- `fetch({ owner, repo, path, ref }): Promise<string>` — the blob.
- `resolveRef({ owner, repo, startingRef?, prUrl?, workOnCurrentBranch? }): Promise<string>` — returns the concrete ref per F3's precedence; the default-branch + PR-head lookups live **here**, not in core.

Default impl wraps `@octokit/rest` (`repos.getContent` + `repos.get` / PR lookup). Injected via `ShipServiceDeps.docSource` (defaults in `createDefaultShipService`). Tests inject a fake → **no network in unit/L1/L2**. (Cycle-3 catch: the ref lookups must be inside the seam too, else an injected fake still hits the network or forces core to know Octokit directly.)

### F3 — Owner/repo/ref derivation

- owner/repo parsed from `cloud.repos[0].url` (handles `https://github.com/<owner>/<repo>(.git)?`).
- ref precedence: `cloud.repos[0].startingRef` when set → else, when the call attaches to an existing PR (`cloud.repos[0].prUrl` set and/or `workOnCurrentBranch: true`), the **PR head branch** (resolved from the prUrl) → else the repo's default branch (one octokit `repos.get`, cached per run). Never the agent's *new* working branch. All of this resolves through `docSource.resolveRef(...)` (F2) so it stays behind the fakeable seam. Cycle-2 catch: `cloud-runner.ts` forwards both `prUrl` and `workOnCurrentBranch` into cloud options, so a doc living only on the PR branch would otherwise be missed or embed stale default-branch content.

### F4 — Auth

octokit token from env (`GITHUB_TOKEN` || `GH_TOKEN`). Public repos resolve tokenless. Private repo + no token + local miss → `RemoteDocFetchError` with the "set GITHUB_TOKEN or pass the doc locally" hint. Token is read at the doc-source layer, never persisted or logged.

## Tradeoffs

- **Local-first vs remote-only.** Remote-only (always fetch from repo) is simpler but breaks the embed-a-local-only-spec flow + forces a behavior change on every current caller. Local-first-remote-fallback is strictly additive — chosen for zero regression.
- **Embed vs delegate.** We keep embedding the doc content (vs telling the agent "read docPath in your checkout"). Embedding preserves the `task-doc.md` artifact + the run's self-contained prompt, and matches phase 09's stated model. Delegation is a bigger change for no clear win.
- **octokit in core.** Adds a live GitHub dependency to the provider-blind core. Mitigation: it's behind the `DocSource` interface (core depends on the interface, not octokit directly); the octokit impl lives in default-wiring. Keeps core's layering honest.

## Engineering decisions

- **ED-1** — Local-first, remote-fallback (F1). Not remote-only. Rationale: zero regression + preserves uncommitted-local-spec shipping.
- **ED-2** — `DocSource` is an injected interface owning **both** `fetch` and `resolveRef` (F2), so the default-branch + PR-head lookups are fakeable, not just the blob fetch; octokit impl in default wiring; fake in test-harness. Core stays provider-blind per `feedback_backend_interfaces.md`. (Cycle-3 catch: ref resolution belongs inside the seam.)
- **ED-3** — Ref precedence: `startingRef` → PR head (when `prUrl` / `workOnCurrentBranch`) → default branch (F3). Never the agent's *new* working branch. Cycle-2 catch: attach-to-PR calls operate on the PR branch, so a doc only on that branch must be fetched from the PR head, not default.
- **ED-4** — `RemoteDocFetchError` is distinct from `DocNotFoundError`; the both-miss path names both causes so the operator knows whether to commit-the-doc or fix-a-path.
- **ED-5** — Local runs are out of scope; `resolveValidatedDoc` (the workdir-containment path) is untouched — it returns `{ absoluteDocPath }` with `content` undefined, so `prepareArtifacts` reads from disk exactly as today. Remote sourcing is cloud-only.
- **ED-6** — `ValidatedDoc` gains an optional `content?: string`; `prepareArtifacts` switches its single read to `validated.content ?? fs.readFile(validated.absoluteDocPath)`. This is the one change to a path shared with local runs (cycle-1 review catch): a remote-fetched doc has no local file to re-read, so its content travels on the resolver's return value. Only the remote-hit branch sets `content`; every other path leaves it undefined → disk read unchanged → byte-identical `task-doc.md` for local callers.

## Validation

- **L1/L2** — resolver unit tests: local-hit (no fetch attempted), remote-hit (fake DocSource returns content), both-miss (error names both), private-no-token (RemoteDocFetchError). URL→owner/repo parsing table test. Default-branch resolution test.
- **L3** — `cloud-no-local-doc.e2e.test.ts`: cloud run with no `workdir` and a `docPath` that exists only in the repo branch; assert the run reaches terminal + `task-doc.md` artifact matches the repo content. Gated on `SHIP_LIVE` + `SHIP_CLOUD`.
- `make check` green.

## Risks

- **Default-branch lookup adds a network call** on the local-miss path. Acceptable — only fires when the doc isn't local, and is cached per run. Local-hit path makes zero network calls.
- **Rate limits** on tokenless public fetches. Low risk for single-operator use; the error surfaces the 403 clearly.
- **URL parsing edge cases** (SSH-form `git@github.com:o/r.git`, trailing slashes). Covered by the parse table test; non-GitHub hosts throw a clear "only github.com remotes supported" error (matches today's cloud scope).

## Out of scope

- `pool` / `machine` env enum trimming — operator decision 2026-05-29: keep as-is (Cursor-native, harmless).
- Agent-reads-from-checkout delegation model (we embed, not delegate — see Tradeoffs).
- Multi-repo doc sourcing (`repos[1..]`) — single-repo only, matches current cloud scope.
- Non-GitHub remotes.

## Implementation plan

Single PR (~350 weighted):

1. `DocSource` interface + `errors.ts` (`RemoteDocFetchError`, `DocNotFoundError` message update).
2. `remoteDocSource.ts` octokit impl + URL/ref derivation helpers.
3. `resolveValidatedDocForCloud` local-first-remote-fallback (F1); `service.ts` cloud `prepareRun` passes repo/ref/docSource through; `prepareArtifacts` content-fallback (ED-6).
4. Default wiring injects the octokit-backed source; `@ship/test-harness` fake.
5. Unit tests (the four paths + parse table) + L3 scenario.

Natural single PR — the seam + impl + tests are tightly coupled and small. No sub-split needed.
