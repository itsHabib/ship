import { defineConfig } from "vitest/config";

/**
 * Vitest config for the e2e suite.
 *
 * The e2e suite is gated by `SHIP_LIVE=1`. When unset, the config
 * resolves an empty `include` glob so vitest exits cleanly with
 * "no tests run." When set, it includes the `scenarios/` directory.
 *
 * This separates the slow, real-services e2e suite from the fast
 * unit + scenario suites the per-package vitest configs cover.
 *
 * Usage:
 *   pnpm exec vitest run --config e2e/vitest.e2e.config.ts          # no-op
 *   SHIP_LIVE=1 pnpm exec vitest run --config e2e/vitest.e2e.config.ts
 */
const live = process.env["SHIP_LIVE"] === "1";

export default defineConfig({
  test: {
    globals: false,
    include: live ? ["scenarios/**/*.e2e.test.ts"] : [],
    exclude: ["**/node_modules/**", "**/dist/**", "fixtures/**"],
    passWithNoTests: true,
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 60 * 1000,
  },
});
