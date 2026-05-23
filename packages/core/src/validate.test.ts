/** Tests for `resolveValidatedDoc` against the in-memory fs. */

import { describe, expect, test } from "vitest";

import { DocNotFoundError, DocPathEscapesWorkdirError, WorkdirNotFoundError } from "./errors.js";
import { createMemoryShipFs } from "./fs/memory.js";
import { resolveValidatedDoc, resolveValidatedDocForCloud } from "./validate.js";

describe("resolveValidatedDoc", () => {
  test("happy path: workdir exists, docPath resolves to a file inside it", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work/wt", { recursive: true });
    await fs.writeFile("/work/wt/docs.md", "task body");
    const out = await resolveValidatedDoc(fs, "/work/wt", "docs.md");
    // The returned `absoluteDocPath` is post-realpath: validate.ts
    // composes the doc against the workdir via a small `joinPath`
    // (not `path.resolve`), then resolves it through `ShipFs.realpath`
    // and returns that canonical form. Memory fs's realpath is the
    // identity on a present file, so this rounds back to the same
    // POSIX path the test wrote.
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
    // Memory fs has no symlinks so we exercise the path-prefix check
    // directly via an absolute docPath that points outside the workdir.
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
    // Sibling dir `/work2` shouldn't be considered inside `/work`.
    const fs = createMemoryShipFs();
    await fs.mkdir("/work", { recursive: true });
    await fs.mkdir("/work2", { recursive: true });
    await fs.writeFile("/work2/docs.md", "x");
    await expect(resolveValidatedDoc(fs, "/work", "/work2/docs.md")).rejects.toBeInstanceOf(
      DocPathEscapesWorkdirError,
    );
  });
});

describe("resolveValidatedDocForCloud", () => {
  test("absolute docPath outside any workdir succeeds", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/elsewhere", { recursive: true });
    await fs.writeFile("/elsewhere/task.md", "# Cloud task\n");
    const out = await resolveValidatedDocForCloud(fs, "/elsewhere/task.md");
    expect(out.absoluteDocPath).toBe("/elsewhere/task.md");
  });
});
