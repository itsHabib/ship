import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        // 6b's failure-path branches (artifact-write fail, edge cases in
        // finalizeFailure) won't be fully covered until 6c's cross-package
        // scenarios. Branches start at 80; tighten to 85 in 6c.
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
});
