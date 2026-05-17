/**
 * `@ship/cursor-runner` — public barrel. Other packages reach SDK
 * types via the re-exports below; ED-2's import-isolation test
 * (`test/sdk-import-isolation.test.ts`) enforces that no other package
 * names `@cursor/sdk` directly. `FakeCursorRunner` is exposed under
 * the `./test/fake` subpath, not this barrel.
 */

// --- runner.ts ---
export type { CursorRunHandle, CursorRunInput, CursorRunner, CursorRunResult } from "./runner.js";

// --- local-runner.ts ---
export { LocalCursorRunner } from "./local-runner.js";

// --- errors.ts ---
export { CursorRunFailedError, MissingApiKeyError } from "./errors.js";

// --- @cursor/sdk re-exports ---
export type { AgentDefinition, McpServerConfig, SDKMessage } from "@cursor/sdk";
