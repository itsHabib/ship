import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Repo-wide invariant: every suite redirects WORKBENCH_STATE_DIR to a
    // per-worker temp dir, so no test can append to the operator's real
    // ~/.workbench/driver-state. Enforced by
    // packages/driverstate-emitter/test/isolation-wiring.test.ts.
    setupFiles: ["../driverstate-emitter/test/driverstate-isolation.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/types.ts"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
