/**
 * Per-table module for `escalations`. Owns insert/dedup, notify stamp, resolve.
 */

import type { Db } from "./db.js";

import {
  EscalationNotFoundError,
  EscalationOpenRowExistsError,
  StoreSchemaError,
} from "./errors.js";
import { type Escalation, escalationSchema } from "./escalation-schemas.js";

/** Inputs for `insertEscalation`. Caller supplies id; timestamps from clock. */
export interface InsertEscalationInput {
  id: string;
  driverRunId?: string;
  streamId?: string;
  repo?: string;
  class: string;
  payloadJson: string;
  /** When set, the row is written already resolved (e.g. grant-mutated FYI). */
  preResolved?: { resolution: string; resolvedAt?: string };
}

/** Filter for `listEscalations`. */
export interface ListEscalationsFilter {
  driverRunId?: string;
  streamId?: string;
  repo?: string;
  class?: string;
  unresolvedOnly?: boolean;
  pendingNotifyOnly?: boolean;
}

/** Key for open-row dedup lookup / resolve. */
export interface EscalationOpenKey {
  driverRunId?: string;
  streamId?: string;
  class: string;
}

export interface EscalationOps {
  insert: (input: InsertEscalationInput) => Escalation;
  get: (id: string) => Escalation | null;
  list: (filter: ListEscalationsFilter) => Escalation[];
  getOpenByKey: (key: EscalationOpenKey) => Escalation | null;
  markNotified: (id: string, notifiedAt?: string) => Escalation;
  resolve: (id: string, resolution: string, resolvedAt?: string) => Escalation;
  resolveOpenByKey: (key: EscalationOpenKey, resolution: string, resolvedAt?: string) => Escalation;
}

interface EscalationRow {
  id: string;
  driver_run_id: string | null;
  stream_id: string | null;
  repo: string | null;
  class: string;
  payload_json: string;
  created_at: string;
  notified_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
}

const ESCALATION_COLUMNS =
  "id, driver_run_id, stream_id, repo, class, payload_json, created_at, notified_at, resolved_at, resolution";

function hydrate(row: EscalationRow): Escalation {
  const parsed = escalationSchema.safeParse({
    class: row.class,
    createdAt: row.created_at,
    driverRunId: row.driver_run_id ?? undefined,
    id: row.id,
    notifiedAt: row.notified_at ?? undefined,
    payloadJson: row.payload_json,
    repo: row.repo ?? undefined,
    resolution: row.resolution ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    streamId: row.stream_id ?? undefined,
  });
  if (!parsed.success) {
    throw new StoreSchemaError(`escalation schema drift: ${parsed.error.message}`);
  }
  return parsed.data;
}

function dedupKey(input: EscalationOpenKey): {
  driverRunId: string;
  streamId: string;
  class: string;
} {
  return {
    class: input.class,
    driverRunId: input.driverRunId ?? "",
    streamId: input.streamId ?? "",
  };
}

function openKeyFromInput(input: InsertEscalationInput): EscalationOpenKey {
  const key: EscalationOpenKey = { class: input.class };
  if (input.driverRunId !== undefined) key.driverRunId = input.driverRunId;
  if (input.streamId !== undefined) key.streamId = input.streamId;
  return key;
}

function preResolvedColumns(
  preResolved: InsertEscalationInput["preResolved"],
  createdAt: string,
): { resolution: string | null; resolvedAt: string | null } {
  if (preResolved === undefined) {
    return { resolution: null, resolvedAt: null };
  }
  return {
    resolution: preResolved.resolution,
    resolvedAt: preResolved.resolvedAt ?? createdAt,
  };
}

export function createEscalationOps(db: Db, clock: () => string): EscalationOps {
  const insertStmt = db.prepare(`
    INSERT INTO escalations (
      id, driver_run_id, stream_id, repo, class, payload_json,
      created_at, notified_at, resolved_at, resolution
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);

  const getByIdStmt = db.prepare<[string], EscalationRow>(
    `SELECT ${ESCALATION_COLUMNS} FROM escalations WHERE id = ?`,
  );

  const getOpenByKeyStmt = db.prepare<[string, string, string], EscalationRow>(`
    SELECT ${ESCALATION_COLUMNS} FROM escalations
    WHERE COALESCE(driver_run_id, '') = ?
      AND COALESCE(stream_id, '') = ?
      AND class = ?
      AND resolved_at IS NULL
    LIMIT 1
  `);

  const markNotifiedStmt = db.prepare(`
    UPDATE escalations SET notified_at = ? WHERE id = ?
  `);

  const resolveStmt = db.prepare(`
    UPDATE escalations SET resolved_at = ?, resolution = ? WHERE id = ?
  `);

  function get(id: string): Escalation | null {
    const row = getByIdStmt.get(id);
    if (row === undefined) return null;
    return hydrate(row);
  }

  function getOpenByKey(key: EscalationOpenKey): Escalation | null {
    const k = dedupKey(key);
    const row = getOpenByKeyStmt.get(k.driverRunId, k.streamId, k.class);
    if (row === undefined) return null;
    return hydrate(row);
  }

  function insert(input: InsertEscalationInput): Escalation {
    const existing = getOpenByKey(openKeyFromInput(input));
    if (existing !== null) {
      throw new EscalationOpenRowExistsError(existing.id);
    }

    const createdAt = clock();
    const resolved = preResolvedColumns(input.preResolved, createdAt);

    try {
      insertStmt.run(
        input.id,
        input.driverRunId ?? null,
        input.streamId ?? null,
        input.repo ?? null,
        input.class,
        input.payloadJson,
        createdAt,
        resolved.resolvedAt,
        resolved.resolution,
      );
    } catch (err: unknown) {
      const open = getOpenByKey(openKeyFromInput(input));
      if (open !== null) {
        throw new EscalationOpenRowExistsError(open.id, { cause: err });
      }
      throw err;
    }

    return loadEscalationById(input.id);
  }

  function loadEscalationById(id: string): Escalation {
    const row = getByIdStmt.get(id);
    if (row === undefined) {
      throw new Error(`escalation insert failed to persist: ${id}`);
    }
    return hydrate(row);
  }

  function list(filter: ListEscalationsFilter): Escalation[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.driverRunId !== undefined) {
      clauses.push("driver_run_id = ?");
      params.push(filter.driverRunId);
    }
    if (filter.streamId !== undefined) {
      clauses.push("stream_id = ?");
      params.push(filter.streamId);
    }
    if (filter.repo !== undefined) {
      clauses.push("repo = ?");
      params.push(filter.repo);
    }
    if (filter.class !== undefined) {
      clauses.push("class = ?");
      params.push(filter.class);
    }
    if (filter.unresolvedOnly === true) {
      clauses.push("resolved_at IS NULL");
    }
    if (filter.pendingNotifyOnly === true) {
      clauses.push("resolved_at IS NULL");
      clauses.push("notified_at IS NULL");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT ${ESCALATION_COLUMNS} FROM escalations ${where} ORDER BY created_at ASC`)
      .all(...params) as EscalationRow[];
    return rows.map(hydrate);
  }

  function markNotified(id: string, notifiedAt?: string): Escalation {
    const stampedAt = notifiedAt ?? clock();
    const result = markNotifiedStmt.run(stampedAt, id);
    if (result.changes === 0) {
      throw new EscalationNotFoundError(id);
    }
    const row = getByIdStmt.get(id);
    if (row === undefined) {
      throw new EscalationNotFoundError(id);
    }
    return hydrate(row);
  }

  function resolve(id: string, resolution: string, resolvedAt?: string): Escalation {
    const stampedAt = resolvedAt ?? clock();
    const result = resolveStmt.run(stampedAt, resolution, id);
    if (result.changes === 0) {
      throw new EscalationNotFoundError(id);
    }
    const row = getByIdStmt.get(id);
    if (row === undefined) {
      throw new EscalationNotFoundError(id);
    }
    return hydrate(row);
  }

  function resolveOpenByKey(
    key: EscalationOpenKey,
    resolution: string,
    resolvedAt?: string,
  ): Escalation {
    const open = getOpenByKey(key);
    if (open === null) {
      throw new EscalationNotFoundError(
        `open escalation not found: ${key.class}/${key.driverRunId ?? ""}/${key.streamId ?? ""}`,
      );
    }
    return resolve(open.id, resolution, resolvedAt);
  }

  return {
    get,
    getOpenByKey,
    insert,
    list,
    markNotified,
    resolve,
    resolveOpenByKey,
  };
}
