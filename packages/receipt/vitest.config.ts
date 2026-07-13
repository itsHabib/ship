import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Never write park receipts to the real ship data-dir file when a test
    // parks a run. See test/setup/receipts-isolation.ts.
    setupFiles: ["./test/receipts-isolation.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // bin.ts is the IO/CLI shell (argv parsing + fs wiring); its pieces are
      // covered through the unit-tested pure core. Excluded from the gate the
      // same way sibling packages exclude their thin entrypoints.
      exclude: ["**/*.test.ts", "src/bin.ts", "src/index.ts"],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
