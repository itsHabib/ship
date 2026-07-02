/**
 * Escalation row writes, tier registry, and notify delivery.
 */

import type { Logger } from "@ship/logger";
import type { Escalation, Store } from "@ship/store";
import type { DriverRun, DriverStream } from "@ship/store";

import {
  EscalationNotFoundError,
  EscalationOpenRowExistsError,
  newEscalationId,
} from "@ship/store";

import type { DispatchAmbiguity } from "./judgment.js";
import type { NotifyPort } from "./notify.js";
import type {
  EscalationClass,
  EscalationConfig,
  EscalationPayload,
  EscalationTier,
  JudgmentRequest,
} from "./types.js";

import { buildDispatchAmbiguityRequests, buildFailureTriageRequests } from "./judgment.js";

/** Default tier per escalation class. */
export const DEFAULT_ESCALATION_TIERS: Record<EscalationClass, EscalationTier> = {
  "auth-rejection": "page",
  "ci-infra": "page",
  "cycle-exhausted": "page",
  "grant-mutated": "page",
  "merge-blocked-no-verdict": "queue",
  "merge-ready-awaiting-authority": "queue",
  "pathological-batch": "page",
  "product-direction": "page",
  "sensitive-path": "page",
  "spend-ceiling": "page",
  "stream-parked": "queue",
  "triage-uncertain": "page",
};

export function resolveEscalationTier(
  escalationClass: EscalationClass,
  config?: EscalationConfig,
): EscalationTier {
  const override = config?.tiers?.[escalationClass];
  if (override !== undefined) return override;
  return DEFAULT_ESCALATION_TIERS[escalationClass];
}

export interface EscalationDeps {
  store: Store;
  notify?: NotifyPort | undefined;
  escalation?: EscalationConfig | undefined;
  clock?: () => string;
  logger?: Logger | undefined;
}

function logNotifyFailure(deps: EscalationDeps, escalationId: string, detail: string): void {
  if (deps.logger === undefined) return;
  deps.logger.warn({ detail, escalationId }, "escalation notify failed");
}

function nowIso(deps: EscalationDeps): string {
  return deps.clock?.() ?? new Date().toISOString();
}

function parsePayloadJson(payloadJson: string): EscalationPayload {
  return JSON.parse(payloadJson) as EscalationPayload;
}

function insertEscalationRow(
  deps: EscalationDeps,
  input: {
    class: EscalationClass;
    driverRunId?: string;
    streamId?: string;
    repo?: string;
    payload: EscalationPayload;
    preResolved?: { resolution: string };
  },
): string {
  const payloadJson = JSON.stringify(input.payload);
  try {
    const id = newEscalationId();
    const insertInput: Parameters<Store["insertEscalation"]>[0] = {
      class: input.class,
      id,
      payloadJson,
    };
    if (input.driverRunId !== undefined) insertInput.driverRunId = input.driverRunId;
    if (input.streamId !== undefined) insertInput.streamId = input.streamId;
    if (input.repo !== undefined) insertInput.repo = input.repo;
    if (input.preResolved !== undefined) insertInput.preResolved = input.preResolved;
    deps.store.insertEscalation(insertInput);
    return id;
  } catch (err: unknown) {
    if (err instanceof EscalationOpenRowExistsError) {
      return err.escalationId;
    }
    throw err;
  }
}

function buildStreamParkedPayload(
  run: DriverRun,
  streamId: string,
  request: JudgmentRequest,
  createdAt: string,
): EscalationPayload {
  const base: EscalationPayload = {
    class: "stream-parked",
    createdAt,
    driverRunId: run.id,
    question: judgmentQuestion(request),
    repo: run.repo,
    streamId,
    v: 1,
  };
  if (request.kind === "merge-confirmation" || request.kind === "review-adjudication") {
    base.pr = request.prNumber;
  }
  if (request.kind === "failure-triage" && request.errorMessage !== undefined) {
    base.question = `${base.question}: ${request.errorMessage}`;
    base.evidence = { links: [] };
    if (request.hint !== undefined) base.suggestion = request.hint;
  }
  return base;
}

function judgmentQuestion(request: JudgmentRequest): string {
  if (request.kind === "failure-triage") {
    return `Stream failed (${request.failureCategory}); decide retry, skip, or abort`;
  }
  if (request.kind === "dispatch-ambiguity") {
    return `Multiple workflow runs match dispatch recovery; decide adopt or retry`;
  }
  if (request.kind === "merge-confirmation") {
    return `Merge confirmation required for PR #${String(request.prNumber)}`;
  }
  return `Review adjudication required for PR #${String(request.prNumber)}`;
}

/** Write queue-tier stream-parked rows for every parked stream on awaiting_judgment. */
export function writeStreamParkedEscalations(
  deps: EscalationDeps,
  run: DriverRun,
  ambiguities: DispatchAmbiguity[],
): string[] {
  const createdAt = nowIso(deps);
  const requests = [
    ...buildFailureTriageRequests(run),
    ...buildDispatchAmbiguityRequests(run, ambiguities),
  ];
  const ids: string[] = [];
  for (const request of requests) {
    const payload = buildStreamParkedPayload(run, request.streamId, request, createdAt);
    const id = insertEscalationRow(deps, {
      class: "stream-parked",
      driverRunId: run.id,
      payload,
      repo: run.repo,
      streamId: request.streamId,
    });
    ids.push(id);
  }
  return ids;
}

/** Page-tier cycle exhaustion row (writer for review loop). */
export function writeCycleExhaustedEscalation(
  deps: EscalationDeps,
  run: DriverRun,
  stream: DriverStream,
  question: string,
  suggestion?: string,
): string {
  const createdAt = nowIso(deps);
  const payload: EscalationPayload = {
    class: "cycle-exhausted",
    createdAt,
    driverRunId: run.id,
    question,
    repo: run.repo,
    streamId: stream.id,
    v: 1,
  };
  if (stream.prNumber !== undefined) payload.pr = stream.prNumber;
  if (suggestion !== undefined) payload.suggestion = suggestion;
  return insertEscalationRow(deps, {
    class: "cycle-exhausted",
    driverRunId: run.id,
    payload,
    repo: run.repo,
    streamId: stream.id,
  });
}

/** Run-scoped page-tier row for terminal anomaly / pathological batch. */
export function writePathologicalBatchEscalation(
  deps: EscalationDeps,
  run: DriverRun,
  question: string,
  suggestion?: string,
): string {
  const createdAt = nowIso(deps);
  const payload: EscalationPayload = {
    class: "pathological-batch",
    createdAt,
    driverRunId: run.id,
    question,
    repo: run.repo,
    v: 1,
  };
  if (suggestion !== undefined) payload.suggestion = suggestion;
  return insertEscalationRow(deps, {
    class: "pathological-batch",
    driverRunId: run.id,
    payload,
    repo: run.repo,
  });
}

/** Resolve the open stream-parked row after `driver decide`. */
export function resolveStreamParkedEscalation(
  store: Store,
  driverRunId: string,
  streamId: string,
  resolution: string,
): void {
  try {
    store.resolveOpenEscalation({ class: "stream-parked", driverRunId, streamId }, resolution);
  } catch (err: unknown) {
    if (err instanceof EscalationNotFoundError) return;
    throw err;
  }
}

/** Resolve every open stream-parked row for a run (e.g. run-level abort). */
export function resolveAllStreamParkedEscalations(
  store: Store,
  driverRunId: string,
  resolution: string,
): void {
  const rows = store.listEscalations({
    class: "stream-parked",
    driverRunId,
    unresolvedOnly: true,
  });
  for (const row of rows) {
    if (row.streamId === undefined) continue;
    resolveStreamParkedEscalation(store, driverRunId, row.streamId, resolution);
  }
}

/** Resolve every open escalation row for a run regardless of class (e.g. cancel). */
export function resolveAllRunEscalations(
  store: Store,
  driverRunId: string,
  resolution: string,
): void {
  const rows = store.listEscalations({ driverRunId, unresolvedOnly: true });
  for (const row of rows) {
    store.resolveEscalation(row.id, resolution);
  }
}

/**
 * True when a row was resolved by an answer after it was opened, as opposed to
 * a born-resolved FYI page (resolved_at stamped equal to created_at at insert).
 * An answered question stays quiet; a born-resolved FYI page still delivers.
 */
function isAnsweredAfterOpen(row: Escalation): boolean {
  if (row.resolvedAt === undefined) return false;
  return row.resolvedAt !== row.createdAt;
}

/** Attempt notify for one escalation row; failures are logged, never thrown. */
export async function deliverPageTierEscalation(
  deps: EscalationDeps,
  escalationId: string,
): Promise<void> {
  const row = deps.store.getEscalation(escalationId);
  if (row === null) return;
  if (row.notifiedAt !== undefined) return;
  if (isAnsweredAfterOpen(row)) return;

  const escalationClass = row.class as EscalationClass;
  const tier = resolveEscalationTier(escalationClass, deps.escalation);
  if (tier !== "page") return;
  if (deps.notify === undefined) return;

  const payload = parsePayloadJson(row.payloadJson);
  try {
    await deps.notify.send(payload);
    deps.store.markEscalationNotified(escalationId);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    logNotifyFailure(deps, escalationId, detail);
  }
}

/** Retry delivery for page-tier rows with null notified_at. */
export async function retryPendingEscalationNotifications(deps: EscalationDeps): Promise<void> {
  const pending = deps.store.listEscalations({ pendingNotifyOnly: true });
  for (const row of pending) {
    const tier = resolveEscalationTier(row.class as EscalationClass, deps.escalation);
    if (tier !== "page") continue;
    await deliverPageTierEscalation(deps, row.id);
  }
}

/** Write rows then deliver page-tier notifications for newly written ids. */
export async function writeAndDeliverEscalations(
  deps: EscalationDeps,
  run: DriverRun,
  ambiguities: DispatchAmbiguity[],
): Promise<void> {
  const ids = writeStreamParkedEscalations(deps, run, ambiguities);
  for (const id of ids) {
    await deliverPageTierEscalation(deps, id);
  }
}
