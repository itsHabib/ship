# Follow-ups

Small, agreed-but-not-now items. One line of context each; delete when done.
(House convention: follow-ups live here, not in GitHub issues.)

- **Liveness-based run cap instead of wall-clock-from-creation.** `policy.maxRunDurationMs` (default 30m) killed a near-complete local run that was actively emitting events (2026-07-09, first attempt of #184); the `SHIP_MAX_RUN_DURATION_MS` / `SHIP_AGENT_TIMEOUT_MS` env override is the stopgap (uncommitted at the time). The durable fix is a heartbeat: kill on N minutes of event silence, not on total age — and make the default tier-aware (an opus/high dispatch legitimately runs longer than composer).
- **LocalClaudeRunner: refresh-aware subscription auth.** A frozen `ANTHROPIC_AUTH_TOKEN` env value expires mid-run (~17 min TTL observed) and surfaces as `sdk-throw` 401 at the finish line (2026-07-09, second attempt of #184). Re-read the credentials source per request or accept a token-provider callback instead of a static env token.
- **Dedup the single-stream dispatch-context builder.** `dispatchAddress` and `flipStreamToCloud` share the load-run → find-stream → stamp-running → build-`DispatchContext` → dispatch → reload shape (~15 lines); a `buildSingleStreamDispatchContext` helper would collapse both (claude review on #184, non-blocking).

## dispatch policy: remote dispatches without a workdir bypass the file-based ceiling (2026-07-16, PR #219 review)

`enforceDispatchPolicy` requires `ctx.input.workdir` — cloud/rooms calls that omit it skip the
`.ship.json` check entirely, because the v1 policy mechanism is file-discovery up a local tree
(merged spec, #216). Closing it means resolving `.ship.json` from the remote repository at
dispatch (a network fetch with its own failure/trust model) — a design of its own, not a patch.
Until then the ceiling is only as strong as "every governed dispatch supplies a workdir".
(Narrowed by PR #221: driver **cloud** streams now carry the local repo root as their workdir,
so the ceiling AND the credential guard resolve for them; the gap remains for bare `ship.ship`
cloud/rooms calls that pass no workdir.)

## cloud resume/attach uses ambient credentials, not the repo-pinned source (2026-07-17, PR #221)

`resolveDispatchCredential` guards both the local and cloud **dispatch** paths (PR #221), but the
cloud **resume** path — `CloudClaudeRunner.attach`, reached from `resumeOneOrphanedCloudRun` —
still builds its SDK client from the ambient `ANTHROPIC_API_KEY`. The session it re-attaches was
already created under the guard (isolated at dispatch); attach only re-lists that session's events,
so the exposure is a read-only re-list under the ambient credential, not a fresh dispatch. Closing
it means threading policy resolution through resume: the orphan-resume site reconstructs from the
persisted cloud run row, which carries no workdir/repo-root, so it would need BOTH a new cwd field
on `AgentRunAttachInput` AND persisting the repo root on the cloud run row (a store-schema change) —
beyond a small seam. Fail-closed at dispatch beats a half-threaded schema change; documented until
the resume path warrants it.
