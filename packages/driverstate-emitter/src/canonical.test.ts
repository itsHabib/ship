import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Event } from "./canonical.js";

import { canonicalBytes, computeHash } from "./canonical.js";

const vectorPath = fileURLToPath(
  new URL("../test/fixtures/canonical-vector.json", import.meta.url),
);

interface Vector {
  canonical: string;
  hash: string;
}

describe("canonical vector conformance", () => {
  // Pinned reference vector, copied verbatim from workbench
  // contracts/driverstate/testdata/canonical-vector.json. Ship's independent
  // TS emitter MUST reproduce these bytes and this hash exactly — that's the
  // whole point of the vector.
  const vector = JSON.parse(readFileSync(vectorPath, "utf8")) as Vector;
  // Parsing the vector's own canonical string back into an Event (hash: "")
  // means the test never hand-transcribes the body, sidestepping a
  // transcription bug that would silently pass a hand-built fixture.
  const event = JSON.parse(vector.canonical) as Event;

  it("re-encodes to the exact pinned canonical bytes", () => {
    const bytes = canonicalBytes(event);
    expect(new TextDecoder().decode(bytes)).toBe(vector.canonical);
  });

  it("hashes to the exact pinned hash", () => {
    expect(computeHash(event)).toBe(vector.hash);
  });

  it("carries the fields the vector documents (sanity, not just round-trip)", () => {
    expect(event.id).toBe("evt_01JQEVENT00000000000000IMP0");
    expect(event.run).toBe("dsr_01JQRUN0000000000000000RUN0");
    expect(event.kind).toBe("run_imported");
    expect(event.stream).toBe("");
    expect(event.prev).toBe("");
  });
});
