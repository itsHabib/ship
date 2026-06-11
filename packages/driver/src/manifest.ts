/**
 * Strict input contract for work-driver `driver.md` manifests.
 *
 * Parses YAML frontmatter into typed structures with actionable, line-precise
 * errors. Advisory blocks (conflict_notes, skipped_during_resolution,
 * runtime_notes, ping_gates) are lenient passthrough — strictness guards the
 * engine's input, not prep-time human notes.
 */

import { type Document, LineCounter, type ParsedNode, parseDocument } from "yaml";
import { z } from "zod";

const runtimeSchema = z.enum(["local", "cloud", "rooms"]);

const batchStatusSchema = z.enum(["pending", "running", "in_progress", "done", "failed"]);

const streamStatusSchema = z.enum(["pending", "todo", "in_progress", "done", "failed", "skipped"]);

export const manifestStreamSchema = z
  .object({
    spec_path: z.string().min(1),
    task_id: z.string().optional(),
    task_slug: z.string().optional(),
    branch_name: z.string().optional(),
    runtime: runtimeSchema.optional(),
    touches: z.array(z.string()).optional().default([]),
    status: streamStatusSchema.optional(),
    pr_number: z.number().int().optional(),
    merge_commit: z.string().optional(),
    merged_at: z.string().optional(),
    cycles: z.number().int().optional(),
  })
  .strict();

export const manifestBatchSchema = z
  .object({
    id: z.number().int(),
    label: z.string().optional(),
    depends_on: z.array(z.number().int()),
    status: batchStatusSchema.optional(),
    completed_at: z.string().optional(),
    streams: z.array(manifestStreamSchema),
  })
  .strict();

const sourceSchema = z
  .object({
    project: z.string(),
    phase: z.string(),
  })
  .strict();

// Advisory blocks: prep-time human notes — any shape (arrays, maps, bare
// prose); lenient passthrough. Strictness guards the engine's input, not
// advisory text.
const advisoryBlockSchema = z.unknown().optional();

export const driverManifestSchema = z
  .object({
    driver_version: z.literal(1),
    generated_at: z.string(),
    generated_by: z.string(),
    source: sourceSchema,
    repo: z.string(),
    repo_url: z.string().optional(),
    branch_prefix: z.string().optional(),
    default_runtime: runtimeSchema.optional(),
    batches: z.array(manifestBatchSchema),
    conflict_notes: advisoryBlockSchema,
    skipped_during_resolution: advisoryBlockSchema,
    runtime_notes: advisoryBlockSchema,
    ping_gates: advisoryBlockSchema,
  })
  .strict();

export type ManifestStream = z.infer<typeof manifestStreamSchema>;
export type ManifestBatch = z.infer<typeof manifestBatchSchema>;
export type DriverManifest = z.infer<typeof driverManifestSchema>;

export interface ManifestParseError {
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export type ParseManifestResult =
  | { ok: true; manifest: DriverManifest; rawFrontmatter: string }
  | { ok: false; errors: ManifestParseError[] };

interface ExtractFrontmatterSuccess {
  ok: true;
  frontmatter: string;
  startLine: number;
}

interface ExtractFrontmatterFailure {
  ok: false;
  errors: ManifestParseError[];
}

type ExtractFrontmatterResult = ExtractFrontmatterSuccess | ExtractFrontmatterFailure;

/** Parse a `driver.md` manifest string. Total — never throws. */
export function parseManifest(text: string): ParseManifestResult {
  const extracted = extractFrontmatter(text);
  if (!extracted.ok) {
    return extracted;
  }

  const { frontmatter, startLine } = extracted;
  const lineCounter = new LineCounter();
  const doc = parseDocument(frontmatter, { lineCounter, prettyErrors: false });

  const syntaxErrors = docErrorsToManifestErrors(doc, startLine, lineCounter);
  if (syntaxErrors.length > 0) {
    return { ok: false, errors: syntaxErrors };
  }

  let parsed: unknown;
  try {
    parsed = doc.toJS();
  } catch (err: unknown) {
    return {
      ok: false,
      errors: [
        {
          message: `failed to interpret yaml frontmatter: ${describeError(err)}`,
          line: startLine,
        },
      ],
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      errors: [
        {
          message: "driver manifest frontmatter must be a yaml mapping at the top level",
          line: startLine,
        },
      ],
    };
  }

  const versionError = unsupportedDriverVersionError(parsed, doc, startLine, lineCounter);
  if (versionError !== undefined) {
    return { ok: false, errors: [versionError] };
  }

  const schemaResult = driverManifestSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      ok: false,
      errors: zodIssuesToManifestErrors(schemaResult.error.issues, doc, startLine, lineCounter),
    };
  }

  const referentialErrors = validateReferentialIntegrity(
    schemaResult.data,
    doc,
    startLine,
    lineCounter,
  );
  if (referentialErrors.length > 0) {
    return { ok: false, errors: referentialErrors };
  }

  return {
    ok: true,
    manifest: schemaResult.data,
    rawFrontmatter: frontmatter,
  };
}

function extractFrontmatter(text: string): ExtractFrontmatterResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // The closing fence must occupy its own line — `---not-a-fence` is content,
  // not a terminator.
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (match === null) {
    const hasOpeningFence = body.startsWith("---");
    if (!hasOpeningFence) {
      return {
        ok: false,
        errors: [
          {
            message: 'missing driver manifest frontmatter (expected leading "---" fence)',
          },
        ],
      };
    }
    return {
      ok: false,
      errors: [
        {
          message: 'unterminated driver manifest frontmatter (missing closing "---" fence)',
        },
      ],
    };
  }

  const frontmatter = match[1];
  if (frontmatter === undefined) {
    return {
      ok: false,
      errors: [
        {
          message: 'unterminated driver manifest frontmatter (missing closing "---" fence)',
        },
      ],
    };
  }
  // The anchored opening fence occupies file line 1, so the frontmatter's
  // first YAML line is file line 2.
  return { ok: true, frontmatter, startLine: 2 };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.toLowerCase();
  }
  return String(err).toLowerCase();
}

function docErrorsToManifestErrors(
  doc: Document.Parsed,
  startLine: number,
  lineCounter: LineCounter,
): ManifestParseError[] {
  if (doc.errors.length === 0) {
    return [];
  }
  return doc.errors.map((error) => {
    const mapped: ManifestParseError = {
      message: error.message.toLowerCase(),
    };
    const linePosFromError = error.linePos !== undefined ? error.linePos[0] : undefined;
    const linePos = linePosFromError ?? lineCounterLinePos(lineCounter, error.pos[0]);
    if (linePos !== undefined) {
      mapped.line = startLine + linePos.line - 1;
      mapped.column = linePos.col;
    }
    return mapped;
  });
}

function lineCounterLinePos(
  lineCounter: LineCounter,
  offset: number | undefined,
): { line: number; col: number } | undefined {
  if (offset === undefined) {
    return undefined;
  }
  return lineCounter.linePos(offset);
}

function unsupportedDriverVersionError(
  parsed: Record<string, unknown>,
  doc: Document.Parsed,
  startLine: number,
  lineCounter: LineCounter,
): ManifestParseError | undefined {
  if (!("driver_version" in parsed)) {
    return undefined;
  }
  if (parsed["driver_version"] === 1) {
    return undefined;
  }
  const path = ["driver_version"];
  const location = resolveNodeLocation(doc, path, startLine, lineCounter);
  // JSON.stringify keeps the received type visible: `"1"` (string) vs `2` (number).
  const value = JSON.stringify(parsed["driver_version"]);
  const error: ManifestParseError = {
    message: `unsupported driver_version ${value} (expected the number 1)`,
    path: "driver_version",
  };
  if (location !== undefined) {
    error.line = location.line;
    error.column = location.column;
  }
  return error;
}

function zodIssuesToManifestErrors(
  issues: z.ZodIssue[],
  doc: Document.Parsed,
  startLine: number,
  lineCounter: LineCounter,
): ManifestParseError[] {
  return issues.flatMap((issue) => mapZodIssue(issue, doc, startLine, lineCounter));
}

function mapZodIssue(
  issue: z.ZodIssue,
  doc: Document.Parsed,
  startLine: number,
  lineCounter: LineCounter,
): ManifestParseError[] {
  const path = formatZodPath(issue.path);
  const location = resolveNodeLocation(doc, issue.path, startLine, lineCounter);

  if (issue.code === "unrecognized_keys") {
    return mapUnrecognizedKeyIssue(issue, doc, path, startLine, lineCounter);
  }

  if (issue.path[0] === "driver_version" && issue.code === "invalid_type") {
    return [
      applyLocation(
        {
          message: 'required field "driver_version" is missing or invalid (expected 1)',
          path: "driver_version",
        },
        location,
      ),
    ];
  }

  return [
    applyLocation(
      {
        message: zodIssueMessage(issue, path),
        ...(path !== "" ? { path } : {}),
      },
      location,
    ),
  ];
}

function mapUnrecognizedKeyIssue(
  issue: z.ZodIssue & { code: "unrecognized_keys" },
  doc: Document.Parsed,
  path: string,
  startLine: number,
  lineCounter: LineCounter,
): ManifestParseError[] {
  const keys = issue.keys.length > 0 ? issue.keys : ["unknown"];
  return keys.map((unknownKey) => {
    const keyLocation = resolveUnknownKeyLocation(
      doc,
      issue.path,
      unknownKey,
      startLine,
      lineCounter,
    );
    return applyLocation(
      {
        message: `unknown field "${unknownKey}" at ${path || "manifest root"}`,
        ...(path !== "" ? { path } : {}),
      },
      keyLocation,
    );
  });
}

function applyLocation(
  error: ManifestParseError,
  location: { line: number; column: number } | undefined,
): ManifestParseError {
  if (location === undefined) {
    return error;
  }
  return {
    ...error,
    line: location.line,
    column: location.column,
  };
}

function zodIssueMessage(issue: z.ZodIssue, path: string): string {
  if (issue.code === "invalid_type") {
    if (issue.received === "undefined") {
      const field = String(issue.path.at(-1) ?? path);
      const suffix = path !== "" ? ` at ${path}` : "";
      return `required field "${field}" is missing${suffix}`;
    }
    return `invalid value at ${path || "manifest root"}: expected ${issue.expected}, received ${issue.received}`;
  }
  if (issue.code === "invalid_enum_value") {
    const field = String(issue.path.at(-1) ?? "value");
    return `invalid ${field} at ${path}: ${issue.message.toLowerCase()}`;
  }
  if (issue.code === "invalid_literal") {
    return "unsupported driver_version (expected 1)";
  }
  const at = path !== "" ? ` at ${path}` : "";
  return `${issue.message.toLowerCase()}${at}`;
}

function formatZodPath(path: (string | number)[]): string {
  let result = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      result += `[${String(segment)}]`;
      continue;
    }
    if (result === "") {
      result = segment;
      continue;
    }
    result += `.${segment}`;
  }
  return result;
}

function resolveUnknownKeyLocation(
  doc: Document.Parsed,
  path: (string | number)[],
  unknownKey: string,
  startLine: number,
  lineCounter: LineCounter,
): { line: number; column: number } | undefined {
  return resolveNodeLocation(doc, [...path, unknownKey], startLine, lineCounter);
}

function resolveNodeLocation(
  doc: Document.Parsed,
  path: (string | number)[],
  startLine: number,
  lineCounter: LineCounter,
): { line: number; column: number } | undefined {
  const node = doc.getIn(path, true);
  if (!isParsedNode(node)) {
    return undefined;
  }
  const pos = lineCounter.linePos(node.range[0]);
  return {
    line: startLine + pos.line - 1,
    column: pos.col,
  };
}

function resolveDependsOnEntryLocation(
  doc: Document.Parsed,
  batchIndex: number,
  depId: number,
  startLine: number,
  lineCounter: LineCounter,
): { line: number; column: number } | undefined {
  const dependsOnNode = doc.getIn(["batches", batchIndex, "depends_on"], true);
  if (
    !isParsedNode(dependsOnNode) ||
    !("items" in dependsOnNode) ||
    !Array.isArray(dependsOnNode.items)
  ) {
    return undefined;
  }
  for (const item of dependsOnNode.items) {
    if (!isParsedNode(item) || readScalarValue(item) !== depId) {
      continue;
    }
    const pos = lineCounter.linePos(item.range[0]);
    return {
      line: startLine + pos.line - 1,
      column: pos.col,
    };
  }
  return undefined;
}

function readScalarValue(node: ParsedNode): unknown {
  if ("value" in node) {
    return node.value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isParsedNode(node: unknown): node is ParsedNode {
  return node !== null && typeof node === "object" && "range" in node;
}

function validateReferentialIntegrity(
  manifest: DriverManifest,
  doc: Document.Parsed,
  startLine: number,
  lineCounter: LineCounter,
): ManifestParseError[] {
  const errors: ManifestParseError[] = [];
  const batchIds = new Map<number, number>();

  manifest.batches.forEach((batch, index) => {
    const priorIndex = batchIds.get(batch.id);
    if (priorIndex !== undefined) {
      const location = resolveNodeLocation(doc, ["batches", index, "id"], startLine, lineCounter);
      const error: ManifestParseError = {
        message: `duplicate batch id ${String(batch.id)} (also declared at batches[${String(priorIndex)}])`,
        path: `batches[${String(index)}].id`,
      };
      if (location !== undefined) {
        error.line = location.line;
        error.column = location.column;
      }
      errors.push(error);
      return;
    }
    batchIds.set(batch.id, index);
  });

  const knownIds = new Set(manifest.batches.map((batch) => batch.id));

  manifest.batches.forEach((batch, index) => {
    batch.depends_on.forEach((depId) => {
      if (depId === batch.id) {
        const location = resolveDependsOnEntryLocation(doc, index, depId, startLine, lineCounter);
        const error: ManifestParseError = {
          message: `batch ${String(batch.id)} depends on itself`,
          path: `batches[${String(index)}].depends_on`,
        };
        if (location !== undefined) {
          error.line = location.line;
          error.column = location.column;
        }
        errors.push(error);
        return;
      }
      if (!knownIds.has(depId)) {
        const location = resolveDependsOnEntryLocation(doc, index, depId, startLine, lineCounter);
        const error: ManifestParseError = {
          message: `batch ${String(batch.id)} depends_on references unknown batch id ${String(depId)}`,
          path: `batches[${String(index)}].depends_on`,
        };
        if (location !== undefined) {
          error.line = location.line;
          error.column = location.column;
        }
        errors.push(error);
      }
    });
  });

  const cycle = findDependencyCycle(manifest.batches);
  if (cycle !== undefined) {
    const cycleBatchId = cycle[0];
    if (cycleBatchId !== undefined) {
      const batchIndex = manifest.batches.findIndex((batch) => batch.id === Number(cycleBatchId));
      const location = resolveDependsOnEntryLocation(
        doc,
        batchIndex,
        Number(cycle[1] ?? cycleBatchId),
        startLine,
        lineCounter,
      );
      const error: ManifestParseError = {
        message: `dependency cycle detected: ${cycle.join(" → ")}`,
        path: `batches[${String(batchIndex)}].depends_on`,
      };
      if (location !== undefined) {
        error.line = location.line;
        error.column = location.column;
      }
      errors.push(error);
    }
  }

  return errors;
}

function findDependencyCycle(batches: ManifestBatch[]): string[] | undefined {
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const stack: number[] = [];

  const visit = (batchId: number): string[] | undefined => {
    if (visiting.has(batchId)) {
      const cycleStart = stack.indexOf(batchId);
      const cycleIds = stack.slice(cycleStart).concat(batchId);
      return cycleIds.map(String);
    }
    if (visited.has(batchId)) {
      return undefined;
    }

    visiting.add(batchId);
    stack.push(batchId);

    const batch = batchById.get(batchId);
    if (batch !== undefined) {
      // Self-dependencies are already reported as their own referential
      // error; re-detecting them here would double-report one root cause.
      for (const depId of batch.depends_on.filter((id) => id !== batchId)) {
        const cycle = visit(depId);
        if (cycle !== undefined) {
          return cycle;
        }
      }
    }

    stack.pop();
    visiting.delete(batchId);
    visited.add(batchId);
    return undefined;
  };

  for (const batch of batches) {
    const cycle = visit(batch.id);
    if (cycle !== undefined) {
      return cycle;
    }
  }

  return undefined;
}
