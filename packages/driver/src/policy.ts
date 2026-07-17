/**
 * Repo-level dispatch policy re-exports.
 *
 * The implementation lives in `@ship/core/dispatch-policy` (a dedicated subpath export, so this shim never eagerly loads the core barrel) so
 * `ShipService.startShip` can enforce ceilings without a circular
 * dependency (driver → core). All prior call sites in this package
 * (`import.ts`, `engine.ts`, `policy.test.ts`, `index.ts`) continue to
 * resolve from `./policy.js` unchanged.
 */

export {
  DispatchPolicyError,
  loadDispatchPolicy,
  providerCeilingViolation,
  resolveDispatchProvider,
  resolveDispatchRuntime,
  runtimeCeilingViolation,
} from "@ship/core/dispatch-policy";
export type {
  CredentialsConstraint,
  DispatchPolicy,
  DispatchPolicyConstraint,
  LoadedDispatchPolicy,
  PolicyRuntime,
} from "@ship/core/dispatch-policy";
