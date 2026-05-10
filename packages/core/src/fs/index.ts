/**
 * `ShipFs` — DI'd filesystem interface so tests substitute in-memory
 * impls. Production wires `createNodeShipFs()`; tests use
 * `createMemoryShipFs()`.
 */

export type { ShipFs, FileStat } from "./shape.js";
export { createNodeShipFs } from "./node.js";
export { createMemoryShipFs, type MemoryShipFs } from "./memory.js";
