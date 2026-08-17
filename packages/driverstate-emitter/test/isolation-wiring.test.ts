/**
 * Structural regression guard for the 2026-08 production-store incident.
 *
 * `packages/cli/vitest.config.ts` wired `receipts-isolation.ts` but not
 * `driverstate-isolation.ts`. Because `pnpm run coverage` (and therefore
 * `make check` / `make ci`) runs `pnpm -r exec vitest run` — per-package
 * configs, not the root one — every driver CLI test appended its fixture runs
 * to the operator's real `~/.workbench/driver-state`. 235 fake runs buried the
 * 1 real one, and `/wip`, `driver_runs`, and `driver_rollup` all read them as
 * genuine work.
 *
 * The root config was correct the whole time, which is exactly why this went
 * unnoticed: `pnpm test` was clean and `make check` was not.
 *
 * So the invariant is checked structurally, over every config in the repo,
 * rather than trusted to whoever adds the next package: if a suite can run
 * vitest, it must first redirect `WORKBENCH_STATE_DIR` to a temp dir. The
 * runtime guard in `src/paths.ts` backs this up for anything that slips past.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const isolationFile = join(
  repoRoot,
  "packages",
  "driverstate-emitter",
  "test",
  "driverstate-isolation.ts",
);

/** Every `vitest*.config.ts` a `pnpm test` / `make check` / `make ci` run can load. */
function vitestConfigs(): string[] {
  const packagesDir = join(repoRoot, "packages");
  const perPackage = readdirSync(packagesDir)
    .map((pkg) => join(packagesDir, pkg, "vitest.config.ts"))
    .filter(isFile);
  return [
    join(repoRoot, "vitest.config.ts"),
    join(repoRoot, "e2e", "vitest.e2e.config.ts"),
    ...perPackage,
  ].filter(isFile);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Setup-file paths mentioning the isolation module, as written in the config.
 * `test.setupFiles` resolve against `test.root`, which defaults to the config's
 * own directory — and the one config that sets `root` explicitly (e2e) points
 * it at that same directory.
 */
function isolationSetupPaths(source: string): string[] {
  // Whitespace-tolerant: a formatting-only edit (prettier reflowing the array,
  // dropping the space after the colon) must not make this guard cry wolf.
  const block = /setupFiles\s*:\s*\[([\s\S]*?)\]/.exec(source);
  if (block === null) {
    return [];
  }
  const quoted = block[1]?.match(/"([^"]+)"/g) ?? [];
  return quoted.map((q) => q.slice(1, -1)).filter((p) => p.includes("driverstate-isolation"));
}

describe("driver-state isolation wiring", () => {
  const configs = vitestConfigs();

  it("discovers the configs it is meant to police", () => {
    // Guards the guard: a broken glob would make every assertion below vacuous.
    expect(configs.length).toBeGreaterThanOrEqual(3);
    expect(configs).toContain(join(repoRoot, "vitest.config.ts"));
    expect(configs).toContain(join(repoRoot, "e2e", "vitest.e2e.config.ts"));
    expect(configs).toContain(join(repoRoot, "packages", "cli", "vitest.config.ts"));
  });

  it("reads wiring through formatting-only variation", () => {
    // The parse must track what the config *means*, not how prettier laid it
    // out — otherwise a reflow trips the guard on a correctly-wired repo.
    const wired = [
      `setupFiles: ["../driverstate-emitter/test/driverstate-isolation.ts"],`,
      `setupFiles:["../driverstate-emitter/test/driverstate-isolation.ts"],`,
      `setupFiles:  [\n  "./a.ts",\n  "../driverstate-emitter/test/driverstate-isolation.ts",\n],`,
    ];
    for (const source of wired) {
      expect(isolationSetupPaths(source)).toHaveLength(1);
    }
    expect(isolationSetupPaths(`setupFiles: ["../receipt/test/receipts-isolation.ts"],`)).toEqual(
      [],
    );
  });

  it.each(configs.map((c) => [relative(repoRoot, c), c]))(
    "%s wires driverstate-isolation into setupFiles",
    (_label, config) => {
      const paths = isolationSetupPaths(readFileSync(config, "utf8"));
      expect(
        paths.length,
        `${relative(repoRoot, config)} does not wire driverstate-isolation.ts into ` +
          `test.setupFiles. Without it this suite writes driver-state events to the ` +
          `operator's real ~/.workbench/driver-state.`,
      ).toBeGreaterThan(0);
    },
  );

  it.each(configs.map((c) => [relative(repoRoot, c), c]))(
    "%s points at the real isolation module",
    (_label, config) => {
      // A path that no longer resolves is silently a no-op setup file.
      for (const p of isolationSetupPaths(readFileSync(config, "utf8"))) {
        expect(resolve(dirname(config), p)).toBe(isolationFile);
      }
    },
  );
});
