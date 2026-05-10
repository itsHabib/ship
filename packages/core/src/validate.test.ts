/** Tests for `validateWorkdirAndDoc` against the in-memory fs. */

import { describe, expect, test } from "vitest";

import { DocNotFoundError, DocPathEscapesWorkdirError, WorkdirNotFoundError } from "./errors.js";
import { createMemoryShipFs } from "./fs/memory.js";
import { validateWorkdirAndDoc } from "./validate.js";

describe("validateWorkdirAndDoc", () => {
  test("happy path: workdir exists, docPath resolves to a file inside it", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work/wt", { recursive: true });
    await fs.writeFile("/work/wt/docs.md", "task body");
    const out = await validateWorkdirAndDoc(fs, "/work/wt", "docs.md");
    // Memory fs normalizes separators; on Windows `path.resolve` may
    // emit `\`, but the memory fs still finds the file via its
    // canonical POSIX form. The returned absoluteDocPath is whatever
    // `path.resolve` produced — assert via a normalized comparison.
    expect(out.absoluteDocPath.replace(/\\/g, "/")).toBe("/work/wt/docs.md");
  });

  test("missing workdir → WorkdirNotFoundError", async () => {
    const fs = createMemoryShipFs();
    await expect(validateWorkdirAndDoc(fs, "/nope", "x.md")).rejects.toBeInstanceOf(
      WorkdirNotFoundError,
    );
  });

  test("workdir exists but is a file → WorkdirNotFoundError", async () => {
    const fs = createMemoryShipFs();
    await fs.writeFile("/not-a-dir", "x");
    await expect(validateWorkdirAndDoc(fs, "/not-a-dir", "x.md")).rejects.toBeInstanceOf(
      WorkdirNotFoundError,
    );
  });

  test("missing doc → DocNotFoundError", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work", { recursive: true });
    await expect(validateWorkdirAndDoc(fs, "/work", "missing.md")).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });

  test("doc path resolves to a directory → DocNotFoundError", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work/sub", { recursive: true });
    await expect(validateWorkdirAndDoc(fs, "/work", "sub")).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });

  test("docPath that resolves outside workdir → DocPathEscapesWorkdirError", async () => {
    // Memory fs has no symlinks so we exercise the path-prefix check
    // directly via an absolute docPath that points outside the workdir.
    const fs = createMemoryShipFs();
    await fs.mkdir("/work", { recursive: true });
    await fs.writeFile("/elsewhere.md", "x");
    await expect(validateWorkdirAndDoc(fs, "/work", "/elsewhere.md")).rejects.toBeInstanceOf(
      DocPathEscapesWorkdirError,
    );
  });

  test("docPath that resolves inside workdir via absolute path is accepted", async () => {
    const fs = createMemoryShipFs();
    await fs.mkdir("/work/wt", { recursive: true });
    await fs.writeFile("/work/wt/docs.md", "x");
    const out = await validateWorkdirAndDoc(fs, "/work/wt", "/work/wt/docs.md");
    expect(out.absoluteDocPath.replace(/\\/g, "/")).toBe("/work/wt/docs.md");
  });

  test("workdir prefix-match doesn't false-positive sibling paths", async () => {
    // Sibling dir `/work2` shouldn't be considered inside `/work`.
    const fs = createMemoryShipFs();
    await fs.mkdir("/work", { recursive: true });
    await fs.mkdir("/work2", { recursive: true });
    await fs.writeFile("/work2/docs.md", "x");
    await expect(validateWorkdirAndDoc(fs, "/work", "/work2/docs.md")).rejects.toBeInstanceOf(
      DocPathEscapesWorkdirError,
    );
  });
});
