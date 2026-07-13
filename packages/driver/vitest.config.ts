import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Never write park receipts to the real ship data-dir file when a test
    // parks a run. See test/setup/receipts-isolation.ts.
    setupFiles: ["../receipt/test/receipts-isolation.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "src/index.ts", "src/types.ts", "src/ship-port.ts", "src/test/**"],
      thresholds: {
        statements: 90,
        branches: 82,
        functions: 90,
        lines: 90,
      },
    },
  },
});
