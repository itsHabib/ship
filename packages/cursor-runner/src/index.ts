/**
 * `@ship/cursor-runner` — public barrel export (main entry).
 *
 * The package owns every line of code in the monorepo that imports
 * `@cursor/sdk`. Other packages reach SDK types via the re-exports
 * below — never via direct `@cursor/sdk` imports. ED-2's import-
 * isolation test (`test/sdk-import-isolation.test.ts`) enforces that
 * invariant at CI time.
 *
 * What ships here:
 * - The substrate-agnostic `CursorRunner` interface plus its input /
 *   handle / result types. The contract `core` codes against.
 * - `LocalCursorRunner` — the V1 implementation that drives a local
 *   Cursor agent via `Agent.create({ local: { cwd } })`.
 * - Typed errors for the two pre-run failure modes.
 * - Re-exports of the SDK types other packages structurally need
 *   (`SDKMessage`, `McpServerConfig`) so they can be reached without
 *   naming `@cursor/sdk` directly.
 *
 * What does NOT ship here:
 * - `FakeCursorRunner` — exported under the `./test/fake` subpath so
 *   consumer production code can never import it accidentally. See
 *   `package.json#exports`.
 *
 * Stability promise (within V1): adding fields to `CursorRunInput` /
 * `CursorRunHandle` / `CursorRunResult` is fine if optional. Removing
 * or renaming is a breaking change that updates `core` (and any other
 * consumer) in the same commit.
 */

// --- runner.ts ---
export type { CursorRunHandle, CursorRunInput, CursorRunner, CursorRunResult } from "./runner.js";

// --- local-runner.ts ---
export { LocalCursorRunner } from "./local-runner.js";

// --- errors.ts ---
export { CursorRunFailedError, MissingApiKeyError } from "./errors.js";

// --- @cursor/sdk re-exports (so consumers don't name the SDK directly) ---
export type { McpServerConfig, SDKMessage } from "@cursor/sdk";
