import { type Asc, attr, type Resource } from "./asc.ts";
import type { ShipConfig } from "./config.ts";
import { fetchMain, mainVersion, pushVersion, showMain } from "./git.ts";
import { log } from "./log.ts";
import { releaseNotes } from "./notes.ts";
import { bump } from "./version.ts";

// Until approval a version takes new builds, and the nightly job can swap the newest one into review.
export const OPEN = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);
// A build counts as new until a submitted version carries it, so one that missed a night (still processing, or a
// submit that failed partway, including after a withdrawal) goes out the next night.
const UNSUBMITTED = new Set(["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "DEVELOPER_REJECTED"]);
const DAY = 24 * 60 * 60 * 1000;

interface Listing {
  description?: string;
  keywords?: string;
}

const versionFields = "fields[appStoreVersions]=versionString,appStoreState";

/**
 * Makes sure the version on GitHub's main can still take builds. App Store Connect closes a version to new
 * uploads once App Review approves it, so an approved or released version gets its patch bumped on main, and
 * the next builds carry the new version. A dry run reports the bump and does not push it.
 */
export async function openVersion(
  config: ShipConfig,
  asc: Asc,
  appId: string,
  dry: boolean,
): Promise<{ version: string; bumped: boolean }> {
  await fetchMain(config.root);
  const version = await mainVersion(config);
  const [current] = await asc.list(
    `/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${version}&${versionFields}`,
  );
  const state = attr(current, "appStoreState");
  if (!state || OPEN.has(state)) return { version, bumped: false };

  const next = bump(version, "patch");
  log(`${version} is ${state}, starting ${next}`);
  if (dry) log(`dry run: skipped pushing "chore: start version ${next}" to main`);
  else await pushVersion(config, next);
  return { version: next, bumped: true };
}

/**
 * Sends the newest TestFlight build of the current version to App Review, with release notes from the feat/fix
 * commits since the live build. A submission still waiting for or in review is withdrawn and replaced, so each
 * release carries every build since the live one.
 */
export async function releaseIos(config: ShipConfig, asc: Asc, dry: boolean) {
  const ios = config.ios;
  if (!ios) throw new Error("ship.json has no ios section");
  const app = await asc.app(ios.bundleId);
  const say = (message: string) => log(`ios: ${message}`);

  // The version moves on only when `ship beta` builds iOS after an approval, so a live version with no new build just waits.
  await fetchMain(config.root);
  const version = await mainVersion(config);
  const versions = await asc.list(`/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20&${versionFields}`);
  const current = versions.find((candidate) => attr(candidate, "versionString") === version);
  const state = attr(current, "appStoreState");
  if (state && !OPEN.has(state)) {
    say(`${version} is ${state}; the next iOS build starts a new version`);
    return;
  }

  const [build] = await asc.list(
    `/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${version}&filter[processingState]=VALID&filter[expired]=false&sort=-uploadedDate&limit=1&fields[builds]=version,uploadedDate`,
  );
  const attached = current
    ? (await asc.api<{ data: Resource | null }>(`/appStoreVersions/${current.id}/build`)).data
    : null;
  if (!build || (attached?.id === build.id && !UNSUBMITTED.has(state ?? ""))) {
    say(`no new ${version} build in TestFlight`);
    return;
  }
  const buildNumber = attr(build, "version") ?? "";

  const live = versions.find((candidate) => attr(candidate, "appStoreState") === "READY_FOR_SALE");
  const liveBuild = live
    ? (
        await asc.api<{ data: Resource | null }>(
          `/appStoreVersions/${live.id}/build?fields[builds]=version,uploadedDate`,
        )
      ).data
    : null;
  const notes = await releaseNotes(config, {
    from: attr(liveBuild ?? undefined, "version"),
    to: buildNumber,
    since: attr(liveBuild ?? undefined, "uploadedDate") ?? new Date(Date.now() - 7 * DAY).toISOString(),
    limit: 3900,
  });

  say(`submitting ${version} build ${buildNumber} (${state ?? "new version"})\n${notes}`);
  if (dry) {
    say("dry run: skipped withdrawing the current submission, attaching the build, and submitting for App Review");
    return;
  }

  if (current && (state === "WAITING_FOR_REVIEW" || state === "IN_REVIEW")) {
    await withdraw(asc, app.id, current.id, version, state);
    say(`withdrew ${version} build ${attr(attached ?? undefined, "version") ?? "?"} from review`);
  }
  const target =
    current ??
    (
      await asc.api<{ data: Resource }>("/appStoreVersions", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "appStoreVersions",
            attributes: { platform: "IOS", versionString: version },
            relationships: { app: { data: { type: "apps", id: app.id } } },
          },
        }),
      })
    ).data;

  // Store text shared with other apps lives in a repo file (description, keywords); it is read from GitHub's main.
  const listing: Listing = ios.listing ? (JSON.parse(await showMain(config.root, ios.listing)) as Listing) : {};
  await submit(asc, app.id, target.id, version, build, notes, listing);
}

/** An app has one submission in review at a time; withdrawing it makes the version editable again. */
async function withdraw(asc: Asc, appId: string, versionId: string, version: string, state: string) {
  const open = await asc.list(
    `/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&filter[state]=WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES`,
  );
  for (const submission of open) {
    await asc.patch(`/reviewSubmissions/${submission.id}`, {
      data: { type: "reviewSubmissions", id: submission.id, attributes: { canceled: true } },
    });
  }
  let now = state;
  for (let i = 0; i < 40 && now !== "DEVELOPER_REJECTED" && now !== "PREPARE_FOR_SUBMISSION"; i++) {
    await Bun.sleep(15_000);
    const refreshed = await asc.api<{ data: Resource }>(
      `/appStoreVersions/${versionId}?fields[appStoreVersions]=appStoreState`,
    );
    now = attr(refreshed.data, "appStoreState") ?? now;
  }
  if (now !== "DEVELOPER_REJECTED" && now !== "PREPARE_FOR_SUBMISSION")
    throw new Error(`${version} is still ${now} 10 minutes after withdrawing it`);
}

/** Attaches a build to an App Store version, sets its release notes, and submits it for App Review. */
async function submit(
  asc: Asc,
  appId: string,
  versionId: string,
  version: string,
  build: Resource,
  whatsNew: string,
  listing: Listing,
) {
  await asc.patch(`/appStoreVersions/${versionId}/relationships/build`, { data: { type: "builds", id: build.id } });
  const localizations = await asc.list(`/appStoreVersions/${versionId}/appStoreVersionLocalizations`);
  const en = localizations.find((localization) => attr(localization, "locale") === "en-US");
  if (!en) throw new Error(`App Store version ${version} has no en-US localization`);
  await asc.patch(`/appStoreVersionLocalizations/${en.id}`, {
    data: {
      type: "appStoreVersionLocalizations",
      id: en.id,
      attributes: { whatsNew, description: listing.description, keywords: listing.keywords },
    },
  });
  log(`ios: attached build ${attr(build, "version")} and release notes to ${version}`);

  // Resume the draft that already holds this version (left by a run that failed partway); otherwise open a new
  // one, so a draft someone started by hand is never submitted along with it.
  const drafts = await asc.list(
    `/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`,
  );
  let submission: Resource | undefined;
  for (const draft of drafts) {
    const items = await asc.list(`/reviewSubmissions/${draft.id}/items?include=appStoreVersion`);
    if (items.length === 1 && items[0]?.relationships?.appStoreVersion?.data?.id === versionId) submission = draft;
  }
  if (!submission) {
    submission = (
      (await asc.post("/reviewSubmissions", {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: "IOS" },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      })) as { data: Resource }
    ).data;
    await asc.post("/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    });
  }
  await asc.patch(`/reviewSubmissions/${submission.id}`, {
    data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } },
  });
  const state = (
    await asc.api<{ data: Resource }>(`/appStoreVersions/${versionId}?fields[appStoreVersions]=appStoreState`)
  ).data;
  log(`ios: submitted ${version} for review: ${attr(state, "appStoreState")}`);
}
