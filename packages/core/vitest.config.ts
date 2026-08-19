import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    // Repo-wide invariant: every suite redirects WORKBENCH_STATE_DIR to a
    // per-worker temp dir, so no test can append to the operator's real
    // ~/.workbench/driver-state. Enforced by
    // packages/driverstate-emitter/test/isolation-wiring.test.ts.
    setupFiles: [
      "../receipt/test/receipts-isolation.ts",
      "../driverstate-emitter/test/driverstate-isolation.ts",
    ],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        // 6c restored the runtime-touching band's 90/85 floor: the
        // cross-package scenarios in `@ship/test-harness` exercise the
        // failure-path branches (artifact-write fail, cancel-during-prep,
        // cancelled-preservation race) end-to-end through `ShipService`.
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
