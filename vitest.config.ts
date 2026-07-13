import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    // Global safety net: never write park receipts to the real ship data-dir
    // file. See test/setup/receipts-isolation.ts.
    setupFiles: ["./packages/receipt/test/receipts-isolation.ts"],
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/scenarios/**/*.scenario.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "spike/**", "e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "spike/**", "e2e/**"],
    },
  },
});
