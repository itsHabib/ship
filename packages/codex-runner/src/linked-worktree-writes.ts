import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function findGitMarker(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const marker = join(dir, ".git");
    if (existsSync(marker)) return marker;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function requireDirectory(path: string, label: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`${label} is not a directory: ${canonical}`);
  }
  return canonical;
}

/**
 * Return the extra writable roots needed for `git add` + `git commit` in a
 * linked worktree. A linked worktree keeps its index and HEAD in a per-worktree
 * admin directory while sharing objects, refs, and reflogs with the main repo.
 *
 * Separate-git-dir checkouts intentionally get no expansion: unlike a linked
 * worktree they do not carry the `commondir` relationship this function can
 * validate before widening the Codex workspace-write sandbox.
 */
export function linkedWorktreeWriteDirectories(cwd: string): string[] {
  const marker = findGitMarker(cwd);
  if (marker === undefined) return [];
  if (statSync(marker).isDirectory()) return [];
  if (!statSync(marker).isFile()) {
    throw new Error(`unsupported .git marker at ${marker}`);
  }

  const pointer = readFileSync(marker, "utf8").trim();
  const rawGitDir = pointer.startsWith("gitdir:") ? pointer.slice("gitdir:".length).trim() : "";
  if (rawGitDir === "") throw new Error(`malformed git worktree pointer at ${marker}`);

  const gitDir = requireDirectory(resolve(dirname(marker), rawGitDir), "git worktree admin");
  const commonPointer = join(gitDir, "commondir");
  if (!existsSync(commonPointer)) return [];

  const rawCommonDir = readFileSync(commonPointer, "utf8").trim();
  if (rawCommonDir === "") throw new Error(`empty git commondir pointer at ${commonPointer}`);
  const commonDir = requireDirectory(resolve(gitDir, rawCommonDir), "git common directory");
  const worktreesDir = requireDirectory(join(commonDir, "worktrees"), "git worktrees directory");
  if (!isStrictDescendant(worktreesDir, gitDir) || dirname(gitDir) !== worktreesDir) {
    throw new Error(`git worktree admin is outside ${worktreesDir}: ${gitDir}`);
  }

  return [
    gitDir,
    requireDirectory(join(commonDir, "objects"), "git objects directory"),
    requireDirectory(join(commonDir, "refs"), "git refs directory"),
    requireDirectory(join(commonDir, "logs"), "git logs directory"),
  ];
}
