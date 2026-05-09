/**
 * Tests for `fake.ts`.
 *
 * The fake is the seam every downstream `core` test will exercise; its
 * own behavior has to be airtight or downstream tests inherit subtle
 * bugs (mis-ordered events, leaked cancel state, swallowed-throw
 * surprises). Each test here pins one behavioral contract from the
 * validation plan in `phases/05-cursor-runner.md`.
 */

import type { SDKMessage } from "@cursor/sdk";

import { describe, expect, test, vi } from "vitest";

import type { CursorRunInput, CursorRunResult } from "./runner.js";

import { FakeCursorRunner, type FakeCursorScript } from "./fake.js";

// Minimal SDK envelopes — payload shape doesn't matter; we treat them as
// opaque carriers per the runner's "envelope is stable, payload is
// unknown" contract.
const evA: SDKMessage = {
  type: "assistant",
  agent_id: "agent-fake-0001",
  run_id: "run-fake-0001",
  message: { role: "assistant", content: [{ type: "text", text: "first" }] },
} as unknown as SDKMessage;

const evB: SDKMessage = {
  type: "assistant",
  agent_id: "agent-fake-0001",
  run_id: "run-fake-0001",
  message: { role: "assistant", content: [{ type: "text", text: "second" }] },
} as unknown as SDKMessage;

const evC: SDKMessage = {
  type: "status",
  agent_id: "agent-fake-0001",
  run_id: "run-fake-0001",
  status: "FINISHED",
} as unknown as SDKMessage;

function baseResult(overrides: Partial<CursorRunResult> = {}): CursorRunResult {
  return {
    status: "succeeded",
    summary: "scripted summary",
    durationMs: 1234,
    branches: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<CursorRunInput> = {}): CursorRunInput {
  return {
    cwd: "/tmp/fake",
    prompt: "scripted prompt",
    model: { id: "composer-2" },
    onEvent: vi.fn(),
    ...overrides,
  };
}

describe("FakeCursorRunner — script consumption", () => {
  test("emits scripted events in order through onEvent", async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({ events: [evA, evB, evC], result: baseResult() });

    const onEvent = vi.fn();
    const handle = await runner.run(baseInput({ onEvent }));
    await handle.result;

    expect(onEvent.mock.calls.map((c) => (c as [SDKMessage])[0])).toEqual([evA, evB, evC]);
  });

  test("result resolves to the scripted CursorRunResult", async () => {
    const runner = new FakeCursorRunner();
    const scripted = baseResult({ status: "failed", errorMessage: "scripted failure" });
    runner.enqueue({ events: [], result: scripted });

    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toEqual(scripted);
  });

  test("delayMsBetweenEvents > 0 paces events via timers; ordering preserved", async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({ events: [evA, evB], result: baseResult(), delayMsBetweenEvents: 5 });

    const observed: SDKMessage[] = [];
    const onEvent = (ev: SDKMessage): void => {
      observed.push(ev);
    };

    const start = Date.now();
    const handle = await runner.run(baseInput({ onEvent }));
    await handle.result;
    const elapsed = Date.now() - start;

    expect(observed).toEqual([evA, evB]);
    expect(elapsed).toBeGreaterThanOrEqual(4);
  });

  test("zero events + scripted result still resolves cleanly", async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({ events: [], result: baseResult() });

    const onEvent = vi.fn();
    const handle = await runner.run(baseInput({ onEvent }));
    await expect(handle.result).resolves.toEqual(baseResult());
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("FakeCursorRunner — onEvent error swallowing", () => {
  test("synchronous onEvent throw does NOT abort the run; result still resolves", async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({ events: [evA, evB, evC], result: baseResult() });

    let calls = 0;
    const onEvent = (): void => {
      calls += 1;
      throw new Error("consumer is broken");
    };

    const handle = await runner.run(baseInput({ onEvent }));
    await expect(handle.result).resolves.toEqual(baseResult());
    // All three events were attempted despite each one throwing.
    expect(calls).toBe(3);
  });
});

describe("FakeCursorRunner — cancel behaviors", () => {
  test('cancelBehavior: "complete" (default) resolves result with status "cancelled"', async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({
      events: [evA, evB, evC],
      result: baseResult({ status: "succeeded" }),
      delayMsBetweenEvents: 50,
    });

    const handle = await runner.run(baseInput());
    await handle.cancel();
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
    // Other fields from the scripted result survive (durationMs, summary, etc.)
    expect(result.summary).toBe("scripted summary");
  });

  test('cancelBehavior: "ignore" runs the script to completion regardless of cancel()', async () => {
    const runner = new FakeCursorRunner();
    const scripted = baseResult({ status: "succeeded" });
    runner.enqueue({
      events: [evA, evB],
      result: scripted,
      cancelBehavior: "ignore",
    });

    const onEvent = vi.fn();
    const handle = await runner.run(baseInput({ onEvent }));
    await handle.cancel(); // no-op
    const result = await handle.result;

    expect(result).toEqual(scripted);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  test('cancelBehavior: "throw" rejects when called pre-terminal', async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({
      events: [evA, evB],
      result: baseResult(),
      cancelBehavior: "throw",
      delayMsBetweenEvents: 50,
    });

    const handle = await runner.run(baseInput());
    await expect(handle.cancel()).rejects.toThrow(/scripted cancel error/i);
  });

  test("cancel is idempotent: a second cancel after the first is a no-op", async () => {
    const runner = new FakeCursorRunner();
    // Pace events so the run is still in-flight when the first cancel
    // lands. Otherwise instant emission resolves the result before the
    // first cancel can flip status to "cancelled" — which is the very
    // case "cancel after natural termination is a no-op" already covers.
    runner.enqueue({
      events: [evA, evB],
      result: baseResult({ status: "succeeded" }),
      delayMsBetweenEvents: 50,
    });

    const handle = await runner.run(baseInput());
    await handle.cancel();
    // Second cancel must not throw or re-resolve the result (which would
    // surface as an unhandled rejection in vitest if it tried).
    await expect(handle.cancel()).resolves.toBeUndefined();
    await expect(handle.result).resolves.toMatchObject({ status: "cancelled" });
  });

  test("cancel after natural termination is a no-op even with cancelBehavior: throw", async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({
      events: [evA],
      result: baseResult({ status: "succeeded" }),
      cancelBehavior: "throw",
    });

    const handle = await runner.run(baseInput());
    const naturalResult = await handle.result;
    expect(naturalResult.status).toBe("succeeded");

    // The script asked for a cancel-throw, but cancel-after-terminal should
    // still be a no-op (matches LocalCursorRunner's terminated-flag guard).
    await expect(handle.cancel()).resolves.toBeUndefined();
  });

  test('cancelBehavior: "throw" — only the first pre-terminal cancel rejects; subsequent calls no-op', async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({
      events: [evA, evB],
      result: baseResult(),
      cancelBehavior: "throw",
      delayMsBetweenEvents: 50,
    });

    const handle = await runner.run(baseInput());
    await expect(handle.cancel()).rejects.toThrow(/scripted cancel error/i);
    // Second cancel must NOT reject again — idempotency contract holds
    // even under the "throw" behavior. Concurrent cancel paths (signal
    // + handle, timeout + user) MUST be safe.
    await expect(handle.cancel()).resolves.toBeUndefined();
    await expect(handle.cancel()).resolves.toBeUndefined();
  });
});

describe("FakeCursorRunner — AbortSignal cancellation", () => {
  test("aborting input.signal mid-flight cancels the run (cancelBehavior: complete by default)", async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({
      events: [evA, evB, evC],
      result: baseResult({ status: "succeeded" }),
      delayMsBetweenEvents: 50,
    });

    const controller = new AbortController();
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    controller.abort();
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
  });

  test("a pre-aborted signal cancels the run before any event emits (default delay = 0)", async () => {
    const runner = new FakeCursorRunner();
    // Default `delayMsBetweenEvents: 0` means `#emit` runs synchronously
    // to completion if not gated. Cycle-2 review flagged this: the
    // pre-abort signal check MUST run before `#emit` starts, otherwise
    // events fully emit and the result resolves "succeeded" before the
    // signal is observed. This test pins the bug fix.
    runner.enqueue({
      events: [evA, evB],
      result: baseResult({ status: "succeeded" }),
    });

    const controller = new AbortController();
    controller.abort();

    const onEvent = vi.fn();
    const handle = await runner.run(baseInput({ onEvent, signal: controller.signal }));
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
    // The pre-abort gate must fire before #emit's loop starts; no events
    // should reach onEvent.
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("signal-then-handle cancel is idempotent (signal first, then handle.cancel)", async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({
      events: [evA, evB],
      result: baseResult({ status: "succeeded" }),
      delayMsBetweenEvents: 50,
    });

    const controller = new AbortController();
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    controller.abort();
    // handle.cancel() AFTER the signal already cancelled — must no-op.
    await expect(handle.cancel()).resolves.toBeUndefined();
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
  });

  test("handle-then-signal cancel is idempotent (handle.cancel first, then abort)", async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({
      events: [evA, evB],
      result: baseResult({ status: "succeeded" }),
      delayMsBetweenEvents: 50,
    });

    const controller = new AbortController();
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    await handle.cancel();
    // Aborting the signal AFTER handle.cancel — must not flip status
    // back, must not re-resolve, must not throw.
    expect(() => {
      controller.abort();
    }).not.toThrow();
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
  });
});

describe("FakeCursorRunner — queue mechanics", () => {
  test("enqueue is FIFO across multiple run() calls", async () => {
    const runner = new FakeCursorRunner();
    const scriptA: FakeCursorScript = { events: [evA], result: baseResult({ summary: "A" }) };
    const scriptB: FakeCursorScript = { events: [evB], result: baseResult({ summary: "B" }) };
    runner.enqueue(scriptA);
    runner.enqueue(scriptB);

    const a = await runner.run(baseInput());
    const b = await runner.run(baseInput());

    await expect(a.result).resolves.toMatchObject({ summary: "A" });
    await expect(b.result).resolves.toMatchObject({ summary: "B" });
    expect(runner.pendingScriptCount).toBe(0);
  });

  test("run() with no script enqueued and no default throws synchronously-ish", async () => {
    const runner = new FakeCursorRunner();
    await expect(runner.run(baseInput())).rejects.toThrow(/no script enqueued/i);
  });

  test("defaultScript is used when the queue is empty", async () => {
    const defaultScript: FakeCursorScript = {
      events: [],
      result: baseResult({ summary: "default" }),
    };
    const runner = new FakeCursorRunner({ defaultScript });

    // No enqueue() — both runs should use the default.
    const a = await runner.run(baseInput());
    const b = await runner.run(baseInput());
    await expect(a.result).resolves.toMatchObject({ summary: "default" });
    await expect(b.result).resolves.toMatchObject({ summary: "default" });
  });

  test("explicit scripts take precedence over defaultScript while the queue is non-empty", async () => {
    const defaultScript: FakeCursorScript = {
      events: [],
      result: baseResult({ summary: "default" }),
    };
    const explicit: FakeCursorScript = {
      events: [],
      result: baseResult({ summary: "explicit" }),
    };
    const runner = new FakeCursorRunner({ defaultScript });
    runner.enqueue(explicit);

    const first = await runner.run(baseInput());
    const second = await runner.run(baseInput());
    await expect(first.result).resolves.toMatchObject({ summary: "explicit" });
    await expect(second.result).resolves.toMatchObject({ summary: "default" });
  });

  test("calls records every run() invocation in order with input + script", async () => {
    const runner = new FakeCursorRunner();
    const scriptA: FakeCursorScript = { events: [], result: baseResult({ summary: "A" }) };
    const scriptB: FakeCursorScript = { events: [], result: baseResult({ summary: "B" }) };
    runner.enqueue(scriptA);
    runner.enqueue(scriptB);

    const inputA = baseInput({ prompt: "first prompt" });
    const inputB = baseInput({ prompt: "second prompt" });
    await runner.run(inputA);
    await runner.run(inputB);

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.input).toBe(inputA);
    expect(runner.calls[0]?.script).toBe(scriptA);
    expect(runner.calls[1]?.input).toBe(inputB);
    expect(runner.calls[1]?.script).toBe(scriptB);
  });
});

describe("FakeCursorRunner — handle shape", () => {
  test("agentId and runId follow the agent-fake-/run-fake- prefix convention", async () => {
    const runner = new FakeCursorRunner();
    runner.enqueue({ events: [], result: baseResult() });
    runner.enqueue({ events: [], result: baseResult() });

    const a = await runner.run(baseInput());
    const b = await runner.run(baseInput());

    expect(a.agentId).toMatch(/^agent-fake-\d{4}$/);
    expect(a.runId).toMatch(/^run-fake-\d{4}$/);
    expect(a.agentId).not.toBe(b.agentId);
    expect(a.runId).not.toBe(b.runId);
  });
});
