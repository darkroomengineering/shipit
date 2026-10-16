import type { Platform, ShipConfig } from "./config.ts";
import { fetchTags, git, mainRef, showMain } from "./git.ts";
import { log } from "./log.ts";

export const GENERIC_NOTES = "Bug fixes and improvements.";

export interface NotesRange {
  /** A build number or a git ref that starts the range (exclusive). */
  from?: string;
  /** A build number or a git ref that ends the range. */
  to: string;
  /** Fallback start when a build has no tag: commits since this ISO date. */
  since: string;
  limit: number;
}

async function tagOf(root: string, build?: string) {
  if (!build) return undefined;
  return (await git(root, "tag", "-l", `v*-${build}`)).split("\n").filter(Boolean)[0];
}

/**
 * Store release notes: the feat/fix/perf commit subjects that changed the app between two builds, found through
 * the v<version>-<build> tags that `ship beta` pushes. Untagged builds fall back to the commits since `since`.
 * Only commits touching `notesPaths` count, so tooling and other-platform changes stay out of the notes.
 */
export async function releaseNotes(config: ShipConfig, range: NotesRange): Promise<string> {
  const { root } = config;
  await fetchTags(root);
  const [fromTag, toTag] = [await tagOf(root, range.from), await tagOf(root, range.to)];
  const span = fromTag && toTag ? [`${fromTag}..${toTag}`] : [toTag ?? (await mainRef(root)), `--since=${range.since}`];
  return notesFor(config, span, range.limit);
}

/** The version a build was tagged with by `ship beta`, if it was. */
export async function versionOfBuild(root: string, build: string): Promise<string | undefined> {
  await fetchTags(root);
  return (await tagOf(root, build))?.match(/^v(.+)-[^-]+$/)?.[1];
}

/**
 * Hand-written store notes from ship.json's `notesFile` on main. The file opens with `# <version>`; lines before
 * any `## iOS` or `## Android` heading go to both stores, lines under one go to that store only. Returns undefined,
 * so the caller falls back to commit subjects, when no file is configured, it is not on main, or it names another
 * version: a file left over from the last release must never describe this one.
 */
export async function fileNotes(
  config: ShipConfig,
  platform: Platform,
  version: string,
  limit: number,
): Promise<string | undefined> {
  const file = config.notesFile;
  if (!file) return undefined;
  const text = await showMain(config.root, file).catch(() => undefined);
  if (text === undefined) {
    log(`${platform}: ${file} is not on main; using commit subjects`);
    return undefined;
  }
  const lines = text.split("\n").map((line) => line.trimEnd());
  const title = lines.find((line) => line.trim())?.match(/^#\s+(\S+)\s*$/)?.[1];
  if (title !== version) {
    log(`${platform}: ${file} is for ${title ?? "no version"}, not ${version}; using commit subjects`);
    return undefined;
  }
  let section: Platform | "both" = "both";
  const kept: string[] = [];
  for (const line of lines.slice(lines.findIndex((line) => line.trim()) + 1)) {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1]?.toLowerCase();
    if (heading) {
      if (heading !== "ios" && heading !== "android")
        throw new Error(`${file}: unknown section "## ${heading}"; use "## iOS" or "## Android"`);
      section = heading;
      continue;
    }
    if (line.trim() && (section === "both" || section === platform)) kept.push(line);
  }
  const notes = kept.join("\n");
  if (!notes) return undefined;
  if (notes.length > limit)
    throw new Error(`${file}: the ${platform} notes are ${notes.length} characters; the store allows ${limit}`);
  return notes;
}

/** Notes for a build that is not tagged yet: commits from the previous build's tag to `commit`. */
export async function notesSince(
  config: ShipConfig,
  previous: string | undefined,
  commit: string,
  limit: number,
): Promise<string> {
  const span = previous ? [`${previous}..${commit}`] : [commit, "-n", "20"];
  return notesFor(config, span, limit);
}

async function notesFor(config: ShipConfig, span: string[], limit: number): Promise<string> {
  const paths = config.notesPaths.length ? ["--", ...config.notesPaths] : [];
  const subjects = (await git(config.root, "log", ...span, "--format=%s", ...paths)).split("\n");
  const lines = subjects
    .filter((subject) => /^(feat|fix|perf)(\(.+\))?: /.test(subject))
    .map((subject) => subject.replace(/^\w+(\(.+\))?: /, ""))
    // Lowercase-first names like "iPhone" keep their case.
    .map(
      (subject) => `- ${/^[a-z][A-Z]/.test(subject) ? subject : subject.charAt(0).toUpperCase() + subject.slice(1)}`,
    );
  // Newest first; whole lines only, as many as fit the store's limit.
  let notes = "";
  for (const line of lines) {
    const next = notes ? `${notes}\n${line}` : line;
    if (next.length > limit) break;
    notes = next;
  }
  return notes || GENERIC_NOTES;
}
