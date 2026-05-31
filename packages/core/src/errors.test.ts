/** Tests for `errors.ts` — pin shape so renames/messages fail loud. */

import { describe, expect, test } from "vitest";

import {
  ArtifactWriteFailedError,
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  MissingRepoError,
  RemoteDocFetchError,
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
    expect(err.message).toMatch(/cloud runs/);
  });

  test("cloud both-miss message names local + remote", () => {
    const err = new DocNotFoundError("docs/x.md", {
      cloudBothMiss: { repoSlug: "acme/sandbox", ref: "main", remoteReason: "not found" },
    });
    expect(err.message).toMatch(/not found locally or remotely/);
    expect(err.message).toMatch(/acme\/sandbox@main/);
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

describe("MissingRepoError", () => {
  test("has expected name + message", () => {
    const err = new MissingRepoError();
    expect(err.name).toBe("MissingRepoError");
    expect(err.message).toMatch(/repo is required/);
  });
});

describe("RemoteDocFetchError", () => {
  test("preserves fields + token hint", () => {
    const err = new RemoteDocFetchError({
      owner: "acme",
      repo: "repo",
      ref: "main",
      path: "docs/x.md",
      reason: "denied",
      suggestToken: true,
    });
    expect(err.name).toBe("RemoteDocFetchError");
    expect(err.owner).toBe("acme");
    expect(err.suggestToken).toBe(true);
    expect(err.message).toMatch(/GITHUB_TOKEN/);
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
