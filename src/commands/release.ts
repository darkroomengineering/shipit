import { releaseIos } from "../appstore.ts";
import { Asc } from "../asc.ts";
import { lanesFor, loadCredentials, type ShipConfig, type Target } from "../config.ts";
import { assertRepoRoot, builtPlatforms, fetchMain, fetchTags, lock, mainRef } from "../git.ts";
import { errorMessage, log } from "../log.ts";
import { releaseAndroid } from "../playlane.ts";
import { runBeta } from "./beta.ts";

export interface ReleaseOptions {
  platform?: Target;
  dry: boolean;
  skipChecks?: boolean;
  unattended?: boolean;
}

/**
 * Ships main to the stores in one step: runs the beta (build, upload, TestFlight / Play internal), then sends
 * the newest beta to review: iOS to App Review, Android to Play production. Platforms whose build of main's
 * head commit is already uploaded skip the build, so re-runs and quiet nights don't upload duplicates. Each
 * platform's review step runs even when the other fails; the command fails if any did.
 */
export async function release(config: ShipConfig, options: ReleaseOptions) {
  const platforms = lanesFor(config, options.platform);
  await assertRepoRoot(config.root);
  const unlock = lock(config);
  const failures: string[] = [];
  try {
    await fetchMain(config.root);
    await fetchTags(config.root);
    const built = await builtPlatforms(config.root, await mainRef(config.root));
    const toBuild = platforms.filter((platform) => !built.has(platform));
    if (toBuild.length < platforms.length)
      log(`main's head already has a ${platforms.filter((p) => built.has(p)).join(" + ")} beta; not rebuilding it`);
    // A failed build stops the release: sending the previous beta to review would ship something older than main.
    if (toBuild.length) await runBeta(config, toBuild, { dry: options.dry, skipChecks: options.skipChecks ?? false });
    for (const platform of platforms) {
      try {
        if (platform === "ios")
          await releaseIos(config, new Asc(loadCredentials(config), options.dry), options.dry, options.unattended);
        else await releaseAndroid(config, options.dry);
      } catch (error) {
        log(`${platform}: failed: ${errorMessage(error)}`);
        failures.push(`${platform}: ${errorMessage(error)}`);
      }
    }
  } finally {
    unlock();
  }
  if (failures.length) throw new Error(failures.join("\n"));
}
