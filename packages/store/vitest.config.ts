import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Repo-wide invariant: every suite redirects WORKBENCH_STATE_DIR to a
    // per-worker temp dir, so no test can append to the operator's real
    // ~/.workbench/driver-state. Enforced by
    // driverstate-emitter/test/isolation-wiring.test.ts.
    setupFiles: ["../driverstate-emitter/test/driverstate-isolation.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
