/** Tests for `escalations.ts` — insert scopes, open-row dedup, pre-resolved rows. */

import { describe, expect, test } from "vitest";

import {
  createStore,
  EscalationNotFoundError,
  EscalationOpenRowExistsError,
  newDriverRunId,
  newEscalationId,
} from "./index.js";

const FAKE_NOW = "2026-07-02T12:00:00.000Z";

function memoryStore() {
  return createStore({ clock: () => FAKE_NOW, dbPath: ":memory:" });
}

function seedDriverRun(store: ReturnType<typeof createStore>): string {
  const runId = newDriverRunId();
  store.insertDriverRun({
    batches: [],
    id: runId,
    manifestPath: "/tmp/manifest.driver.md",
    repo: "owner/ship",
    sourceJson: "{}",
    status: "running",
  });
  return runId;
}

describe("escalations store", () => {
  test("insert stream-scoped escalation", () => {
    const store = memoryStore();
    try {
      const runId = seedDriverRun(store);
      const id = newEscalationId();
      const row = store.insertEscalation({
        class: "stream-parked",
        driverRunId: runId,
        id,
        payloadJson: JSON.stringify({ class: "stream-parked", v: 1 }),
        repo: "owner/ship",
        streamId: "ds_test",
      });
      expect(row.id).toBe(id);
      expect(row.driverRunId).toBe(runId);
      expect(row.streamId).toBe("ds_test");
      expect(row.resolvedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("insert run-scoped escalation with null stream_id", () => {
    const store = memoryStore();
    try {
      const runId = seedDriverRun(store);
      const row = store.insertEscalation({
        class: "spend-ceiling",
        driverRunId: runId,
        id: newEscalationId(),
        payloadJson: "{}",
        repo: "owner/ship",
      });
      expect(row.streamId).toBeUndefined();
      expect(row.driverRunId).toBe(runId);
    } finally {
      store.close();
    }
  });

  test("insert system-scoped escalation with null driver_run_id", () => {
    const store = memoryStore();
    try {
      const row = store.insertEscalation({
        class: "grant-mutated",
        id: newEscalationId(),
        payloadJson: "{}",
        repo: "owner/ship",
      });
      expect(row.driverRunId).toBeUndefined();
      expect(row.repo).toBe("owner/ship");
    } finally {
      store.close();
    }
  });

  test("open-row-only dedup rejects second insert on same key", () => {
    const store = memoryStore();
    try {
      const runId = seedDriverRun(store);
      store.insertEscalation({
        class: "stream-parked",
        driverRunId: runId,
        id: newEscalationId(),
        payloadJson: "{}",
        streamId: "ds_a",
      });
      expect(() =>
        store.insertEscalation({
          class: "stream-parked",
          driverRunId: runId,
          id: newEscalationId(),
          payloadJson: "{}",
          streamId: "ds_a",
        }),
      ).toThrow(EscalationOpenRowExistsError);
    } finally {
      store.close();
    }
  });

  test("insert after resolve succeeds and opens a fresh row", () => {
    const store = memoryStore();
    try {
      const runId = seedDriverRun(store);
      const firstId = newEscalationId();
      store.insertEscalation({
        class: "stream-parked",
        driverRunId: runId,
        id: firstId,
        payloadJson: "{}",
        streamId: "ds_a",
      });
      store.resolveEscalation(firstId, "decide:retry");

      const second = store.insertEscalation({
        class: "stream-parked",
        driverRunId: runId,
        id: newEscalationId(),
        payloadJson: "{}",
        streamId: "ds_a",
      });
      expect(second.id).not.toBe(firstId);
      expect(second.resolvedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("NULL-sentinel: different runs coexist for same class", () => {
    const store = memoryStore();
    try {
      const runA = seedDriverRun(store);
      const runB = seedDriverRun(store);
      store.insertEscalation({
        class: "spend-ceiling",
        driverRunId: runA,
        id: newEscalationId(),
        payloadJson: "{}",
      });
      const rowB = store.insertEscalation({
        class: "spend-ceiling",
        driverRunId: runB,
        id: newEscalationId(),
        payloadJson: "{}",
      });
      expect(rowB.driverRunId).toBe(runB);
    } finally {
      store.close();
    }
  });

  test("pre-resolved grant-mutated insert does not block successor", () => {
    const store = memoryStore();
    try {
      store.insertEscalation({
        class: "grant-mutated",
        id: newEscalationId(),
        payloadJson: "{}",
        preResolved: { resolution: "grant:activate" },
        repo: "owner/ship",
      });
      const successor = store.insertEscalation({
        class: "grant-mutated",
        id: newEscalationId(),
        payloadJson: "{}",
        repo: "owner/ship",
      });
      expect(successor.resolvedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("markEscalationNotified stamps notified_at", () => {
    const store = memoryStore();
    try {
      const runId = seedDriverRun(store);
      const id = newEscalationId();
      store.insertEscalation({
        class: "cycle-exhausted",
        driverRunId: runId,
        id,
        payloadJson: "{}",
        streamId: "ds_x",
      });
      const notified = store.markEscalationNotified(id);
      expect(notified.notifiedAt).toBe(FAKE_NOW);
    } finally {
      store.close();
    }
  });

  test("resolveOpenEscalation throws when no open row", () => {
    const store = memoryStore();
    try {
      const runId = seedDriverRun(store);
      expect(() =>
        store.resolveOpenEscalation(
          { class: "stream-parked", driverRunId: runId, streamId: "ds_missing" },
          "decide:skip",
        ),
      ).toThrow(EscalationNotFoundError);
    } finally {
      store.close();
    }
  });

  test("listEscalations pendingNotifyOnly filter", () => {
    const store = memoryStore();
    try {
      const runId = seedDriverRun(store);
      const pageId = newEscalationId();
      const queueId = newEscalationId();
      store.insertEscalation({
        class: "cycle-exhausted",
        driverRunId: runId,
        id: pageId,
        payloadJson: "{}",
      });
      store.insertEscalation({
        class: "stream-parked",
        driverRunId: runId,
        id: queueId,
        payloadJson: "{}",
        streamId: "ds_q",
      });
      const pending = store.listEscalations({ pendingNotifyOnly: true });
      expect(new Set(pending.map((r) => r.id))).toEqual(new Set([pageId, queueId]));
      store.markEscalationNotified(pageId);
      const after = store.listEscalations({ pendingNotifyOnly: true });
      expect(after.map((r) => r.id)).toEqual([queueId]);
    } finally {
      store.close();
    }
  });
});
