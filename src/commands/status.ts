import { Asc, attr, type Resource } from "../asc.ts";
import { loadCredentials, type ShipConfig } from "../config.ts";
import { currentVersion } from "../git.ts";
import { errorMessage } from "../log.ts";
import { newestCode, Play } from "../play.ts";

const line = (label: string, value: string) => console.log(`  ${label.padEnd(24)}${value}`);

async function iosStatus(config: ShipConfig) {
  const ios = config.ios;
  if (!ios) return;
  console.log(`iOS ${ios.bundleId}`);
  const asc = new Asc(loadCredentials(config), true);
  const app = await asc.app(ios.bundleId);

  const builds = (await asc.api(
    `/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=1&fields[builds]=version,uploadedDate,processingState,expired,preReleaseVersion` +
      "&include=preReleaseVersion&fields[preReleaseVersions]=version",
  )) as { data: Resource[]; included?: Resource[] };
  const build = builds.data[0];
  if (build) {
    const pre = build.relationships?.preReleaseVersion?.data?.id;
    const version =
      attr(
        builds.included?.find((item) => item.id === pre),
        "version",
      ) ?? "?";
    const expired = build.attributes?.expired ? ", expired" : "";
    line(
      "latest TestFlight build",
      `${attr(build, "version")} for ${version} (${attr(build, "processingState")}${expired}, uploaded ${attr(build, "uploadedDate")})`,
    );
    try {
      const detail = await asc.api<{ data: Resource }>(`/builds/${build.id}/buildBetaDetail`);
      line(
        "beta review",
        `${attr(detail.data, "externalBuildState") ?? "?"} (internal: ${attr(detail.data, "internalBuildState") ?? "?"})`,
      );
    } catch {
      // A build without beta detail has no review state to show.
    }
  } else {
    line("latest TestFlight build", "none");
  }

  const versions = await asc.list(
    `/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=5&fields[appStoreVersions]=versionString,appStoreState`,
  );
  for (const version of versions)
    line(`App Store ${attr(version, "versionString")}`, attr(version, "appStoreState") ?? "?");
}

async function androidStatus(config: ShipConfig) {
  const android = config.android;
  if (!android) return;
  console.log(`Android ${android.package}`);
  if (!android.playKey) return line("Play", "no playKey in ship.json");
  const play = Play.inspector(config.root, android);
  const edit = await play.newEdit();
  try {
    for (const track of ["internal", "production"]) {
      const releases = await play.releases(edit, track);
      const newest = releases.find((release) =>
        (release.versionCodes ?? []).map(Number).includes(newestCode(releases)),
      );
      line(`Play ${track}`, newest ? `version code ${newestCode(releases)} (${newest.status})` : "none");
    }
  } finally {
    await play.deleteEdit(edit);
  }
}

export async function status(config: ShipConfig) {
  console.log(`${config.name}  version ${(await currentVersion(config)) ?? "unknown"}`);
  let failed = false;
  for (const part of [iosStatus, androidStatus]) {
    try {
      await part(config);
    } catch (error) {
      failed = true;
      console.error(`  failed: ${errorMessage(error)}`);
    }
  }
  if (failed) process.exitCode = 1;
}
