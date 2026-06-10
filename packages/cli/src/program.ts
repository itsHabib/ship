// Builds the Commander `program` and registers the four subcommands.
// Pure factory — no side effects, no `process.exit`. The binary
// (`bin.ts`) calls `parseAsync` and maps `CliExit` to `process.exitCode`.
// Tests construct the program with `program.exitOverride()` so Commander
// throws instead of calling `process.exit`.

import { Command } from "commander";

import type { ServiceFactory } from "./service.js";

import { registerArtifactsCommand } from "./commands/artifacts.js";
import { registerCancelCommand } from "./commands/cancel.js";
import { registerDiagnoseCommand } from "./commands/diagnose.js";
import { registerListCommand } from "./commands/list.js";
import { registerShipCommand } from "./commands/ship.js";
import { registerStatusCommand } from "./commands/status.js";

export function buildProgram(factory: ServiceFactory): Command {
  const program = new Command()
    .name("ship")
    .description("Ship — drive ShipService from the terminal")
    .exitOverride();

  registerShipCommand(program, factory);
  registerStatusCommand(program, factory);
  registerDiagnoseCommand(program, factory);
  registerListCommand(program, factory);
  registerCancelCommand(program, factory);
  registerArtifactsCommand(program, factory);

  return program;
}
