import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Never write park receipts to the real ship data-dir file when a test
    // parks a run. See test/setup/receipts-isolation.ts.
    setupFiles: ["../receipt/test/receipts-isolation.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        // CLI is mostly argv parsing + output formatting glue —
        // matches `@ship/test-harness`'s 80/75 band.
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
