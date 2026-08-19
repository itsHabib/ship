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
 * vitest, it must first redirect BOTH stores — `WORKBENCH_STATE_DIR` AND
 * `SHIP_RECEIPTS_PATH` — to a temp location. The very incident above was ONE of
 * the two setups missing; policing only driverstate would leave the receipts
 * file (the one flare tails to page a phone) guarded by nothing but the runtime
 * backstop. The runtime guards in `paths.ts` / `runs.ts` back this up.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The two global stores a test must never resolve to its real location, each
 * with the setup file that redirects it and the unconditional assignment that
 * setup must contain.
 */
const MODULES = [
  {
    slug: "driverstate-isolation",
    file: join(repoRoot, "packages", "driverstate-emitter", "test", "driverstate-isolation.ts"),
    envVar: "WORKBENCH_STATE_DIR",
    runtimeMarker: "driverstate-isolation-",
    // Anchored at column 0 (so an `if`-wrapped, indented assignment fails), a
    // direct `=` (so `??=`/`||=` fail — they have no `=` immediately after
    // `]`), and a temp constructor as the whole RHS (so a `cond ? temp : real`
    // ternary fails — its RHS starts with the condition, not the constructor).
    assignment: /^process\.env\["WORKBENCH_STATE_DIR"\]\s*=\s*mkdtempSync\(/m,
  },
  {
    slug: "receipts-isolation",
    file: join(repoRoot, "packages", "receipt", "test", "receipts-isolation.ts"),
    envVar: "SHIP_RECEIPTS_PATH",
    runtimeMarker: "ship-receipts-isolation-",
    assignment: /^process\.env\["SHIP_RECEIPTS_PATH"\]\s*=\s*join\(/m,
  },
] as const;

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
 * Setup-file paths mentioning one isolation module, as written in the config.
 * `test.setupFiles` resolve against `test.root`, which defaults to the config's
 * own directory — and the one config that sets `root` explicitly (e2e) points
 * it at that same directory.
 */
function isolationSetupPaths(source: string, slug: string): string[] {
  // Whitespace-tolerant: a formatting-only edit (prettier reflowing the array,
  // dropping the space after the colon) must not make this guard cry wolf.
  const block = /setupFiles\s*:\s*\[([\s\S]*?)\]/.exec(source);
  if (block === null) {
    return [];
  }
  const quoted = block[1]?.match(/"([^"]+)"/g) ?? [];
  return quoted.map((q) => q.slice(1, -1)).filter((p) => p.includes(slug));
}

describe("store isolation wiring", () => {
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
      expect(isolationSetupPaths(source, "driverstate-isolation")).toHaveLength(1);
    }
    expect(
      isolationSetupPaths(`setupFiles: ["../foo/test/bar.ts"],`, "driverstate-isolation"),
    ).toEqual([]);
  });

  describe.each(MODULES)("$slug", (mod) => {
    it("installs its temp location unconditionally", () => {
      // A conditional fill-in ("only if unset") lets any environment that
      // exports the var at a real store defeat the whole safety net, which is
      // what this setup exists to prevent (#251 review, Codex P1).
      // Runtime: the setup already ran for this file, so the live value is ours.
      expect(process.env[mod.envVar]).toContain(mod.runtimeMarker);

      // Source: pin the assignment shape. The regex is anchored so a later edit
      // cannot smuggle conditionality back in through an `if` wrap, a `??=`, or
      // a ternary — none of which match — without a legitimate `if (` elsewhere
      // in the file tripping a false alarm.
      const source = readFileSync(mod.file, "utf8");
      expect(source).toMatch(mod.assignment);
    });

    it.each(configs.map((c) => [relative(repoRoot, c), c]))(
      "%s wires it into setupFiles",
      (_label, config) => {
        const paths = isolationSetupPaths(readFileSync(config, "utf8"), mod.slug);
        expect(
          paths.length,
          `${relative(repoRoot, config)} does not wire ${mod.slug}.ts into test.setupFiles. ` +
            `Without it this suite can resolve the operator's real ${mod.envVar} store.`,
        ).toBeGreaterThan(0);
      },
    );

    it.each(configs.map((c) => [relative(repoRoot, c), c]))(
      "%s points at the real module",
      (_label, config) => {
        // A path that no longer resolves is silently a no-op setup file.
        for (const p of isolationSetupPaths(readFileSync(config, "utf8"), mod.slug)) {
          expect(resolve(dirname(config), p)).toBe(mod.file);
        }
      },
    );
  });
});
