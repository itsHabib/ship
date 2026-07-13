/** Tests for `FakeAgentRunner`. Pins one behavioral contract per test. */

import { getEventListeners } from "node:events";
import { describe, expect, test, vi } from "vitest";

import type { AgentEvent } from "./event-projection.js";
import type { AgentRunInput, AgentRunResult } from "./runner.js";

import { AgentNotFoundError } from "./errors.js";
import { FakeAgentRunner, type FakeAgentScript } from "./fake.js";

const evA: AgentEvent = { type: "assistant", text: "first" };
const evB: AgentEvent = { type: "assistant", text: "second" };
const evC: AgentEvent = { type: "status", status: "FINISHED" };

function baseResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    status: "succeeded",
    summary: "scripted summary",
    durationMs: 1234,
    branches: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    cwd: "/tmp/fake",
    prompt: "scripted prompt",
    model: { id: "composer-2" },
    onEvent: vi.fn(),
    ...overrides,
  };
}

describe("FakeAgentRunner — script consumption", () => {
  test("emits scripted events in order through onEvent", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({ events: [evA, evB, evC], result: baseResult() });

    const onEvent = vi.fn();
    const handle = await runner.run(baseInput({ onEvent }));
    await handle.result;

    expect(onEvent.mock.calls.map((c) => (c as [AgentEvent])[0])).toEqual([evA, evB, evC]);
  });

  test("result resolves to the scripted AgentRunResult", async () => {
    const runner = new FakeAgentRunner();
    const scripted = baseResult({ status: "failed", errorMessage: "scripted failure" });
    runner.enqueue({ events: [], result: scripted });

    const handle = await runner.run(baseInput());
    await expect(handle.result).resolves.toEqual(scripted);
  });

  test("delayMsBetweenEvents > 0 paces events; ordering preserved", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({ events: [evA, evB], result: baseResult(), delayMsBetweenEvents: 5 });

    const observed: AgentEvent[] = [];
    const onEvent = (ev: unknown): void => {
      observed.push(ev as AgentEvent);
    };

    const start = Date.now();
    const handle = await runner.run(baseInput({ onEvent }));
    await handle.result;
    const elapsed = Date.now() - start;

    expect(observed).toEqual([evA, evB]);
    expect(elapsed).toBeGreaterThanOrEqual(4);
  });

  test("zero events + scripted result still resolves cleanly", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({ events: [], result: baseResult() });

    const onEvent = vi.fn();
    const handle = await runner.run(baseInput({ onEvent }));
    await expect(handle.result).resolves.toEqual(baseResult());
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("FakeAgentRunner — onEvent error swallowing", () => {
  test("synchronous onEvent throw does NOT abort the run", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({ events: [evA, evB, evC], result: baseResult() });

    let calls = 0;
    const onEvent = (): void => {
      calls += 1;
      throw new Error("consumer is broken");
    };

    const handle = await runner.run(baseInput({ onEvent }));
    const result = await handle.result;
    expect(result).toMatchObject(baseResult());
    expect(result.classificationEvents).toHaveLength(3);
    expect(calls).toBe(3);
  });

  test("async onEvent rejection is swallowed", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({ events: [evA, evB], result: baseResult() });

    let calls = 0;
    const onEvent = (): Promise<void> => {
      calls += 1;
      return Promise.reject(new Error("async consumer broke"));
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const handle = await runner.run(baseInput({ onEvent }));
      const result = await handle.result;
      expect(result).toMatchObject(baseResult());
      expect(result.classificationEvents).toHaveLength(2);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toHaveLength(0);
      expect(calls).toBe(2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("FakeAgentRunner — cancel behaviors", () => {
  test('cancelBehavior: "complete" resolves with status "cancelled"', async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({
      events: [evA, evB, evC],
      result: baseResult({ status: "succeeded" }),
      delayMsBetweenEvents: 50,
    });

    const handle = await runner.run(baseInput());
    await handle.cancel();
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
    expect(result.summary).toBe("scripted summary");
  });

  test('cancelBehavior: "ignore" runs the script to completion', async () => {
    const runner = new FakeAgentRunner();
    const scripted = baseResult({ status: "succeeded" });
    runner.enqueue({ events: [evA, evB], result: scripted, cancelBehavior: "ignore" });

    const onEvent = vi.fn();
    const handle = await runner.run(baseInput({ onEvent }));
    await handle.cancel();
    const result = await handle.result;

    expect(result).toMatchObject(scripted);
    expect(result.classificationEvents).toHaveLength(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  test('cancelBehavior: "throw" rejects when called pre-terminal', async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({
      events: [evA, evB],
      result: baseResult(),
      cancelBehavior: "throw",
      delayMsBetweenEvents: 50,
    });

    const handle = await runner.run(baseInput());
    await expect(handle.cancel()).rejects.toThrow(/scripted cancel error/i);
  });

  test("cancel is idempotent", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({
      events: [evA, evB],
      result: baseResult({ status: "succeeded" }),
      delayMsBetweenEvents: 50,
    });

    const handle = await runner.run(baseInput());
    await handle.cancel();
    await expect(handle.cancel()).resolves.toBeUndefined();
    await expect(handle.result).resolves.toMatchObject({ status: "cancelled" });
  });
});

describe("FakeAgentRunner — AbortSignal cancellation", () => {
  test("aborting input.signal mid-flight cancels the run", async () => {
    const runner = new FakeAgentRunner();
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

  test("pre-aborted signal cancels before any event emits", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({ events: [evA, evB], result: baseResult({ status: "succeeded" }) });

    const controller = new AbortController();
    controller.abort();

    const onEvent = vi.fn();
    const handle = await runner.run(baseInput({ onEvent, signal: controller.signal }));
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("pending sleep timer is cleared on cancel", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({
      events: [evA, evB],
      result: baseResult({ status: "succeeded" }),
      delayMsBetweenEvents: 10_000,
    });

    const handle = await runner.run(baseInput());
    const start = Date.now();
    await handle.cancel();
    await handle.result;
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("signal listener is removed on natural termination", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({ events: [], result: baseResult({ status: "succeeded" }) });

    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;
    const handle = await runner.run(baseInput({ signal: controller.signal }));
    await handle.result;
    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  });
});

describe("FakeAgentRunner — queue mechanics", () => {
  test("enqueue is FIFO across multiple run() calls", async () => {
    const runner = new FakeAgentRunner();
    const scriptA: FakeAgentScript = { events: [evA], result: baseResult({ summary: "A" }) };
    const scriptB: FakeAgentScript = { events: [evB], result: baseResult({ summary: "B" }) };
    runner.enqueue(scriptA);
    runner.enqueue(scriptB);

    const a = await runner.run(baseInput());
    const b = await runner.run(baseInput());

    await expect(a.result).resolves.toMatchObject({ summary: "A" });
    await expect(b.result).resolves.toMatchObject({ summary: "B" });
    expect(runner.pendingScriptCount).toBe(0);
  });

  test("run() with no script enqueued throws", async () => {
    const runner = new FakeAgentRunner();
    await expect(runner.run(baseInput())).rejects.toThrow(/no script enqueued/i);
  });

  test("defaultScript is used when the queue is empty", async () => {
    const defaultScript: FakeAgentScript = {
      events: [],
      result: baseResult({ summary: "default" }),
    };
    const runner = new FakeAgentRunner({ defaultScript });

    const a = await runner.run(baseInput());
    const b = await runner.run(baseInput());
    await expect(a.result).resolves.toMatchObject({ summary: "default" });
    await expect(b.result).resolves.toMatchObject({ summary: "default" });
  });
});

describe("FakeAgentRunner — attach", () => {
  test("resume-able script emits events and resolves with input agentId/runId", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueueAttach({ events: [evA, evB], result: baseResult({ summary: "attached" }) });

    const onEvent = vi.fn();
    const handle = await runner.attach({
      agentId: "bc-fake-attach-0001",
      model: { id: "composer-2" },
      onEvent,
      runId: "run-fake-attach-0001",
    });
    const result = await handle.result;

    expect(handle.agentId).toBe("bc-fake-attach-0001");
    expect(handle.runId).toBe("run-fake-attach-0001");
    expect(onEvent.mock.calls.map((c) => (c as [AgentEvent])[0])).toEqual([evA, evB]);
    expect(result).toMatchObject({ status: "succeeded", summary: "attached" });
  });

  test("not-found script throws AgentNotFoundError", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueueAttach({ notFound: true });

    const promise = runner.attach({
      agentId: "bc-missing",
      model: { id: "composer-2" },
      onEvent: vi.fn(),
      runId: "run-missing",
    });
    await expect(promise).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(promise).rejects.toMatchObject({ agentId: "bc-missing", runId: "run-missing" });
  });

  test("downloadArtifact returns scripted bytes", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueue({
      events: [],
      result: baseResult(),
      artifactBytes: { "out/log.txt": Buffer.from("hello") },
    });
    const handle = await runner.run(baseInput());
    await handle.result;
    const bytes = await runner.downloadArtifact!(handle.agentId, "out/log.txt");
    expect(bytes.toString()).toBe("hello");
  });
});

describe("FakeAgentRunner — refreshRun", () => {
  test("terminal script resolves the terminal result and records the call", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueueRefresh(baseResult({ summary: "harvested" }));

    const result = await runner.refreshRun!({ agentId: "bc-r", runId: "run-r" });

    expect(result).toMatchObject({ status: "succeeded", summary: "harvested" });
    expect(runner.refreshCalls).toHaveLength(1);
    expect(runner.refreshCalls[0]?.input).toMatchObject({ agentId: "bc-r", runId: "run-r" });
  });

  test("stillRunning script resolves undefined", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueueRefresh({ stillRunning: true });

    await expect(runner.refreshRun!({ agentId: "bc-r", runId: "run-r" })).resolves.toBeUndefined();
  });

  test("notFound script rejects with AgentNotFoundError", async () => {
    const runner = new FakeAgentRunner();
    runner.enqueueRefresh({ notFound: true });

    const promise = runner.refreshRun!({ agentId: "bc-missing", runId: "run-missing" });
    await expect(promise).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("defaultRefreshScript answers when no per-call script is enqueued", async () => {
    const runner = new FakeAgentRunner({ defaultRefreshScript: { stillRunning: true } });
    await expect(runner.refreshRun!({ agentId: "bc-r", runId: "run-r" })).resolves.toBeUndefined();
  });

  test("no script and no default rejects", async () => {
    const runner = new FakeAgentRunner();
    await expect(runner.refreshRun!({ agentId: "bc-r", runId: "run-r" })).rejects.toThrow(
      /no script enqueued/,
    );
  });
});
