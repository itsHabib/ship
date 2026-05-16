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
      exclude: [
        "**/*.test.ts",
        // `git-remote.ts` is mostly thin `execFile` wrappers around the
        // system `git` binary. The pure helpers (URL/output parsing) are
        // unit-tested via `parseHeadBranchFromRemoteShow` /
        // `parseOriginRepoFromUrl`; the shell-out paths are exercised
        // end-to-end by `e2e/integration/open-pr.integration.test.ts`
        // against a real git repo. Excluding here keeps the band's
        // 90/85 floor honest — unit-coverage of subprocess wrappers
        // would require a cross-platform git stub binary, which the
        // integration suite already obviates.
        "src/git-remote.ts",
      ],
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
