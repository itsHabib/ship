import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "spike/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "spike/**"],
    },
  },
});
