/** Tests for attach-input mapping. */

import { describe, expect, test, vi } from "vitest";

import { attachInputAsRunInput } from "./attach-input.js";

describe("attachInputAsRunInput", () => {
  test("maps attach fields onto run input with empty cwd/prompt", () => {
    const onEvent = vi.fn();
    const signal = new AbortController().signal;
    const input = attachInputAsRunInput(
      {
        agentId: "bc-1",
        cloud: { repos: [{ url: "https://github.com/o/r" }] },
        mcpServers: { ship: { type: "stdio", command: "node", args: ["mcp.js"] } },
        model: { id: "composer-2" },
        onEvent,
        runId: "run-1",
        signal,
      },
      "cloud",
    );

    expect(input.cwd).toBe("");
    expect(input.prompt).toBe("");
    expect(input.runtime).toBe("cloud");
    expect(input.model).toEqual({ id: "composer-2" });
    expect(input.onEvent).toBe(onEvent);
    expect(input.signal).toBe(signal);
    expect(input.cloud?.repos[0]?.url).toBe("https://github.com/o/r");
  });

  test("maps optional attach fields", () => {
    const input = attachInputAsRunInput({
      agentId: "bc-1",
      agents: { explore: { description: "search" } },
      log: { info: vi.fn() } as never,
      model: { id: "composer-2" },
      onEvent: vi.fn(),
      runId: "run-1",
    });
    expect(input.agents?.["explore"]?.description).toBe("search");
    expect(input.log).toBeDefined();
  });
});
