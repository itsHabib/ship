import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
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

function optionalDirectory(path: string, label: string): string[] {
  if (!existsSync(path)) return [];
  return [requireDirectory(path, label)];
}

function requireRefStores(commonDir: string): string[] {
  const stores = [
    ...optionalDirectory(join(commonDir, "refs"), "git refs directory"),
    ...optionalDirectory(join(commonDir, "reftable"), "git reftable directory"),
  ];
  if (stores.length === 0) throw new Error(`git ref storage is missing under ${commonDir}`);
  return stores;
}

function standaloneGitDirectory(cwd: string, marker: string): string {
  const workdir = realpathSync(cwd);
  const repoRoot = realpathSync(dirname(marker));
  if (workdir !== repoRoot && !isStrictDescendant(repoRoot, workdir)) {
    throw new Error(`codex workdir is outside its repository root: ${workdir}`);
  }

  const gitDir = requireDirectory(marker, "git metadata directory");
  if (dirname(gitDir) !== repoRoot || gitDir !== join(repoRoot, ".git")) {
    throw new Error(`git metadata directory is outside its repository root: ${gitDir}`);
  }
  return gitDir;
}

/**
 * Return the extra writable roots needed for `git add` + `git commit` while
 * retaining Codex's `workspace-write` sandbox.
 *
 * A standalone checkout needs its own validated `.git` directory admitted
 * explicitly because Codex otherwise mounts Git metadata read-only. A linked
 * worktree keeps its index and HEAD in a per-worktree admin directory while
 * sharing objects, ref storage, and optional reflogs with the main repo.
 *
 * Separate-git-dir checkouts intentionally get no expansion: unlike a linked
 * worktree they do not carry the `commondir` relationship this function can
 * validate before widening the Codex workspace-write sandbox.
 */
export function gitWritableRoots(cwd: string): string[] {
  const marker = findGitMarker(cwd);
  if (marker === undefined) return [];
  const markerInfo = lstatSync(marker);
  if (markerInfo.isDirectory()) return [standaloneGitDirectory(cwd, marker)];
  if (!markerInfo.isFile()) {
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
    ...requireRefStores(commonDir),
    ...optionalDirectory(join(commonDir, "logs"), "git logs directory"),
  ];
}
