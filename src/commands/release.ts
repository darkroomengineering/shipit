import { releaseIos } from "../appstore.ts";
import { Asc } from "../asc.ts";
import { loadCredentials, type Platform, platformsOf, type ShipConfig } from "../config.ts";
import { assertRepoRoot, lock } from "../git.ts";
import { errorMessage, log } from "../log.ts";
import { releaseAndroid } from "../playlane.ts";

export interface ReleaseOptions {
  platform?: Platform;
  dry: boolean;
}

/**
 * Sends the newest beta to the stores' review: iOS to App Review, Android to Play production. Each platform
 * runs even when the other fails; the command fails if any did.
 */
export async function release(config: ShipConfig, options: ReleaseOptions) {
  const platforms = options.platform ? [options.platform] : platformsOf(config);
  for (const platform of platforms) {
    if (!config[platform]) throw new Error(`ship.json has no ${platform} section`);
  }
  await assertRepoRoot(config.root);
  const unlock = lock(config);
  const failures: string[] = [];
  try {
    for (const platform of platforms) {
      try {
        if (platform === "ios") await releaseIos(config, new Asc(loadCredentials(config), options.dry), options.dry);
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
