/**
 * `@ship/driver` — strict work-driver manifest input contract.
 *
 * Parses and validates `driver.md` YAML frontmatter into typed structures.
 * See docs/features/driver-extraction/spec.md for the full design.
 */

export type {
  DriverManifest,
  ManifestBatch,
  ManifestStream,
  ManifestParseError,
  ParseManifestResult,
} from "./manifest.js";
export {
  driverManifestSchema,
  manifestBatchSchema,
  manifestStreamSchema,
  parseManifest,
} from "./manifest.js";
