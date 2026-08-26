import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { linkedWorktreeWriteDirectories } from "./linked-worktree-writes.js";

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

describe("linkedWorktreeWriteDirectories", () => {
  test("returns no expansion for a normal checkout", () => {
    const root = newRoot();
    mkdirSync(join(root, ".git"));
    expect(linkedWorktreeWriteDirectories(root)).toEqual([]);
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

    expect(linkedWorktreeWriteDirectories(nested)).toEqual([
      realpathSync(gitDir),
      realpathSync(join(commonDir, "objects")),
      realpathSync(join(commonDir, "refs")),
      realpathSync(join(commonDir, "logs")),
    ]);
  });

  test("does not expand a separate-git-dir checkout", () => {
    const root = newRoot();
    const checkout = join(root, "checkout");
    const gitDir = join(root, "separate-gitdir");
    mkdirSync(checkout);
    mkdirSync(gitDir);
    writeFileSync(join(checkout, ".git"), `gitdir: ${gitDir}\n`);
    expect(linkedWorktreeWriteDirectories(checkout)).toEqual([]);
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
    expect(() => linkedWorktreeWriteDirectories(worktree)).toThrow(/outside/);
  });

  test("rejects a malformed linked-worktree pointer", () => {
    const root = newRoot();
    writeFileSync(join(root, ".git"), "not-a-pointer\n");
    expect(() => linkedWorktreeWriteDirectories(root)).toThrow(/malformed/);
  });
});
