import type { ShipConfig } from "./config.ts";
import { log } from "./log.ts";
import { releaseNotes } from "./notes.ts";
import { newestCode, Play, type PlayRelease } from "./play.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOTES_LIMIT = 500;
const GENERIC = "Bug fixes and improvements.";

/** Android version code: minutes since the epoch minus nocam's offset, so Play gets an integer under 2.1 billion. */
export const versionCodeFor = (at: Date) => Math.floor(at.getTime() / 60_000) - 29_000_000;

/** iOS build number for one instant: UTC yyyyMMddHHmm. */
export function buildNumberFor(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
}

/** The build number a version code was made from, which names its release tag. */
export const buildOf = (code: number) => buildNumberFor(new Date((code + 29_000_000) * 60_000));

/** Uploads a bundle to the internal track and rolls it out. */
export async function uploadInternal(config: ShipConfig, bundle: string, notes: string): Promise<number> {
  const android = config.android;
  if (!android) throw new Error("ship.json has no android section");
  const play = Play.forConfig(config.root, android);
  const edit = await play.newEdit();
  const code = await play.uploadBundle(edit, bundle);
  log(`android: uploaded version code ${code}`);
  await play.setTrack(edit, "internal", {
    versionCode: String(code),
    status: "completed",
    notes: notes.slice(0, NOTES_LIMIT),
  });
  await play.commit(edit);
  log(`android: released version code ${code} to internal`);
  return code;
}

/**
 * Production release: when internal testing has a newer build than production, it goes to production for
 * everyone, with release notes from the feat/fix commits since the build it replaces. A production release
 * still in review is replaced and its notes carried over, so each release lists every change since the live
 * build. Until the app's first publish Play only takes drafts, so the newest build replaces the production draft.
 */
export async function releaseAndroid(config: ShipConfig, dry: boolean) {
  const android = config.android;
  if (!android) throw new Error("ship.json has no android section");
  const say = (message: string) => log(`android: ${message}`);
  // Play reads tracks only through an edit, and an edit can invalidate one another session has open, so a dry
  // run opens none.
  if (dry) {
    say(
      "dry run: skipped checking the internal and production tracks and promoting the newest internal build to production",
    );
    return;
  }
  const play = Play.forConfig(config.root, android);

  const edit = await play.newEdit();
  const production = await play.releases(edit, "production");
  const candidate = newestCode(await play.releases(edit, "internal"));
  if (!candidate || candidate <= newestCode(production)) {
    say(`no internal build newer than production's ${newestCode(production) || "none"}`);
    await play.deleteEdit(edit);
    return;
  }

  const previous = production
    .filter((release) => release.status === "completed")
    .sort((a, b) => newestCode([b]) - newestCode([a]))[0];
  const live = previous ? newestCode([previous]) : 0;
  const notes = await releaseNotes(config, {
    from: live ? buildOf(live) : undefined,
    to: buildOf(candidate),
    since: new Date(Date.now() - 7 * DAY).toISOString(),
    limit: NOTES_LIMIT,
  });
  say(`sending version code ${candidate} to production\n${notes}`);

  // Play does not say whether the newest production release is live or still in review. A commit that refuses to
  // replace changes in review tells the two apart: when it is refused, that release never reached users, so its
  // notes join the new build's and the review is restarted with both.
  // SHORTCUT: Play refuses for any change in review, a listing update included. ceiling: a live release's
  // notes repeat when only the listing was in review. upgrade: record each production release's live date
  // from Play Console if listing and release reviews start overlapping.
  const carried = (text: string, earlier: PlayRelease | undefined) => {
    const before = earlier?.releaseNotes?.find((note) => note.language === "en-US")?.text ?? "";
    const lines = [...new Set([...text.split("\n"), ...before.split("\n")].filter((line) => line && line !== GENERIC))];
    let out = "";
    for (const line of lines) {
      const next = out ? `${out}\n${line}` : line;
      if (next.length > NOTES_LIMIT) break;
      out = next;
    }
    return out || GENERIC;
  };
  const send = async (id: string, status: "completed" | "draft", text: string, behavior: string) => {
    await play.setTrack(id, "production", { versionCode: String(candidate), status, notes: text });
    await play.call(`${play.api}/edits/${id}:commit?changesInReviewBehavior=${behavior}`, { method: "POST" });
  };
  try {
    try {
      await send(edit, "completed", notes, "ERROR_IF_IN_REVIEW");
    } catch (error) {
      if (!String(error).includes("CHANGES_ALREADY_IN_REVIEW")) throw error;
      const all = carried(notes, previous);
      say(`version code ${live} is still in review; replacing it, with its notes\n${all}`);
      await send(await play.newEdit(), "completed", all, "CANCEL_IN_REVIEW_AND_SUBMIT");
    }
    say(`version code ${candidate} sent to production for review`);
  } catch (error) {
    if (!String(error).includes("status draft")) throw error;
    await send(await play.newEdit(), "draft", notes, "CANCEL_IN_REVIEW_AND_SUBMIT");
    say(
      `version code ${candidate} is the production draft; send it for review in Play Console until the app's first publish`,
    );
  }
}
