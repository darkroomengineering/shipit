import { Asc } from "../asc.ts";
import { loadCredentials, type Platform, platformsOf, type ShipConfig, type Target } from "../config.ts";
import { assertRepoRoot, fetchMain, lock, mainVersion } from "../git.ts";
import {
  APP_STORE_LIMITS,
  appStoreProblems,
  appStoreSets,
  chars,
  copyrightLine,
  loadListing,
  loadScreenshots,
  mainSource,
  PLAY_LIMITS,
  type PrivacyAnswer,
  parsePrivacy,
  playProblems,
  playShotProblems,
  pushAppStore,
  pushPlay,
  resolveIn,
  type Screenshot,
  type Source,
} from "../listing.ts";
import { errorMessage, log } from "../log.ts";
import { Play } from "../play.ts";

export interface ListingOptions {
  platform?: Target;
  dry: boolean;
}

function platformsFor(config: ShipConfig, requested?: Target): Platform[] {
  if (!requested) return platformsOf(config);
  if (requested !== "ios" && requested !== "android") throw new Error(`${requested} has no store listing`);
  if (!config[requested]) throw new Error(`ship.json has no ${requested} section`);
  return [requested];
}

async function screenshots(repo: Source, dir: string | null): Promise<Screenshot[] | null> {
  if (!dir) return null;
  const { source, path } = resolveIn(repo, dir);
  return loadScreenshots(source, path);
}

function report(label: string, text: Record<string, string | undefined>, limits: Record<string, number>) {
  for (const [key, value] of Object.entries(text)) {
    if (value === undefined) continue;
    const limit = limits[key];
    log(`${label} ${key} (${chars(value)}${limit ? ` of ${limit}` : ""} characters)`);
  }
}

/**
 * Pushes the store listing from `ios.listing` on main: App Store text, copyright and screenshots on the version on
 * main, and the Play listing text and phone screenshots. Everything is read and checked against the stores' limits
 * before the first call to either store. It never submits anything for review.
 */
export async function listing(config: ShipConfig, options: ListingOptions) {
  const platforms = platformsFor(config, options.platform);
  const file = config.ios?.listing;
  if (!file) throw new Error("ship.json has no ios.listing, the file or folder that holds the store listing");
  const format = config.ios?.listingFormat ?? "json";
  await assertRepoRoot(config.root);
  const unlock = lock(config);
  const failures: string[] = [];
  try {
    await fetchMain(config.root);
    const repo = await mainSource(config.root);
    const store = await loadListing(repo, file, format);
    const ios = platforms.includes("ios");
    const android = platforms.includes("android");
    log(`listing: ${file} (${format}) on main`);

    const problems: string[] = [];
    let sets = new Map<string, Screenshot[]>();
    let privacy: PrivacyAnswer[] | null = null;
    if (ios) {
      report("ios:", { ...store.appStore }, APP_STORE_LIMITS);
      problems.push(...appStoreProblems(store.appStore).map((problem) => `ios: ${problem}`));
      const shots = await screenshots(repo, store.screenshots.ios);
      if (shots) {
        const grouped = appStoreSets(shots);
        sets = grouped.sets;
        problems.push(...grouped.problems.map((problem) => `ios: ${problem}`));
      } else log("ios: no screenshots in the listing; the store's are left as they are");
      if (store.privacy) {
        const { source, path } = resolveIn(repo, store.privacy);
        const text = await source.text(path);
        if (text === undefined) problems.push(`ios: ${store.privacy} does not exist`);
        else privacy = parsePrivacy(text, store.privacy);
      }
    }
    let playShots: Screenshot[] | null = null;
    if (android) {
      report("android:", { ...store.play }, PLAY_LIMITS);
      problems.push(...playProblems(store.play).map((problem) => `android: ${problem}`));
      playShots = await screenshots(repo, store.screenshots.android);
      if (playShots) problems.push(...playShotProblems(playShots).map((problem) => `android: ${problem}`));
      else log("android: no screenshots in the listing; the store's are left as they are");
      if (!options.dry && !config.android?.playKey) problems.push("android: android.playKey is not set in ship.json");
    }
    if (problems.length) throw new Error(`${file} would be refused:\n${problems.join("\n")}`);

    // Each store is pushed even when the other fails; the command fails if either did.
    if (ios && config.ios) {
      try {
        const asc = new Asc(loadCredentials(config), options.dry);
        const app = await asc.app(config.ios.bundleId);
        await pushAppStore(asc, {
          appId: app.id,
          version: await mainVersion(config),
          text: store.appStore,
          copyright: copyrightLine(),
          sets,
          privacy,
          dry: options.dry,
        });
      } catch (error) {
        log(`ios: failed: ${errorMessage(error)}`);
        failures.push(`ios: ${errorMessage(error)}`);
      }
    }
    if (android && config.android) {
      try {
        const android = config.android;
        await pushPlay(() => Play.forConfig(config.root, android), store.play, playShots, options.dry);
      } catch (error) {
        log(`android: failed: ${errorMessage(error)}`);
        failures.push(`android: ${errorMessage(error)}`);
      }
    }
  } finally {
    unlock();
  }
  if (failures.length) throw new Error(failures.join("\n"));
}
