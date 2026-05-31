/** Tests for `resolveValidatedDoc` against the in-memory fs. */

import { describe, expect, test, vi } from "vitest";

import type { DocSource, DocSourceResolveRefParams } from "./doc-source/doc-source.js";

import {
  DocNotFoundError,
  DocPathEscapesWorkdirError,
  RemoteDocFetchError,
  WorkdirNotFoundError,
} from "./errors.js";
import { createMemoryShipFs } from "./fs/memory.js";
import { resolveValidatedDoc, resolveValidatedDocForCloud } from "./validate.js";

describe("resolveValidatedDoc", () => {
  test("happy path: workdir exists, docPath resolves to a file inside it", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work/wt", { recursive: true });
    await fs.writeFile("/work/wt/docs.md", "task body");
    const out = await resolveValidatedDoc(fs, "/work/wt", "docs.md");
    expect(out.absoluteDocPath).toBe("/work/wt/docs.md");
  });

  test("missing workdir → WorkdirNotFoundError", async () => {
    const fs = createMemoryShipFs();
    await expect(resolveValidatedDoc(fs, "/nope", "x.md")).rejects.toBeInstanceOf(
      WorkdirNotFoundError,
    );
  });

  test("workdir exists but is a file → WorkdirNotFoundError", async () => {
    const fs = createMemoryShipFs();
    await fs.writeFile("/not-a-dir", "x");
    await expect(resolveValidatedDoc(fs, "/not-a-dir", "x.md")).rejects.toBeInstanceOf(
      WorkdirNotFoundError,
    );
  });

  test("missing doc → DocNotFoundError", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work", { recursive: true });
    await expect(resolveValidatedDoc(fs, "/work", "missing.md")).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });

  test("doc path resolves to a directory → DocNotFoundError", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work/sub", { recursive: true });
    await expect(resolveValidatedDoc(fs, "/work", "sub")).rejects.toBeInstanceOf(DocNotFoundError);
  });

  test("docPath that resolves outside workdir → DocPathEscapesWorkdirError", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work", { recursive: true });
    await fs.writeFile("/elsewhere.md", "x");
    await expect(resolveValidatedDoc(fs, "/work", "/elsewhere.md")).rejects.toBeInstanceOf(
      DocPathEscapesWorkdirError,
    );
  });

  test("docPath that resolves inside workdir via absolute path is accepted", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work/wt", { recursive: true });
    await fs.writeFile("/work/wt/docs.md", "x");
    const out = await resolveValidatedDoc(fs, "/work/wt", "/work/wt/docs.md");
    expect(out.absoluteDocPath).toBe("/work/wt/docs.md");
  });

  test("workdir prefix-match doesn't false-positive sibling paths", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work", { recursive: true });
    await fs.mkdir("/work2", { recursive: true });
    await fs.writeFile("/work2/docs.md", "x");
    await expect(resolveValidatedDoc(fs, "/work", "/work2/docs.md")).rejects.toBeInstanceOf(
      DocPathEscapesWorkdirError,
    );
  });
});

function makeFakeDocSource(overrides: Partial<DocSource>): DocSource {
  return {
    fetch: overrides.fetch ?? (() => Promise.resolve("# remote\n")),
    resolveRef: overrides.resolveRef ?? (() => Promise.resolve("main")),
  };
}

describe("resolveValidatedDocForCloud", () => {
  test("absolute docPath outside any workdir succeeds (local hit)", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/elsewhere", { recursive: true });
    await fs.writeFile("/elsewhere/task.md", "# Cloud task\n");
    const out = await resolveValidatedDocForCloud(fs, "/elsewhere/task.md");
    expect(out.absoluteDocPath).toBe("/elsewhere/task.md");
    expect(out.content).toBeUndefined();
  });

  test("local hit does not call docSource.fetch", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work", { recursive: true });
    await fs.writeFile("/work/task.md", "local");
    let fetchCalled = false;
    const docSource = makeFakeDocSource({
      fetch: () => {
        fetchCalled = true;
        return Promise.resolve("remote");
      },
    });
    const out = await resolveValidatedDocForCloud(fs, "task.md", {
      workdir: "/work",
      repoSlug: "acme/sandbox",
      docSource,
    });
    expect(out.absoluteDocPath).toBe("/work/task.md");
    expect(fetchCalled).toBe(false);
  });

  test("remote hit returns content without local file", async () => {
    const fs = createMemoryShipFs();
    const docSource = makeFakeDocSource({
      fetch: () => Promise.resolve("# from remote\n"),
    });
    const out = await resolveValidatedDocForCloud(fs, "docs/task.md", {
      repoSlug: "acme/sandbox",
      docSource,
    });
    expect(out.absoluteDocPath).toBe("docs/task.md");
    expect(out.content).toBe("# from remote\n");
  });

  test("both-miss names local + remote causes", async () => {
    const fs = createMemoryShipFs();
    const docSource = makeFakeDocSource({
      fetch: () =>
        Promise.reject(
          new RemoteDocFetchError({
            owner: "acme",
            repo: "sandbox",
            ref: "main",
            path: "docs/missing.md",
            reason: "not found",
            suggestToken: false,
          }),
        ),
    });
    await expect(
      resolveValidatedDocForCloud(fs, "docs/missing.md", {
        repoSlug: "acme/sandbox",
        docSource,
      }),
    ).rejects.toThrow(/not found locally or remotely/);
  });

  test("private-no-token surfaces RemoteDocFetchError", async () => {
    const fs = createMemoryShipFs();
    const docSource = makeFakeDocSource({
      fetch: () =>
        Promise.reject(
          new RemoteDocFetchError({
            owner: "acme",
            repo: "private",
            ref: "main",
            path: "docs/task.md",
            reason: "authentication or permission denied",
            suggestToken: true,
          }),
        ),
    });
    await expect(
      resolveValidatedDocForCloud(fs, "docs/task.md", {
        repoSlug: "acme/private",
        docSource,
      }),
    ).rejects.toBeInstanceOf(RemoteDocFetchError);
  });

  test("resolveRef uses startingRef precedence", async () => {
    const fs = createMemoryShipFs();
    const resolveRef = vi.fn((params: DocSourceResolveRefParams) =>
      Promise.resolve(params.startingRef ?? "main"),
    );
    const fetch = vi.fn(() => Promise.resolve("body"));
    await resolveValidatedDocForCloud(fs, "docs/task.md", {
      repoSlug: "acme/sandbox",
      startingRef: "feature-branch",
      docSource: { fetch, resolveRef },
    });
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ ref: "feature-branch" }));
  });
});
