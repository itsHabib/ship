import type { ConsumeReviewArtifactInput, Store } from "@ship/store";

import { createStore, newDriverBatchId, newDriverRunId, newDriverStreamId } from "@ship/store";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { address } from "./engine.js";
import { AddressError } from "./errors.js";
import {
  canonicalReviewFindingsSha256,
  parseReviewFindings,
  type ReviewFindingsV1,
} from "./review-findings.js";
import { createDriverService } from "./service.js";
import { createFakeGhPort } from "./test/fake-gh-port.js";
import { createFakeShipPort } from "./test/fake-ship-port.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "..", "testdata", "reviewfindings-address-v1");
const upstreamHead = "1a951c6598ca823517b47e8c6fc56c3dfe5f44ea";
const expectedCorpusSha256 = "1bcca413f8d40abfffd865e5108bfa607d0ba8f87353f71594866b309f974593";

interface AddressCorpusManifest {
  version: string;
  digest_rule: string;
  corpus_sha256: string;
  cases: { file: string; sha256: string }[];
}

interface AddressCorpusCase {
  name: string;
  artifact_json: string;
  live_head: string;
  cycle: number;
  max_cycles: number;
  consumed_ids: string[];
  consumed_artifact_jsons?: string[];
  calls: ("accept" | "resume")[];
  expected_refusal: string;
  projection: {
    accepted: boolean;
    consumed: boolean;
    at_most_once: boolean;
  };
  ship: {
    provider_call_count: number;
  };
}

interface ScenarioContext {
  dir: string;
  findingsPath: string;
  decisionPath: string;
  runId: string;
  streamId: string;
  store: Store;
  ship: ReturnType<typeof createFakeShipPort>;
  gh: ReturnType<typeof createFakeGhPort>;
}

const manifest = readJson(join(corpusRoot, "manifest.json")) as AddressCorpusManifest;
const scenarios = manifest.cases.map((entry) =>
  readJson(join(corpusRoot, entry.file)),
) as AddressCorpusCase[];

describe(`ReviewFindings address conformance (${upstreamHead})`, () => {
  const contexts: ScenarioContext[] = [];

  afterEach(() => {
    for (const context of contexts.splice(0)) {
      context.store.close();
      rmSync(context.dir, { force: true, recursive: true });
    }
  });

  test("vendored bytes match the frozen Workbench corpus digest", () => {
    expect(manifest.version).toBe("reviewfindings-address-conformance-v1");
    expect(manifest.digest_rule).toBe("sha256(sorted file + ':' + sha256(file) + '\\n')");
    const lines = [...manifest.cases]
      .sort((left, right) => left.file.localeCompare(right.file))
      .map((entry) => {
        const digest = sha256(readFileSync(join(corpusRoot, entry.file)));
        expect(digest, entry.file).toBe(entry.sha256);
        return `${entry.file}:${digest}\n`;
      })
      .join("");

    expect(sha256(lines)).toBe(manifest.corpus_sha256);
    expect(manifest.corpus_sha256).toBe(expectedCorpusSha256);
  });

  test.each(scenarios)("$name", async (scenario) => {
    const context = seedScenario(scenario);
    contexts.push(context);
    seedConsumedArtifacts(context, scenario);

    const result = await executeCalls(context, scenario);
    const receipts = consumedReceipts(context, scenario);
    const providerCalls = context.ship.calls.filter((call) => call.kind === "startShip").length;

    expect(result.accepted).toBe(scenario.projection.accepted);
    expect(receipts.length > 0).toBe(scenario.projection.consumed);
    if (scenario.projection.at_most_once) {
      expect(receipts).toHaveLength(scenario.projection.consumed ? 1 : 0);
    }
    expect(result.refusal).toBe(scenario.expected_refusal);
    expect(providerCalls).toBe(scenario.ship.provider_call_count);
  });
});

function seedScenario(scenario: AddressCorpusCase): ScenarioContext {
  const dir = mkdtempSync(join(tmpdir(), "ship-review-conformance-"));
  const repoRoot = join(dir, "repo");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  const manifestPath = join(repoRoot, "driver.md");
  const findingsPath = join(repoRoot, "findings.json");
  writeFileSync(manifestPath, sourceJson(), "utf8");
  writeFileSync(findingsPath, scenario.artifact_json, "utf8");

  const store = createStore({
    clock: () => "2026-07-29T00:00:00Z",
    dbPath: ":memory:",
  });
  const runId = newDriverRunId();
  const streamId = newDriverStreamId();
  store.insertDriverRun({
    batches: [
      {
        batchIndex: 1,
        dependsOn: [],
        id: newDriverBatchId(),
        status: "running",
        streams: [
          {
            attempts: [],
            branch: "codex/conformance",
            id: streamId,
            prUrl: "https://github.com/itsHabib/workbench/pull/42",
            reviewCycles: scenario.cycle - 1,
            runtime: "cloud",
            specPath: "docs/task.md",
            status: "landed",
            streamIndex: 0,
            touches: [],
          },
        ],
      },
    ],
    id: runId,
    manifestPath,
    repo: "workbench",
    sourceJson: sourceJson(),
    status: "running",
  });
  return {
    dir,
    findingsPath,
    decisionPath: join(repoRoot, "decision.json"),
    gh: createFakeGhPort({
      42: { headRefOid: scenario.live_head, state: "OPEN" },
    }),
    runId,
    ship: createFakeShipPort([]),
    store,
    streamId,
  };
}

/**
 * Mirror the scenario's findings artifact into an authorizing ReviewDecisionV1.
 * This corpus pins the FINDINGS contract; the decision is scaffolding and must
 * always authorize whenever the artifact itself is well-formed — every
 * decision-independent refusal (malformed artifact, stale head, exhausted
 * cycle) fires before the decision file is read. An unparseable artifact gets
 * an empty placeholder for the same reason: it is never read.
 */
function decisionFor(artifactJson: string, cycle: number): string {
  let artifact: {
    subject?: { repo?: unknown; number?: unknown; head_sha?: unknown };
    findings?: { id?: unknown }[];
  };
  try {
    artifact = JSON.parse(artifactJson) as typeof artifact;
  } catch {
    return "{}";
  }
  const ids = (Array.isArray(artifact.findings) ? artifact.findings : [])
    .map((finding) => (typeof finding.id === "string" ? finding.id : ""))
    .filter((id) => id !== "");
  return JSON.stringify({
    schema_version: 1,
    generated_at: "2026-07-29T00:00:00Z",
    // Only the keys the decision schema knows: the artifact subject also
    // carries e.g. `type`, and the parser rejects unrecognized keys.
    subject: {
      repo: artifact.subject?.repo,
      number: artifact.subject?.number,
      head_sha: artifact.subject?.head_sha,
    },
    plan_id: `rp_${"1".repeat(32)}`,
    input_digest: `sha256:${"2".repeat(64)}`,
    policy: { id: "conformance", digest: `sha256:${"a".repeat(64)}` },
    route_disposition: "tier_routed",
    tier: "T1",
    tier_reasons: ["conformance"],
    cycle,
    continuation_weight: 2 ** (cycle - 1),
    cumulative_weight: 2 ** cycle - 1,
    action: "address",
    reason_codes: ["accepted_findings_require_address"],
    next_reviewers: ["codex"],
    findings: ids.map((id) => ({
      id,
      severity: "high",
      reviewers: ["codex"],
      disposition: "fixed",
      changed: false,
      reviewer_closed: false,
      debt: false,
    })),
  });
}

function seedConsumedArtifacts(context: ScenarioContext, scenario: AddressCorpusCase): void {
  const artifacts = scenario.consumed_artifact_jsons ?? [];
  expect(artifacts).toHaveLength(scenario.consumed_ids.length);
  for (const [index, artifactJson] of artifacts.entries()) {
    const artifact = parseReviewFindings(artifactJson);
    expect(artifact.artifact_id).toBe(scenario.consumed_ids[index]);
    const stream = currentStream(context);
    const priorCycle = (stream.reviewCycles ?? 0) + 1;
    context.store.consumeReviewArtifactAndPrepareDispatch(
      consumedInput(context, artifact, priorCycle),
    );
    context.store.updateDriverStream(context.streamId, { status: "landed" });
  }
}

async function executeCalls(
  context: ScenarioContext,
  scenario: AddressCorpusCase,
): Promise<{ accepted: boolean; refusal: string }> {
  let accepted = false;
  let successes = 0;
  let refusal = "";
  const driver = createDriverService({
    gh: context.gh,
    ship: context.ship.port,
    store: context.store,
  });
  for (const call of scenario.calls) {
    if (call === "resume") {
      expect(consumedReceipts(context, scenario).length).toBeGreaterThan(0);
      continue;
    }
    try {
      // A fresh authorizing decision per call: the address cycle advances with
      // every consumed artifact — the scenario's pre-seeded consumptions and
      // each accepted call so far — and the decision must name the cycle it
      // authorizes. The duplicate/preconsumed scenarios must refuse in the
      // consume transaction, not on a stale decision cycle.
      writeFileSync(
        context.decisionPath,
        decisionFor(
          scenario.artifact_json,
          scenario.cycle + scenario.consumed_ids.length + successes,
        ),
        "utf8",
      );
      await address(
        {
          clock: () => 0,
          gh: context.gh,
          ship: context.ship.port,
          store: context.store,
        },
        context.runId,
        {
          decisionPath: context.decisionPath,
          findingsPath: context.findingsPath,
          maxCycles: scenario.max_cycles,
          streamId: context.streamId,
        },
      );
      accepted = true;
      successes += 1;
      await driver.run({ driverRunId: context.runId }, { maxWaitMs: 0, pollIntervalMs: 1 });
    } catch (error: unknown) {
      refusal = commonRefusal(error);
    }
  }
  return { accepted, refusal };
}

function consumedInput(
  context: ScenarioContext,
  artifact: ReviewFindingsV1,
  cycle: number,
): ConsumeReviewArtifactInput {
  const docPath = join(context.dir, `seed-cycle-${String(cycle)}.md`);
  return {
    addressCycle: cycle,
    artifactId: artifact.artifact_id,
    attempts: [
      {
        dispatchedAt: "2026-07-29T00:00:00Z",
        docPath,
        terminal: false,
      },
    ],
    canonicalSha256: canonicalReviewFindingsSha256(artifact),
    dispatchProvider: "cursor",
    docPath,
    driverRunId: context.runId,
    expectedReviewCycle: cycle - 1,
    headSha: artifact.subject.head_sha,
    producerHarness: artifact.producer.harness,
    producerId: artifact.producer.id,
    prNumber: artifact.subject.number,
    repo: artifact.subject.repo,
    streamId: context.streamId,
  };
}

function consumedReceipts(
  context: ScenarioContext,
  scenario: AddressCorpusCase,
): NonNullable<ReturnType<Store["getConsumedReviewArtifactReceipt"]>>[] {
  const limit = scenario.max_cycles + scenario.calls.length + scenario.consumed_ids.length;
  const receipts = [];
  for (let cycle = 1; cycle <= limit; cycle += 1) {
    const receipt = context.store.getConsumedReviewArtifactReceipt(
      context.runId,
      context.streamId,
      cycle,
    );
    if (receipt !== undefined) receipts.push(receipt);
  }
  return receipts;
}

function currentStream(context: ScenarioContext) {
  const stream = context.store
    .getDriverRun(context.runId)
    ?.batches[0]?.streams.find((candidate) => candidate.id === context.streamId);
  if (stream === undefined) {
    throw new Error(`missing conformance stream ${context.streamId}`);
  }
  return stream;
}

function commonRefusal(error: unknown): string {
  if (!(error instanceof AddressError)) throw error;
  const common: Partial<Record<AddressError["code"], string>> = {
    "cycle-exhausted": "cycle-exhausted",
    "findings-duplicate": "duplicate",
    "findings-invalid": "malformed-artifact",
    "findings-stale-head": "stale-head",
  };
  const code = common[error.code];
  if (code === undefined) throw error;
  return code;
}

function sourceJson(): string {
  return `---
driver_version: 1
generated_at: 2026-07-29T00:00:00Z
generated_by: conformance
source:
  project: workbench
  phase: reviewfindings-address-conformance
repo: workbench
repo_url: https://github.com/itsHabib/workbench
batches:
  - id: 1
    depends_on: []
    streams:
      - spec_path: docs/task.md
        runtime: cloud
        status: pending
---
`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
