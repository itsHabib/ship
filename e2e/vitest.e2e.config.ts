import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for the e2e + integration suites.
 *
 * Three test layers above the per-package unit / scenario suites:
 *
 *   - L3 INTEGRATION (`integration/**\/*.integration.test.ts`):
 *     real `node:fs` + real SQLite file + real subprocess of
 *     `tsx src/bin.ts`, with `FakeCursorRunner` injected so we don't
 *     need an API key. Catches CLI / store / fs interactions the
 *     in-memory `ShipFs` scenario tests can't see. Runs unconditionally.
 *
 *   - L4 LIVE E2E (`scenarios/**\/*.e2e.test.ts`): real `LocalCursorRunner`
 *     against the real Cursor SDK + real workdir + real GitHub (needs
 *     `CURSOR_API_KEY`, `GITHUB_TOKEN`, `SHIP_E2E_SANDBOX_REPO`). Gated on
 *     `SHIP_LIVE=1` only; burns quota and is slow.
 *
 * `test.root` is pinned to this config file's directory so the
 * relative globs resolve regardless of where vitest is invoked.
 *
 * Usage:
 *   pnpm exec vitest run --config e2e/vitest.e2e.config.ts          # integration only
 *   SHIP_LIVE=1 pnpm exec vitest run --config e2e/vitest.e2e.config.ts  # integration + live e2e
 */
const live = process.env["SHIP_LIVE"] === "1";
// Independent opt-in for streaming child stdout / agent events to the
// terminal in real time. By default vitest captures test stdout and
// only shows it on failure, which makes long live runs feel like
// they've hung; setting `SHIP_E2E_VERBOSE=1` flips on
// `disableConsoleIntercept` and the `verbose` reporter so writes pass
// straight through. Off by default because most CI runs prefer the
// concise default reporter — it's the operator-watching-a-live-run
// flow that wants the noise.
const verbose = process.env["SHIP_E2E_VERBOSE"] === "1";
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root,
    globals: false,
    include: live
      ? ["integration/**/*.integration.test.ts", "scenarios/**/*.e2e.test.ts"]
      : ["integration/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "fixtures/**"],
    passWithNoTests: true,
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 60 * 1000,
    disableConsoleIntercept: verbose,
    reporters: verbose ? ["verbose"] : ["default"],
  },
});
