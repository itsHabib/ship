import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { gitWritableRoots } from "./linked-worktree-writes.js";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ship-codex-worktree-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("gitWritableRoots", () => {
  test("admits only the standalone checkout's own git metadata", () => {
    const root = newRoot();
    mkdirSync(join(root, ".git"));
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(gitWritableRoots(nested)).toEqual([realpathSync(join(root, ".git"))]);
  });

  test("rejects a symlinked standalone git metadata directory", () => {
    const root = newRoot();
    const external = newRoot();
    symlinkSync(external, join(root, ".git"), process.platform === "win32" ? "junction" : "dir");
    expect(() => gitWritableRoots(root)).toThrow(/unsupported/);
  });

  test("finds standalone git metadata through a symlinked workdir", () => {
    const root = newRoot();
    mkdirSync(join(root, ".git"));
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const aliasRoot = newRoot();
    const alias = join(aliasRoot, "app");
    symlinkSync(nested, alias, process.platform === "win32" ? "junction" : "dir");

    expect(gitWritableRoots(alias)).toEqual([realpathSync(join(root, ".git"))]);
  });

  test("uses filesystem casing for standalone git metadata", () => {
    const root = newRoot();
    mkdirSync(join(root, ".GIT"));
    if (!existsSync(join(root, ".git"))) return;

    expect(gitWritableRoots(root)).toEqual([realpathSync(join(root, ".git"))]);
  });

  test("returns only the linked-worktree admin and shared commit stores", () => {
    const root = newRoot();
    const commonDir = join(root, "repo", ".git");
    const worktree = join(root, "repo", ".claude", "worktrees", "repair");
    const gitDir = join(commonDir, "worktrees", "repair");
    for (const path of [
      gitDir,
      join(commonDir, "objects"),
      join(commonDir, "refs"),
      join(commonDir, "logs"),
    ]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    const nested = join(worktree, "packages", "app");
    mkdirSync(nested, { recursive: true });

    expect(gitWritableRoots(nested)).toEqual([
      realpathSync(gitDir),
      realpathSync(join(commonDir, "objects")),
      realpathSync(join(commonDir, "refs")),
      realpathSync(join(commonDir, "logs")),
    ]);
  });

  test("accepts a linked worktree when reflogs are disabled", () => {
    const root = newRoot();
    const commonDir = join(root, "repo", ".git");
    const worktree = join(root, "repo", "worktree");
    const gitDir = join(commonDir, "worktrees", "repair");
    for (const path of [gitDir, join(commonDir, "objects"), join(commonDir, "refs")]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    expect(gitWritableRoots(worktree)).toEqual([
      realpathSync(gitDir),
      realpathSync(join(commonDir, "objects")),
      realpathSync(join(commonDir, "refs")),
    ]);
  });

  test("supports reftable-backed linked worktrees without a files ref store", () => {
    const root = newRoot();
    const commonDir = join(root, "repo", ".git");
    const worktree = join(root, "repo", "worktree");
    const gitDir = join(commonDir, "worktrees", "repair");
    for (const path of [gitDir, join(commonDir, "objects"), join(commonDir, "reftable")]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    expect(gitWritableRoots(worktree)).toEqual([
      realpathSync(gitDir),
      realpathSync(join(commonDir, "objects")),
      realpathSync(join(commonDir, "reftable")),
    ]);
  });

  test("does not expand a separate-git-dir checkout", () => {
    const root = newRoot();
    const checkout = join(root, "checkout");
    const gitDir = join(root, "separate-gitdir");
    mkdirSync(checkout);
    mkdirSync(gitDir);
    writeFileSync(join(checkout, ".git"), `gitdir: ${gitDir}\n`);
    expect(gitWritableRoots(checkout)).toEqual([]);
  });

  test("rejects a worktree admin outside the validated worktrees directory", () => {
    const root = newRoot();
    const commonDir = join(root, "repo", ".git");
    const worktree = join(root, "worktree");
    const gitDir = join(root, "unexpected-admin");
    for (const path of [gitDir, join(commonDir, "worktrees")]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(join(gitDir, "commondir"), `${commonDir}\n`);
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    expect(() => gitWritableRoots(worktree)).toThrow(/outside/);
  });

  test("rejects a malformed linked-worktree pointer", () => {
    const root = newRoot();
    writeFileSync(join(root, ".git"), "not-a-pointer\n");
    expect(() => gitWritableRoots(root)).toThrow(/malformed/);
  });
});
