import { type Asc, attr, type Page, type Resource } from "./asc.ts";
import { errorMessage, log, warn } from "./log.ts";

const POLL_MS = 30_000;
const PROCESSING_TIMEOUT_MS = 60 * 60_000;

/** Waits for Apple's processing (usually 5 to 15 minutes after upload) and returns the build. */
export async function waitForBuild(asc: Asc, appId: string, build: string, version?: string): Promise<Resource> {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  const filter = `filter[app]=${appId}&filter[version]=${build}${version ? `&filter[preReleaseVersion.version]=${version}` : ""}`;
  for (;;) {
    const found = (await asc.list(`/builds?${filter}&fields[builds]=processingState`))[0];
    const state = attr(found, "processingState");
    if (found && state === "VALID") return found;
    if (state === "FAILED" || state === "INVALID") throw new Error(`build ${build} processing ${state}`);
    if (Date.now() > deadline) throw new Error(`build ${build} still ${state ?? "not listed"} after an hour`);
    log(`build ${build}: ${state ?? "not visible yet"}, waiting`);
    await Bun.sleep(POLL_MS);
  }
}

export interface DistributeOptions {
  asc: Asc;
  appId: string;
  build: string;
  version: string;
  whatToTest: string;
  groups: string[];
  dry: boolean;
}

const inReview = (error: unknown) => String(error).includes("ANOTHER_BUILD_IN_REVIEW");

/**
 * Sends an uploaded build to its external TestFlight groups and submits it for Beta App Review, so every
 * tester gets each build. An older build stuck in that review is expired first.
 */
export async function distribute(options: DistributeOptions) {
  const { asc, appId, build, version, whatToTest, groups, dry } = options;
  if (dry) {
    log(`dry run: skipped waiting for build ${build} to process`);
    log(`dry run: skipped What to Test, adding to ${groups.join(", ")}, and Beta App Review submission`);
    return;
  }
  const found = await waitForBuild(asc, appId, build, version);

  // Apple sometimes creates the en-US note itself, so update it when it already exists.
  const [note] = await asc.list(`/builds/${found.id}/betaBuildLocalizations`);
  await (note
    ? asc.patch(`/betaBuildLocalizations/${note.id}`, {
        data: { type: "betaBuildLocalizations", id: note.id, attributes: { whatsNew: whatToTest } },
      })
    : asc.post("/betaBuildLocalizations", {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: "en-US", whatsNew: whatToTest },
          relationships: { build: { data: { type: "builds", id: found.id } } },
        },
      })
  ).catch((error) => warn(`what to test not set: ${errorMessage(error)}`));

  const existing = await asc.list(`/apps/${appId}/betaGroups?limit=200`);
  for (const name of groups) {
    const group = existing.find((candidate) => attr(candidate, "name") === name);
    if (!group) throw new Error(`no TestFlight group named "${name}"`);
    await asc.post(`/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: found.id }] });
    log(`build ${build} added to "${name}"`);
  }

  // Only the first build of each version waits for a human; later ones clear in minutes. A build already
  // submitted or approved rejects a second submission, so only a build waiting to be submitted is sent.
  const detail = await asc.api<{ data: Resource }>(`/builds/${found.id}/buildBetaDetail`).catch(() => undefined);
  const reviewState = attr(detail?.data, "externalBuildState");
  if (reviewState && reviewState !== "READY_FOR_BETA_SUBMISSION") {
    log(`build ${build} beta review state is ${reviewState}; not submitting`);
    return;
  }
  const submit = (id: string) =>
    asc.post("/betaAppReviewSubmissions", {
      data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id } } } },
    });
  try {
    await submit(found.id);
    log(`build ${build} submitted for Beta App Review`);
  } catch (error) {
    if (!inReview(error)) throw error;
    try {
      if ((await expireOlderInReview(asc, appId, found.id, build)) === 0) throw error;
      await submit(found.id);
      log(`build ${build} submitted for Beta App Review`);
    } catch (retry) {
      // A newer build, or one attached to the App Store, holds the slot. Re-run once that review ends.
      if (!inReview(retry)) throw retry;
      log(`build ${build} not submitted: another build is in review; ship beta submits the next build`);
    }
  }
}

/**
 * Apple reviews one build per version at a time, and a build waiting there can sit for a day. Older builds of
 * the same version still in review are superseded by this one, so they're expired to free the slot. A build
 * attached to an App Store version is left alone: expiring it would pull it from that submission.
 */
async function expireOlderInReview(asc: Asc, appId: string, id: string, build: string): Promise<number> {
  const pre = await asc.api<{ data: Resource }>(`/builds/${id}/preReleaseVersion?fields[preReleaseVersions]=version`);
  const version = attr(pre.data, "version");
  if (!version) throw new Error(`build ${build} has no version`);
  // One version gets a few builds a day, far fewer than 200.
  const page = await asc.api<Page>(
    `/builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${version}&filter[expired]=false&sort=-uploadedDate&limit=200` +
      "&fields[builds]=version,betaAppReviewSubmission,appStoreVersion&include=betaAppReviewSubmission,appStoreVersion" +
      "&fields[betaAppReviewSubmissions]=betaReviewState&fields[appStoreVersions]=versionString",
  );
  const reviews = new Map((page.included ?? []).map((item) => [item.id, attr(item, "betaReviewState")]));
  const index = page.data.findIndex((candidate) => candidate.id === id);
  if (index < 0) return 0;
  let expired = 0;
  for (const older of page.data.slice(index + 1)) {
    const submission = older.relationships?.betaAppReviewSubmission?.data;
    const review = submission ? reviews.get(submission.id) : undefined;
    if (review !== "WAITING_FOR_REVIEW" && review !== "IN_REVIEW") continue;
    if (older.relationships?.appStoreVersion?.data) {
      log(`build ${attr(older, "version")} is in Beta App Review but attached to an App Store version; left alone`);
      continue;
    }
    await asc.patch(`/builds/${older.id}`, { data: { type: "builds", id: older.id, attributes: { expired: true } } });
    log(`build ${attr(older, "version")} expired: it was in Beta App Review (${review}) and this build supersedes it`);
    expired++;
  }
  return expired;
}

/**
 * Upload date of the newest build testers can still install (processed and not expired), for keepAlive:
 * TestFlight expires builds 90 days after upload, and a failed upload keeps nothing alive.
 */
export async function lastUpload(asc: Asc, appId: string): Promise<Date | undefined> {
  const [build] = await asc.list(
    `/builds?filter[app]=${appId}&filter[processingState]=VALID&filter[expired]=false&sort=-uploadedDate&limit=1&fields[builds]=uploadedDate`,
  );
  const date = attr(build, "uploadedDate");
  return date ? new Date(date) : undefined;
}
