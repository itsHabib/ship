/**
 * Builds the Commander `program` and registers the four subcommands.
 * Pure factory — no side effects, no `process.exit`. The binary
 * (`bin.ts`) calls `parseAsync` and maps `CliExit` to `process.exitCode`.
 * Tests construct the program with `program.exitOverride()` so
 * Commander throws instead of calling `process.exit`.
 */

import { Command } from "commander";

import type { OpenPrServiceFactory, ServiceFactory } from "./service.js";

import { registerCancelCommand } from "./commands/cancel.js";
import { registerListCommand } from "./commands/list.js";
import { registerOpenPrCommand } from "./commands/open-pr.js";
import { registerShipCommand } from "./commands/ship.js";
import { registerStatusCommand } from "./commands/status.js";

export function buildProgram(
  factory: ServiceFactory,
  openPrFactory: OpenPrServiceFactory,
): Command {
  const program = new Command()
    .name("ship")
    .description("Ship — drive ShipService + OpenPrService from the terminal")
    .exitOverride();

  registerShipCommand(program, factory);
  registerStatusCommand(program, factory);
  registerListCommand(program, factory);
  registerCancelCommand(program, factory);
  registerOpenPrCommand(program, openPrFactory);

  return program;
}
