/** Tests for `codex-event-projection.ts`. */

import type { ThreadEvent } from "@openai/codex-sdk";

import { describe, expect, test } from "vitest";

import { codexEventProjection, eventRecord } from "./codex-event-projection.js";

describe("codexEventProjection", () => {
  test("maps command_execution item to tool_call running", () => {
    const ev = {
      item: {
        aggregated_output: "",
        command: "make check",
        id: "cmd-1",
        status: "in_progress",
        type: "command_execution",
      },
      type: "item.started",
    } as ThreadEvent;
    expect(codexEventProjection.eventKind(ev)).toBe("tool_call");
    expect(codexEventProjection.toolCallId(ev)).toBe("cmd-1");
    expect(codexEventProjection.toolCallName(ev)).toBe("command_execution");
    expect(codexEventProjection.toolCallStatus(ev)).toBe("running");
    expect(codexEventProjection.commandArg(ev)).toBe("make check");
  });

  test("maps failed command_execution to error status", () => {
    const ev = {
      item: {
        aggregated_output: "sandbox policy violation",
        command: "rm -rf /",
        id: "cmd-2",
        status: "failed",
        type: "command_execution",
      },
      type: "item.completed",
    } as ThreadEvent;
    expect(codexEventProjection.toolCallStatus(ev)).toBe("error");
    expect(codexEventProjection.resultText(ev)).toBe("sandbox policy violation");
  });

  test("maps file_change and mcp_tool_call items", () => {
    const fileEv = {
      item: {
        changes: [{ kind: "update", path: "src/a.ts" }],
        id: "fc-1",
        status: "failed",
        type: "file_change",
      },
      type: "item.completed",
    } as ThreadEvent;
    const mcpEv = {
      item: {
        arguments: {},
        error: { message: "tool broke" },
        id: "mcp-1",
        server: "docs",
        status: "failed",
        tool: "search",
        type: "mcp_tool_call",
      },
      type: "item.completed",
    } as ThreadEvent;
    expect(codexEventProjection.toolCallName(fileEv)).toBe("file_change");
    expect(codexEventProjection.toolCallStatus(fileEv)).toBe("error");
    expect(codexEventProjection.toolCallName(mcpEv)).toBe("search");
    expect(codexEventProjection.resultText(mcpEv)).toBe("tool broke");
  });

  test("maps terminal turn events", () => {
    const completed = {
      type: "turn.completed",
      usage: {
        cached_input_tokens: 0,
        input_tokens: 1,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    } as ThreadEvent;
    const failed = {
      error: { message: "turn blew up" },
      type: "turn.failed",
    } as ThreadEvent;
    const streamErr = { message: "fatal", type: "error" } as ThreadEvent;
    expect(codexEventProjection.eventKind(completed)).toBe("status");
    expect(codexEventProjection.terminalStatus(completed)).toBe("turn.completed");
    expect(codexEventProjection.terminalStatus(failed)).toBe("turn.failed");
    expect(codexEventProjection.resultText(failed)).toBe("turn blew up");
    expect(codexEventProjection.terminalStatus(streamErr)).toBe("error");
    expect(codexEventProjection.resultText(streamErr)).toBe("fatal");
  });

  test("timestamp is always undefined", () => {
    const ev = { type: "turn.started" } as ThreadEvent;
    expect(codexEventProjection.timestamp(ev)).toBeUndefined();
  });

  test("agent_message result text", () => {
    const ev = {
      item: { id: "msg-1", text: "hello world", type: "agent_message" },
      type: "item.completed",
    } as ThreadEvent;
    expect(codexEventProjection.eventKind(ev)).toBe("other");
    expect(codexEventProjection.resultText(ev)).toBe("hello world");
  });

  test("eventRecord returns the event as a record", () => {
    const ev = { type: "turn.started" } as ThreadEvent;
    expect(eventRecord(ev)).toEqual(ev);
  });

  test("maps item.updated and completed command output", () => {
    const ev = {
      item: {
        aggregated_output: "ok",
        command: "echo hi",
        id: "cmd-3",
        status: "completed",
        type: "command_execution",
      },
      type: "item.updated",
    } as ThreadEvent;
    expect(codexEventProjection.toolCallStatus(ev)).toBe("completed");
    expect(codexEventProjection.resultText(ev)).toBe("ok");
  });

  test("statusMessage returns undefined for empty top-level error", () => {
    const ev = { message: "", type: "error" } as ThreadEvent;
    expect(codexEventProjection.statusMessage(ev)).toBeUndefined();
  });

  test("mcp success result serializes to JSON", () => {
    const ev = {
      item: {
        arguments: { q: "docs" },
        id: "mcp-2",
        result: { content: [], structured_content: null },
        server: "docs",
        status: "completed",
        tool: "search",
        type: "mcp_tool_call",
      },
      type: "item.completed",
    } as ThreadEvent;
    expect(codexEventProjection.resultText(ev)).toContain("structured_content");
  });

  test("mcp result with a circular structure does not throw (guarded stringify)", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const ev = {
      item: {
        arguments: {},
        id: "mcp-3",
        result: circular,
        server: "docs",
        status: "completed",
        tool: "search",
        type: "mcp_tool_call",
      },
      type: "item.completed",
    } as unknown as ThreadEvent;
    expect(() => codexEventProjection.resultText(ev)).not.toThrow();
    expect(codexEventProjection.resultText(ev)).toBe("tool_call error");
  });

  test("thread.started is other kind", () => {
    const ev = { thread_id: "t-1", type: "thread.started" } as ThreadEvent;
    expect(codexEventProjection.eventKind(ev)).toBe("other");
  });
});
