import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolvePath, type ShipConfig, slug } from "./config.ts";
import { log, run, warn } from "./log.ts";
import { readVersion, writeVersion } from "./version.ts";

export const git = (root: string, ...args: string[]) =>
  run(["git", "-C", root, ...args], { capture: true }).then((out) => out.trim());

export async function assertRepoRoot(root: string) {
  const top = await git(root, "rev-parse", "--show-toplevel").catch(() => "");
  if (!top || realpathSync(top) !== realpathSync(root))
    throw new Error(`${root} must be the root of a git repository (ship.json lives next to .git)`);
}

/** Repositories without an `origin` remote (local-only apps) release their local main and push nothing. */
export const hasRemote = (root: string) =>
  git(root, "remote").then((remotes) => remotes.split("\n").includes("origin"));

/** The branch every build comes from: GitHub's main, or the local main of a repository with no remote. */
export const mainRef = async (root: string) => ((await hasRemote(root)) ? "origin/main" : "main");

export const fetchMain = async (root: string) => {
  if (await hasRemote(root)) await git(root, "fetch", "-q", "origin", "main");
};
export const fetchTags = async (root: string) => {
  if (await hasRemote(root)) await git(root, "fetch", "-q", "--tags", "origin");
};

/** A file as it is on main (see `mainRef`). */
export const showMain = async (root: string, file: string) =>
  run(["git", "-C", root, "show", `${await mainRef(root)}:${file}`], { capture: true });

export async function mainVersion(config: ShipConfig): Promise<string> {
  return readVersion(config.version, await showMain(config.root, config.version.file));
}

/** Version for read-only commands: GitHub's main when the folder is a repository, otherwise the file on disk. */
export async function currentVersion(config: ShipConfig): Promise<string | undefined> {
  try {
    return await mainVersion(config);
  } catch {
    const file = resolvePath(config.root, config.version.file);
    return existsSync(file) ? readVersion(config.version, readFileSync(file, "utf8")) : undefined;
  }
}

/** Another ship run holds the lock for this app; the command exits 75. */
export class BusyError extends Error {}

/** One release at a time per app. */
export function lock(config: ShipConfig): () => void {
  const file = join(tmpdir(), `shipit-${slug(config)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch {
      const holder = Number(readFileSync(file, "utf8"));
      let alive = false;
      try {
        process.kill(holder, 0);
        alive = true;
      } catch {
        // The holder is gone; its lock is stale.
      }
      if (alive) throw new BusyError(`another ship run is working on ${config.name} (pid ${holder})`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`could not take the release lock ${file}`);
}

interface WorktreeOptions {
  /** Reuse one worktree between runs, so Pods, node_modules and DerivedData stay warm. */
  persistent?: boolean;
}

/**
 * Runs `work` in a clean worktree of `ref`. Uncommitted changes in the working copy never reach it; gitignored
 * files only arrive through the `copy` lists.
 */
export async function withWorktree<T>(
  config: ShipConfig,
  ref: string,
  work: (dir: string) => Promise<T>,
  options: WorktreeOptions = {},
): Promise<T> {
  const { root } = config;
  if (options.persistent) {
    const dir = join(homedir(), "Library", "Caches", "shipit", slug(config), "worktree");
    if (existsSync(join(dir, ".git"))) {
      await git(dir, "checkout", "-q", "-f", "--detach", ref);
      await git(dir, "clean", "-fdq");
    } else {
      mkdirSync(dirname(dir), { recursive: true });
      await git(root, "worktree", "prune");
      await git(root, "worktree", "add", "-q", "--detach", dir, ref);
    }
    return work(dir);
  }
  const parent = mkdtempSync(join(tmpdir(), "shipit-"));
  const dir = join(parent, basename(root));
  await git(root, "worktree", "add", "-q", "--detach", dir, ref);
  try {
    return await work(dir);
  } finally {
    await git(root, "worktree", "remove", "--force", dir).catch((error) => warn(`worktree cleanup: ${error}`));
    rmSync(parent, { recursive: true, force: true });
  }
}

/** Copies gitignored files and folders from the working copy into the build worktree. */
export function copyIgnored(config: ShipConfig, worktree: string, paths: string[]) {
  for (const path of new Set(paths)) {
    const from = join(config.root, path);
    if (!existsSync(from)) throw new Error(`${path} is listed in copy but missing from ${config.root}`);
    const to = join(worktree, path);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
}

/** Commits a new version to main from a throwaway worktree, so the working copy is untouched. */
export async function pushVersion(config: ShipConfig, next: string) {
  const message = `chore: start version ${next}`;
  const remote = await hasRemote(config.root);
  let commit = "";
  await withWorktree(config, await mainRef(config.root), async (dir) => {
    const file = join(dir, config.version.file);
    writeFileSync(file, writeVersion(config.version, readFileSync(file, "utf8"), next));
    await git(dir, "-c", "commit.gpgsign=false", "commit", "-qam", message);
    if (remote) await git(dir, "push", "-q", "origin", "HEAD:main");
    commit = await git(dir, "rev-parse", "HEAD");
  });
  if (remote) {
    await fetchMain(config.root);
    log(`pushed "${message}" to main`);
    return;
  }
  // Moving a checked-out branch ref would leave the working copy showing the bump reversed, so fast-forward it.
  if ((await git(config.root, "branch", "--show-current")) === "main")
    await git(config.root, "merge", "-q", "--ff-only", commit);
  else await git(config.root, "branch", "-f", "main", commit);
  log(`committed "${message}" to local main`);
}

export async function tagBuild(config: ShipConfig, tag: string, commit: string, message: string) {
  await git(config.root, "-c", "tag.gpgsign=false", "tag", "-a", tag, commit, "-m", message);
  if (await hasRemote(config.root)) await git(config.root, "push", "-q", "origin", tag);
}

/** The nearest build tag (v<version>-<build>) at or before `commit`, the start of its release-note range. */
export async function previousTag(root: string, commit: string): Promise<string | undefined> {
  const tag = await git(root, "describe", "--tags", "--abbrev=0", "--match", "v*-*", commit).catch(() => "");
  return tag || undefined;
}

export const subjectOf = (root: string, ref: string) => git(root, "log", "-1", "--format=%s", ref);
