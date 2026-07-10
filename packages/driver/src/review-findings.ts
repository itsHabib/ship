import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_REVIEW_FINDINGS_BYTES = 1024 * 1024;

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const bounded = (name: string, max: number) =>
  z
    .string()
    .refine((value) => value.trim().length > 0, `${name} must not be blank`)
    .refine((value) => bytes(value) <= max, `${name} exceeds ${String(max)} bytes`);

const sourceSchema = z.object({
  reviewer: bounded("source reviewer", 128),
  comment_id: bounded("source comment_id", 128),
  url: bounded("source url", 2048).refine(isUrl, "source url must be a URL"),
  file: bounded("source file", 1024).optional(),
  line: z.number().int().positive().optional(),
});

const findingSchema = z.object({
  id: bounded("finding id", 128),
  severity: bounded("finding severity", 128),
  summary: bounded("finding summary", 512),
  evidence: bounded("finding evidence", 32 * 1024),
  sources: z.array(sourceSchema).min(1).max(32),
});

const artifactSchema = z.object({
  schema_version: z.literal(1),
  artifact_id: bounded("artifact id", 128),
  decision: z.literal("address"),
  subject: z.object({
    type: z.literal("pull_request"),
    repo: bounded("subject repo", 1024)
      .refine((value) => /^[^/\s]+\/[^/\s]+$/u.test(value), "subject repo must be owner/repo")
      .transform((value) => value.toLowerCase()),
    number: z.number().int().positive(),
    head_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/iu)
      .transform((value) => value.toLowerCase()),
  }),
  producer: z.object({
    id: bounded("producer id", 128),
    harness: bounded("producer harness", 128),
    generated_at: z.string().datetime({ offset: true }),
  }),
  panel: z.object({
    requested: z.array(bounded("panel member", 128)).max(16),
    completed: z.array(bounded("panel member", 128)).max(16),
    missing: z.array(bounded("panel member", 128)).max(16),
  }),
  findings: z.array(findingSchema).min(1).max(100),
});

export type ReviewFindingSource = z.infer<typeof sourceSchema>;
export type ReviewFinding = z.infer<typeof findingSchema>;
export type ReviewFindingsV1 = z.infer<typeof artifactSchema>;

export class ReviewFindingsValidationError extends Error {
  override readonly name = "ReviewFindingsValidationError";
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function parseReviewFindings(input: string): ReviewFindingsV1 {
  if (bytes(input) > MAX_REVIEW_FINDINGS_BYTES) {
    throw new ReviewFindingsValidationError("findings file exceeds 1 MiB");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch (cause: unknown) {
    throw new ReviewFindingsValidationError("findings file is not valid JSON", { cause });
  }
  const parsed = artifactSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ReviewFindingsValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  assertArtifactConsistency(parsed.data);
  return parsed.data;
}

function assertArtifactConsistency(artifact: ReviewFindingsV1): void {
  assertUnique(
    "finding ids",
    artifact.findings.map((finding) => finding.id),
  );
  assertUnique("panel.requested", artifact.panel.requested);
  assertUnique("panel.completed", artifact.panel.completed);
  assertUnique("panel.missing", artifact.panel.missing);

  const requested = new Set(artifact.panel.requested);
  const completed = new Set(artifact.panel.completed);
  const missing = new Set(artifact.panel.missing);
  for (const member of completed) {
    if (!requested.has(member) || missing.has(member)) {
      throw new ReviewFindingsValidationError("panel completed/missing must partition requested");
    }
  }
  for (const member of missing) {
    if (!requested.has(member)) {
      throw new ReviewFindingsValidationError("panel completed/missing must partition requested");
    }
  }
  if (completed.size + missing.size !== requested.size) {
    throw new ReviewFindingsValidationError("panel completed/missing must partition requested");
  }
  for (const finding of artifact.findings) {
    for (const source of finding.sources) {
      if (!completed.has(source.reviewer)) {
        throw new ReviewFindingsValidationError(
          `source reviewer ${source.reviewer} is absent from panel.completed`,
        );
      }
    }
  }
}

function assertUnique(name: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new ReviewFindingsValidationError(`${name} must be unique`);
  }
}

export function canonicalReviewFindingsSha256(artifact: ReviewFindingsV1): string {
  const projection = {
    schema_version: artifact.schema_version,
    decision: artifact.decision,
    subject: {
      type: artifact.subject.type,
      repo: artifact.subject.repo,
      number: artifact.subject.number,
      head_sha: artifact.subject.head_sha,
    },
    panel: {
      requested: [...artifact.panel.requested].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
      completed: [...artifact.panel.completed].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
      missing: [...artifact.panel.missing].sort((left, right) => left.localeCompare(right, "en")),
    },
    findings: [...artifact.findings]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        summary: finding.summary,
        evidence: finding.evidence,
        sources: [...finding.sources].sort(compareSources).map((source) => ({
          reviewer: source.reviewer,
          comment_id: source.comment_id,
          url: source.url,
          ...(source.file === undefined ? {} : { file: source.file }),
          ...(source.line === undefined ? {} : { line: source.line }),
        })),
      })),
  };
  return createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex");
}

function compareSources(left: ReviewFindingSource, right: ReviewFindingSource): number {
  return sourceKey(left).localeCompare(sourceKey(right), "en");
}

function sourceKey(source: ReviewFindingSource): string {
  return JSON.stringify([
    source.reviewer,
    source.comment_id,
    source.url,
    source.file ?? "",
    source.line ?? "",
  ]);
}

export function renderReviewFindings(artifact: ReviewFindingsV1): string {
  return [...artifact.findings]
    .sort((left, right) => left.id.localeCompare(right.id, "en"))
    .map((finding, index) => {
      const sources = [...finding.sources]
        .sort(compareSources)
        .map((source) => {
          const location = formatSourceLocation(source);
          return `- ${source.reviewer}: ${source.url}${location} [comment ${source.comment_id}]`;
        })
        .join("\n");
      return [
        `### ${String(index + 1)}. [${finding.severity}] ${finding.summary}`,
        "",
        finding.evidence,
        "",
        "Sources:",
        sources,
      ].join("\n");
    })
    .join("\n\n");
}

function formatSourceLocation(source: ReviewFindingSource): string {
  if (source.file === undefined) return "";
  const line = source.line === undefined ? "" : `:${String(source.line)}`;
  return ` (${source.file}${line})`;
}
