/** Tests for `notify.ts` — page-tier spawn, timeout, queue-tier skip. */

import { createStore, newDriverRunId, newEscalationId } from "@ship/store";
import { describe, expect, test, vi } from "vitest";

import type { EscalationPayload } from "./types.js";

import { deliverPageTierEscalation, resolveEscalationTier } from "./escalation.js";
import { createNotifyPort, DEFAULT_NOTIFY_TIMEOUT_MS } from "./notify.js";

const FAKE_NOW = "2026-07-02T12:00:00.000Z";

describe("notify hook", () => {
  test("page-tier spawn receives payload JSON on stdin", async () => {
    const received: string[] = [];
    const exec = vi.fn(async (_cmd: string, payload: string) => {
      received.push(payload);
      await Promise.resolve();
    });
    const port = createNotifyPort({ command: "echo-notify" }, exec)!;
    const payload: EscalationPayload = {
      class: "cycle-exhausted",
      createdAt: FAKE_NOW,
      driverRunId: "drv_x",
      question: "cycles exhausted",
      v: 1,
    };
    await port.send(payload);
    expect(exec).toHaveBeenCalledOnce();
    expect(JSON.parse(received[0]!)).toEqual(payload);
  });

  test("queue-tier class never invokes notify from deliverPageTierEscalation", async () => {
    const store = createStore({ clock: () => FAKE_NOW, dbPath: ":memory:" });
    const exec = vi.fn(async () => {
      await Promise.resolve();
    });
    const port = createNotifyPort({ command: "echo-notify" }, exec)!;
    try {
      const runId = newDriverRunId();
      store.insertDriverRun({
        batches: [],
        id: runId,
        manifestPath: "/tmp/x.driver.md",
        repo: "ship",
        sourceJson: "{}",
        status: "running",
      });
      const id = newEscalationId();
      store.insertEscalation({
        class: "stream-parked",
        driverRunId: runId,
        id,
        payloadJson: JSON.stringify({
          class: "stream-parked",
          createdAt: FAKE_NOW,
          question: "parked",
          v: 1,
        }),
        streamId: "ds_1",
      });
      await deliverPageTierEscalation({ notify: port, store }, id);
      expect(exec).not.toHaveBeenCalled();
      expect(store.getEscalation(id)?.notifiedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("hanging command hits timeout and tick path completes without throw", async () => {
    const store = createStore({ clock: () => FAKE_NOW, dbPath: ":memory:" });
    const exec = vi.fn(
      (_cmd: string, _payload: string, timeoutMs: number) =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error(`notify command timed out after ${String(timeoutMs)}ms`));
          }, 20);
        }),
    );
    const port = createNotifyPort({ command: "hang", timeoutMs: 20 }, exec)!;
    try {
      const runId = newDriverRunId();
      store.insertDriverRun({
        batches: [],
        id: runId,
        manifestPath: "/tmp/x.driver.md",
        repo: "ship",
        sourceJson: "{}",
        status: "running",
      });
      const id = newEscalationId();
      store.insertEscalation({
        class: "cycle-exhausted",
        driverRunId: runId,
        id,
        payloadJson: JSON.stringify({
          class: "cycle-exhausted",
          createdAt: FAKE_NOW,
          question: "exhausted",
          v: 1,
        }),
      });
      await expect(deliverPageTierEscalation({ notify: port, store }, id)).resolves.toBeUndefined();
      expect(store.getEscalation(id)?.notifiedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("notified_at stamped on success; retried when null", async () => {
    const store = createStore({ clock: () => FAKE_NOW, dbPath: ":memory:" });
    let calls = 0;
    const exec = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient failure");
      }
      await Promise.resolve();
    });
    const port = createNotifyPort({ command: "flaky" }, exec)!;
    try {
      const runId = newDriverRunId();
      store.insertDriverRun({
        batches: [],
        id: runId,
        manifestPath: "/tmp/x.driver.md",
        repo: "ship",
        sourceJson: "{}",
        status: "running",
      });
      const id = newEscalationId();
      store.insertEscalation({
        class: "triage-uncertain",
        driverRunId: runId,
        id,
        payloadJson: JSON.stringify({
          class: "triage-uncertain",
          createdAt: FAKE_NOW,
          question: "uncertain",
          v: 1,
        }),
        streamId: "ds_1",
      });
      await deliverPageTierEscalation({ notify: port, store }, id);
      expect(store.getEscalation(id)?.notifiedAt).toBeUndefined();

      await deliverPageTierEscalation({ notify: port, store }, id);
      expect(store.getEscalation(id)?.notifiedAt).toBe(FAKE_NOW);
      expect(calls).toBe(2);
    } finally {
      store.close();
    }
  });

  test("resolveEscalationTier honors config override", () => {
    expect(resolveEscalationTier("stream-parked")).toBe("queue");
    expect(resolveEscalationTier("stream-parked", { tiers: { "stream-parked": "page" } })).toBe(
      "page",
    );
  });

  test("default notify timeout constant", () => {
    expect(DEFAULT_NOTIFY_TIMEOUT_MS).toBe(30_000);
  });
});
