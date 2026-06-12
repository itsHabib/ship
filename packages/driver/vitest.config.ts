import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
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
