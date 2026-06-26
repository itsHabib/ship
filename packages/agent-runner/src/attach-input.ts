import type { AgentRunAttachInput, AgentRunInput } from "./runner.js";

/** Maps attach input onto run input for shared post-start pipelines. */
export function attachInputAsRunInput(
  input: AgentRunAttachInput,
  runtime?: "local" | "cloud" | "rooms",
): AgentRunInput {
  return {
    cwd: "",
    model: input.model,
    onEvent: input.onEvent,
    prompt: "",
    ...(runtime !== undefined && { runtime }),
    ...(input.cloud !== undefined && { cloud: input.cloud }),
    ...(input.agents !== undefined && { agents: input.agents }),
    ...(input.mcpServers !== undefined && { mcpServers: input.mcpServers }),
    ...(input.signal !== undefined && { signal: input.signal }),
    ...(input.log !== undefined && { log: input.log }),
  };
}
