# Follow-ups

Small, agreed-but-not-now items. One line of context each; delete when done.
(House convention: follow-ups live here, not in GitHub issues.)

- **Liveness-based run cap instead of wall-clock-from-creation.** `policy.maxRunDurationMs` (default 30m) killed a near-complete local run that was actively emitting events (2026-07-09, first attempt of #184); the `SHIP_MAX_RUN_DURATION_MS` / `SHIP_AGENT_TIMEOUT_MS` env override is the stopgap (uncommitted at the time). The durable fix is a heartbeat: kill on N minutes of event silence, not on total age — and make the default tier-aware (an opus/high dispatch legitimately runs longer than composer).
- **LocalClaudeRunner: refresh-aware subscription auth.** A frozen `ANTHROPIC_AUTH_TOKEN` env value expires mid-run (~17 min TTL observed) and surfaces as `sdk-throw` 401 at the finish line (2026-07-09, second attempt of #184). Re-read the credentials source per request or accept a token-provider callback instead of a static env token.
- **Dedup the single-stream dispatch-context builder.** `dispatchAddress` and `flipStreamToCloud` share the load-run → find-stream → stamp-running → build-`DispatchContext` → dispatch → reload shape (~15 lines); a `buildSingleStreamDispatchContext` helper would collapse both (claude review on #184, non-blocking).
