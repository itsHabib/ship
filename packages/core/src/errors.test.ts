/** Tests for `errors.ts` — pin shape so renames/messages fail loud. */

import { describe, expect, test } from "vitest";

import {
  ArtifactWriteFailedError,
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  WorkdirNotFoundError,
} from "./errors.js";

describe("WorkdirNotFoundError", () => {
  test("preserves workdir + has expected name", () => {
    const err = new WorkdirNotFoundError("/missing");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("WorkdirNotFoundError");
    expect(err.workdir).toBe("/missing");
    expect(err.message).toMatch(/workdir/);
  });
});

describe("DocNotFoundError", () => {
  test("preserves docPath + has expected name", () => {
    const err = new DocNotFoundError("docs/x.md");
    expect(err.name).toBe("DocNotFoundError");
    expect(err.docPath).toBe("docs/x.md");
    expect(err.message).toMatch(/task doc/);
  });
});

describe("DocPathEscapesWorkdirError", () => {
  test("preserves workdir + docPath + has expected name", () => {
    const err = new DocPathEscapesWorkdirError("/w", "../escape");
    expect(err.name).toBe("DocPathEscapesWorkdirError");
    expect(err.workdir).toBe("/w");
    expect(err.docPath).toBe("../escape");
    expect(err.message).toMatch(/resolves outside/);
  });
});

describe("ArtifactWriteFailedError", () => {
  test("preserves cause", () => {
    const cause = new Error("ENOSPC");
    const err = new ArtifactWriteFailedError("disk full", { cause });
    expect(err.name).toBe("ArtifactWriteFailedError");
    expect(err.cause).toBe(cause);
  });
});
