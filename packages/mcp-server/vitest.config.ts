import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Never write park receipts to the real ship data-dir file when a driver
    // tool test drives a run to awaiting_judgment (e.g. driver_decide retry).
    // See packages/receipt/test/receipts-isolation.ts.
    setupFiles: ["../receipt/test/receipts-isolation.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // `bin.ts` is unit-test-untouchable — its top-level
      // `await server.connect(stdio)` only makes sense in the actual
      // process. The L3 subprocess integration test under
      // `e2e/integration/mcp-server.integration.test.ts` exercises it
      // (including the missing-CURSOR_API_KEY pre-flight). Excluding
      // it from unit coverage avoids 80-line dead weight that would
      // otherwise drag the package's average below the 80/75 threshold
      // even though every other module is at 90-100%.
      exclude: ["**/*.test.ts", "src/bin.ts"],
      thresholds: {
        // mcp-server is mostly request/response plumbing — tracks the
        // CLI's 80/75 glue band rather than core's stricter floor.
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
