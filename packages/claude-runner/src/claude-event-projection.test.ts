/** Tests for `claude-event-projection.ts`. */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { describe, expect, test } from "vitest";

import { claudeEventProjection, eventRecord } from "./claude-event-projection.js";

describe("claudeEventProjection", () => {
  test("maps assistant tool_use to tool_call running", () => {
    const ev = {
      message: {
        content: [{ id: "tu-1", input: { command: "make check" }, name: "Bash", type: "tool_use" }],
      },
      type: "assistant",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.eventKind(ev)).toBe("tool_call");
    expect(claudeEventProjection.toolCallId(ev)).toBe("tu-1");
    expect(claudeEventProjection.toolCallName(ev)).toBe("Bash");
    expect(claudeEventProjection.toolCallStatus(ev)).toBe("running");
    expect(claudeEventProjection.commandArg(ev)).toBe("make check");
  });

  test("maps user tool_result error/completed", () => {
    const err = {
      message: {
        content: [{ content: "boom", is_error: true, tool_use_id: "tu-1", type: "tool_result" }],
      },
      type: "user",
    } as unknown as SDKMessage;
    const ok = {
      message: {
        content: [{ content: "done", is_error: false, tool_use_id: "tu-1", type: "tool_result" }],
      },
      type: "user",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.toolCallStatus(err)).toBe("error");
    expect(claudeEventProjection.resultText(err)).toBe("boom");
    expect(claudeEventProjection.toolCallStatus(ok)).toBe("completed");
  });

  test("prefers a failed tool_result among batched blocks", () => {
    // Claude can return multiple tool_result blocks in one user message; an
    // earlier failure must not be masked by a later success (the classifier
    // keys off it). The error block precedes the successful one here.
    const ev = {
      message: {
        content: [
          { content: "boom", is_error: true, tool_use_id: "tu-err", type: "tool_result" },
          { content: "done", is_error: false, tool_use_id: "tu-ok", type: "tool_result" },
        ],
      },
      type: "user",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.toolCallStatus(ev)).toBe("error");
    expect(claudeEventProjection.resultText(ev)).toBe("boom");
    expect(claudeEventProjection.toolCallId(ev)).toBe("tu-err");
  });

  test("maps terminal result subtype and text", () => {
    const success = {
      duration_ms: 100,
      result: "all good",
      subtype: "success",
      type: "result",
    } as unknown as SDKMessage;
    const failure = {
      duration_ms: 50,
      errors: ["first", "second"],
      subtype: "error_max_turns",
      type: "result",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.eventKind(success)).toBe("status");
    expect(claudeEventProjection.terminalStatus(success)).toBe("success");
    expect(claudeEventProjection.resultText(success)).toBe("all good");
    expect(claudeEventProjection.terminalStatus(failure)).toBe("error_max_turns");
    expect(claudeEventProjection.resultText(failure)).toBe("first; second");
  });

  test("parses ISO timestamp when present", () => {
    const ev = {
      timestamp: "2026-06-01T12:00:00.000Z",
      type: "user",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.timestamp(ev)).toBe(Date.parse("2026-06-01T12:00:00.000Z"));
  });

  test("returns undefined timestamp when absent", () => {
    const ev = { type: "assistant" } as unknown as SDKMessage;
    expect(claudeEventProjection.timestamp(ev)).toBeUndefined();
  });

  test("maps system init to status kind", () => {
    const ev = { subtype: "init", type: "system" } as unknown as SDKMessage;
    expect(claudeEventProjection.eventKind(ev)).toBe("status");
  });

  test("assistant text-only message is other", () => {
    const ev = {
      message: { content: [{ text: "hello", type: "text" }] },
      type: "assistant",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.eventKind(ev)).toBe("other");
    expect(claudeEventProjection.toolCallStatus(ev)).toBeUndefined();
  });

  test("user message without tool_result is other", () => {
    const ev = {
      message: { content: [{ text: "ok", type: "text" }] },
      type: "user",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.eventKind(ev)).toBe("other");
  });

  test("statusMessage reads terminal_reason message on error result", () => {
    const ev = {
      subtype: "error_max_turns",
      terminal_reason: "max_turns",
      type: "result",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.statusMessage(ev)).toBe("max_turns");
  });

  test("commandArg ignores non-Bash tool names", () => {
    const ev = {
      message: {
        content: [{ id: "tu-1", input: { command: "x" }, name: "Read", type: "tool_use" }],
      },
      type: "assistant",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.commandArg(ev)).toBeUndefined();
  });

  test("invalid timestamp returns undefined", () => {
    const ev = { timestamp: "not-a-date", type: "user" } as unknown as SDKMessage;
    expect(claudeEventProjection.timestamp(ev)).toBeUndefined();
  });

  test("tool_use without id yields undefined toolCallId", () => {
    const ev = {
      message: { content: [{ name: "Bash", type: "tool_use" }] },
      type: "assistant",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.toolCallId(ev)).toBeUndefined();
  });

  test("user tool_result exposes tool_use_id", () => {
    const ev = {
      message: {
        content: [{ content: "ok", tool_use_id: "tu-9", type: "tool_result" }],
      },
      type: "user",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.toolCallId(ev)).toBe("tu-9");
    expect(claudeEventProjection.toolCallStatus(ev)).toBe("completed");
  });

  test("assistant without tool_use yields undefined toolCallStatus", () => {
    const ev = {
      message: { content: [{ text: "hi", type: "text" }] },
      type: "assistant",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.toolCallStatus(ev)).toBeUndefined();
  });

  test("eventRecord returns the raw message object", () => {
    const ev = { type: "assistant" } as unknown as SDKMessage;
    expect(eventRecord(ev)).toBe(ev);
  });

  test("handles malformed message content gracefully", () => {
    const ev = { message: null, type: "assistant" } as unknown as SDKMessage;
    expect(claudeEventProjection.eventKind(ev)).toBe("other");
    expect(claudeEventProjection.resultText(ev)).toBe("");
  });

  test("result success with non-string result yields empty resultText", () => {
    const ev = { result: 42, subtype: "success", type: "result" } as unknown as SDKMessage;
    expect(claudeEventProjection.resultText(ev)).toBe("");
  });

  test("result errors ignores non-string entries", () => {
    const ev = {
      errors: ["a", 1, null],
      subtype: "error_max_turns",
      type: "result",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.resultText(ev)).toBe("a");
  });

  test("unknown message types fall through to other/undefined", () => {
    const ev = { type: "status" } as unknown as SDKMessage;
    expect(claudeEventProjection.eventKind(ev)).toBe("other");
    expect(claudeEventProjection.toolCallId(ev)).toBeUndefined();
    expect(claudeEventProjection.toolCallStatus(ev)).toBeUndefined();
    expect(claudeEventProjection.statusMessage(ev)).toBeUndefined();
  });

  test("empty terminal_reason yields undefined statusMessage", () => {
    const ev = {
      subtype: "error_max_turns",
      terminal_reason: "",
      type: "result",
    } as unknown as SDKMessage;
    expect(claudeEventProjection.statusMessage(ev)).toBeUndefined();
  });
});
