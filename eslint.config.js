import perfectionist from "eslint-plugin-perfectionist";
import sonarjs from "eslint-plugin-sonarjs";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      ".pnpm-store/**",
      // In-repo git worktrees (both the `.worktrees/` and `.claude/worktrees/`
      // conventions) are separate checkouts — a local worktree must never
      // pollute `eslint .` (CI uses a fresh checkout and never sees them).
      "**/.worktrees/**",
      "**/.claude/worktrees/**",
      "spike/**",
      "**/*.config.js",
      "**/*.config.ts",
      // Stryker generates per-mutant source sandboxes locally that should
      // not be linted (and are already gitignored).
      "**/.stryker-tmp/**",
      "**/reports/mutation*",
    ],
  },

  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      perfectionist,
    },
    rules: {
      "perfectionist/sort-imports": [
        "error",
        {
          type: "natural",
          order: "asc",
          newlinesBetween: "always",
          groups: [
            "type",
            ["builtin", "external"],
            "internal-type",
            "internal",
            ["parent-type", "sibling-type", "index-type"],
            ["parent", "sibling", "index"],
            "object",
            "unknown",
          ],
        },
      ],
      "perfectionist/sort-named-imports": ["error", { type: "natural", order: "asc" }],

      // Branching-shape gates.
      complexity: ["error", 10],
      "max-depth": ["error", 3],
      "max-params": ["error", 5],

      // Style / safety.
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-else-return": ["error", { allowElseIf: false }],
      "no-nested-ternary": "error",
      "prefer-template": "error",
      "default-case-last": "error",
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Mutation discipline.
      "no-param-reassign": ["error", { props: true }],
      "@typescript-eslint/prefer-readonly": "error",

      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  {
    files: ["**/*.test.ts", "**/test/**", "**/__tests__/**"],
    rules: {
      // vitest's mocking patterns (vi.mocked, method spies, mock objects
      // satisfying SDK interfaces) routinely require references to methods
      // detached from their host object. The unbound-method rule's
      // strictness is misaligned with that idiom in test files.
      "@typescript-eslint/unbound-method": "off",
      // Tests legitimately use non-null assertions on store reads and
      // fixture lookups where the null branch is unreachable by
      // construction.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // SonarJS noise intrinsic to test code: matrix-style tests
      // duplicate strings (test names, expected literals) and identical
      // function bodies (parametrized assertions).
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-identical-functions": "off",
      // `tmpdir()` is the standard place for test fixtures; the
      // "publicly writable directory" concern is a server-side security
      // check that doesn't apply to test isolation.
      "sonarjs/publicly-writable-directories": "off",
      // `void expr;` is the canonical TS idiom for asserting structural
      // type compatibility (`void _domainFromSdk;`) or for marking a
      // value as intentionally unused in a test step. Sonar's general
      // rule against the void operator misclassifies these usages.
      "sonarjs/void-use": "off",
      // Our repo-wide `^_` prefix already conveys "intentionally
      // unused"; sonar's own no-unused-vars doesn't honor that pattern.
      "sonarjs/no-unused-vars": "off",
    },
  },

  {
    files: ["**/*.properties.test.ts"],
    rules: {
      // `test.prop` from `@fast-check/vitest` is not counted as a test by SonarJS.
      "sonarjs/no-empty-test-file": "off",
    },
  },

  prettier,
);
