import type { ShipConfig } from "./config.ts";
import { fetchTags, git } from "./git.ts";

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
  const span = fromTag && toTag ? [`${fromTag}..${toTag}`] : [toTag ?? "origin/main", `--since=${range.since}`];
  return notesFor(config, span, range.limit);
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
