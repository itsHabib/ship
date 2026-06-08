/**
 * Property-based checks for workflow / phase state semantics.
 * Supplements hand-written cases in `workflow.test.ts`.
 */

import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import type { Phase, PhaseKind, PhaseStatus, WorkflowStatus } from "./workflow.js";

import {
  canTransition,
  cursorRunRuntimeSchema,
  isTerminal,
  modelSelectionSchema,
  phaseKindSchema,
  phaseSchema,
  phaseStatusSchema,
} from "./workflow.js";

function readPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ITER = readPositiveIntEnv("SHIP_PROP_ITER", 100);
const PROP_SEED = readPositiveIntEnv("SHIP_PROP_SEED", 0x2fed12f);

fc.configureGlobal({ seed: PROP_SEED });

/** Spec § state machine — must match `ALLOWED_TRANSITIONS` in `workflow.ts`. */
const DOCUMENTED_NEXT: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const kindArbitrary: fc.Arbitrary<PhaseKind> = fc.constantFrom(...phaseKindSchema.options);

const statusArbitrary: fc.Arbitrary<PhaseStatus> = fc.constantFrom(...phaseStatusSchema.options);

const isoTimestampArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 2020, max: 2035 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(
    ([y, mo, d]) =>
      `${String(y)}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00.000Z`,
  );

const phaseArbitrary: fc.Arbitrary<Phase> = fc
  .tuple(kindArbitrary, statusArbitrary, fc.option(isoTimestampArbitrary, { nil: undefined }))
  .chain(([kind, status, startedAt]) => {
    const terminal = isTerminal(status as WorkflowStatus);
    const endedAtArb = terminal ? isoTimestampArbitrary : fc.constant(undefined);
    return endedAtArb.chain((endedAt) =>
      fc.record({
        id: fc.string({ minLength: 1 }),
        workflowRunId: fc.string({ minLength: 1 }),
        kind: fc.constant(kind),
        status: fc.constant(status),
        startedAt: fc.constant(startedAt),
        endedAt: fc.constant(endedAt),
        cursorRunId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        inputJson: fc.string({ minLength: 1 }),
        outputJson: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        errorMessage: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
      }),
    );
  })
  .map((r) => {
    const p = { ...r } satisfies Phase;
    return phaseSchema.parse(p);
  });

const transitionSequenceArbitrary: fc.Arbitrary<readonly PhaseStatus[]> = fc.array(
  statusArbitrary,
  {
    maxLength: 10,
  },
);

class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

function satisfiesEndedAtInvariant(p: Phase): boolean {
  const terminal = isTerminal(p.status as WorkflowStatus);
  return terminal ? p.endedAt !== undefined : p.endedAt === undefined;
}

/** Test-only phase transition: mirrors intended `endedAt` rules for terminal vs non-terminal. */
function transitionPhase(phase: Phase, to: PhaseStatus): Phase {
  if (!canTransition(phase.status as WorkflowStatus, to as WorkflowStatus)) {
    throw new TransitionError(`illegal transition ${phase.status} -> ${to}`);
  }
  const terminal = isTerminal(to as WorkflowStatus);
  const resolvedEndedAt = terminal
    ? (phase.endedAt ?? phase.startedAt ?? "1970-01-01T00:00:00.000Z")
    : undefined;
  const next: Phase = {
    ...phase,
    status: to,
    endedAt: resolvedEndedAt,
  };
  return phaseSchema.parse(next);
}

describe("transition properties (fast-check)", () => {
  test.prop([statusArbitrary, statusArbitrary], { numRuns: ITER })(
    "I1: canTransition matches documented next-set for every (from, to)",
    (from, to) => {
      const documented = DOCUMENTED_NEXT[from as WorkflowStatus];
      expect(canTransition(from as WorkflowStatus, to as WorkflowStatus)).toBe(
        documented.includes(to as WorkflowStatus),
      );
    },
  );

  // I2 NOTE: `phaseArbitrary` pre-enforces the endedAt-iff-terminal invariant
  // at generation time (see lines 58-59), so this property checks the
  // generator's self-consistency rather than production code. The real
  // workflow invariant — that `transitionPhase` to a terminal status SETS
  // endedAt — is covered by I3, which chains transitions and asserts
  // `satisfiesEndedAtInvariant` at each step. If `transitionPhase` ever
  // becomes a production export, I2 should be replaced with a test that
  // starts from a non-terminal phase and validates the transition writes
  // endedAt correctly.
  test.prop([phaseArbitrary], { numRuns: ITER })(
    "I2: terminal phase rows have endedAt; non-terminal have endedAt unset",
    (phase) => {
      expect(satisfiesEndedAtInvariant(phase)).toBe(true);
    },
  );

  test.prop([phaseArbitrary, transitionSequenceArbitrary], { numRuns: ITER })(
    "I3: bounded transition chain yields TransitionError or I2-valid terminal state",
    (phase, targets) => {
      let current: Phase = phase;
      try {
        for (const to of targets) {
          current = transitionPhase(current, to);
          expect(satisfiesEndedAtInvariant(current)).toBe(true);
        }
        expect(phaseSchema.safeParse(current).success).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(TransitionError);
      }
    },
  );

  test.prop([phaseArbitrary], { numRuns: ITER })(
    "I4: Zod parse round-trip preserves fields",
    (phase) => {
      const once = phaseSchema.parse(phase);
      const raw: unknown = JSON.parse(JSON.stringify(once));
      const twice = phaseSchema.parse(raw);
      expect(twice).toEqual(once);
    },
  );

  test.prop([fc.string()], { numRuns: ITER })(
    "I5: isTerminal is true iff status is succeeded, failed, or cancelled",
    (status) => {
      const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
      expect(isTerminal(status as WorkflowStatus)).toBe(terminal);
    },
  );

  test.prop([kindArbitrary], { numRuns: ITER })(
    "I6: phaseKindSchema round-trips via JSON (including open_pr tombstone)",
    (kind) => {
      const raw: unknown = JSON.parse(JSON.stringify(kind));
      expect(phaseKindSchema.parse(raw)).toBe(kind);
      expect(phaseKindSchema.parse(kind)).toBe(kind);
    },
  );

  test.prop([fc.constantFrom("local", "cloud", "rooms"), fc.string()], { numRuns: ITER })(
    "I7: cursorRunRuntimeSchema accepts local/cloud/rooms and rejects other strings",
    (valid, other) => {
      expect(cursorRunRuntimeSchema.parse(valid)).toBe(valid);
      if (other !== "local" && other !== "cloud" && other !== "rooms") {
        expect(cursorRunRuntimeSchema.safeParse(other).success).toBe(false);
      }
    },
  );

  test.prop([fc.string({ minLength: 1 }), fc.boolean()], { numRuns: ITER })(
    "I8: modelSelectionSchema wire round-trip omits JSON-inexpressible optional keys",
    (modelId, includeParams) => {
      const value = includeParams
        ? { id: modelId, params: [{ id: "fast", value: true as const }] }
        : { id: modelId };
      const wire: unknown = JSON.parse(JSON.stringify(value));
      expect(modelSelectionSchema.parse(wire)).toEqual(modelSelectionSchema.parse(value));
    },
  );
});

const _documentedNextExhaustive: Record<WorkflowStatus, readonly WorkflowStatus[]> =
  DOCUMENTED_NEXT;
void _documentedNextExhaustive;
