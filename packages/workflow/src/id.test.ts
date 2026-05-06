/**
 * Tests for the three ID factories in `id.ts`.
 *
 * For each factory we assert (a) the emitted string starts with the right
 * prefix and the body matches the Crockford-base32 ULID regex, and (b) three
 * rapid-fire calls produce distinct values (basic uniqueness sanity).
 */

import { describe, expect, test } from "vitest";

import { newCursorRunId, newPhaseId, newWorkflowRunId } from "./id.js";

/** Body of a ULID — 26 chars of Crockford base32, sans I, L, O, U. */
const ULID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("newWorkflowRunId", () => {
  test("emits wf_<ulid>", () => {
    const id = newWorkflowRunId();
    expect(id.startsWith("wf_")).toBe(true);
    expect(id.slice("wf_".length)).toMatch(ULID_BODY);
  });

  test("rapid-fire calls produce distinct values", () => {
    const a = newWorkflowRunId();
    const b = newWorkflowRunId();
    const c = newWorkflowRunId();
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("newPhaseId", () => {
  test("emits ph_<ulid>", () => {
    const id = newPhaseId();
    expect(id.startsWith("ph_")).toBe(true);
    expect(id.slice("ph_".length)).toMatch(ULID_BODY);
  });

  test("rapid-fire calls produce distinct values", () => {
    const a = newPhaseId();
    const b = newPhaseId();
    const c = newPhaseId();
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("newCursorRunId", () => {
  test("emits cr_<ulid>", () => {
    const id = newCursorRunId();
    expect(id.startsWith("cr_")).toBe(true);
    expect(id.slice("cr_".length)).toMatch(ULID_BODY);
  });

  test("rapid-fire calls produce distinct values", () => {
    const a = newCursorRunId();
    const b = newCursorRunId();
    const c = newCursorRunId();
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
