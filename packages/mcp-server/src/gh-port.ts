/**
 * Default `gh` CLI adapter for driver land. Single source of truth lives in
 * `@ship/driver`; re-exported here for existing mcp-server call sites.
 */

export { createExecGhPort } from "@ship/driver";
