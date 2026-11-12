import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openVersion, type StoreLane } from "../appstore.ts";
import { Asc } from "../asc.ts";
import { buildAndroid } from "../build-android.ts";
import { buildIos } from "../build-ios.ts";
import { shipMac } from "../build-mac.ts";
import { shipMacAppStore } from "../build-mac-appstore.ts";
import { buildsHere, pinnedRun, publishRelease, shipWindows } from "../build-windows.ts";
import {
  lanesFor,
  loadCredentials,
  type Platform,
  platformsOf,
  resolvePath,
  type ShipConfig,
  type Target,
  type WindowsRelease,
} from "../config.ts";
import {
  assertRepoRoot,
  copyIgnored,
  fetchMain,
  fetchTags,
  git,
  lock,
  mainRef,
  mainVersion,
  previousTag,
  subjectOf,
  tagBuild,
  withWorktree,
} from "../git.ts";
import { errorMessage, log, run, warn, write } from "../log.ts";
import { GENERIC_NOTES, notesSince } from "../notes.ts";
import { buildOf, runBuildNumber, uploadInternal, versionCodeFor } from "../playlane.ts";
import { distribute } from "../testflight.ts";
import { readVersion, writeVersion } from "../version.ts";

export interface BetaOptions {
  platform?: Target;
  dry: boolean;
  skipChecks: boolean;
  /** Dry runs only: build this ref instead of main, to test a branch before it lands. */
  ref?: string;
  /**
   * Mac lanes only: mac builds, signs, notarizes and writes the appcast, macAppStore builds, packages and validates;
   * both stop before uploading or tagging.
   */
  skipUpload?: boolean;
}

const WHAT_TO_TEST_LIMIT = 2000;

export interface BuildTag {
  tag: string;
  message: string;
}

/**
 * The annotated tags that map a run's builds to its commit, for release notes. Play reports only a version code, and
 * `releaseAndroid` finds its tag through `buildOf(code)`, the time-based build of the run. A `githubRun` build number
 * is not that build, so a built Android bundle also gets a tag under the name Play's version code leads back to.
 */
export function buildTags(input: {
  name: string;
  version: string;
  build: string;
  platforms: Platform[];
  /** The version code of an Android bundle this run built. */
  versionCode?: number;
}): BuildTag[] {
  const { name, version, build, platforms, versionCode } = input;
  const tags = [
    { tag: `v${version}-${build}`, message: `${name} ${version} build ${build} (${platforms.join(" + ")})` },
  ];
  if (versionCode === undefined || !platforms.includes("android")) return tags;
  const androidBuild = buildOf(versionCode);
  if (androidBuild !== build)
    tags.push({
      tag: `v${version}-${androidBuild}`,
      message: `${name} ${version} Android version code ${versionCode} (android)`,
    });
  return tags;
}

/** Builds GitHub's main in a clean worktree and sends it to TestFlight and/or Play internal testing. */
export async function beta(config: ShipConfig, options: BetaOptions) {
  const requested = lanesFor(config, options.platform);
  if (options.ref && !options.dry) throw new Error("--ref only works with --dry-run; real builds ship main");
  if (options.skipUpload && requested.some((platform) => platform !== "mac" && platform !== "macAppStore"))
    throw new Error(
      "--skip-upload is for the mac lanes; pass mac or macAppStore, or use --dry-run for ios and android",
    );
  await assertRepoRoot(config.root);
  const unlock = lock(config);
  try {
    await runBeta(config, requested, options);
  } finally {
    unlock();
  }
}

/** The beta without taking the lock, for commands that already hold it. */
export async function runBeta(config: ShipConfig, requested: Platform[], options: BetaOptions) {
  const { dry } = options;
  let platforms = requested;
  const { ios, mac, macAppStore } = config;
  const windowsHere = platforms.includes("windows") && buildsHere();

  let credentials = ios && platforms.includes("ios") ? loadCredentials(config) : undefined;
  let asc = credentials ? new Asc(credentials, dry) : undefined;
  let appId = asc && ios ? (await asc.app(ios.bundleId)).id : undefined;
  // The Mac App Store lane uploads with altool, which reads the key itself; ship only reads the store's versions.
  const storeAsc = macAppStore && platforms.includes("macAppStore") ? new Asc(loadCredentials(config), dry) : undefined;

  // Release what GitHub has. App Store Connect stops taking builds of a version once it is approved, so an
  // iOS or Mac App Store build first moves the version on, and a new version gets builds of every platform.
  await fetchMain(config.root);
  await fetchTags(config.root);
  const pinned = await pinnedRun(config, platforms);
  let version = pinned?.version ?? (await mainVersion(config));
  const stores: { asc: Asc; appId: string; lane: StoreLane }[] = [];
  if (asc && appId) stores.push({ asc, appId, lane: "ios" });
  if (storeAsc && macAppStore)
    stores.push({ asc: storeAsc, appId: (await storeAsc.app(macAppStore.bundleId)).id, lane: "macAppStore" });
  for (const store of stores) {
    const head = await mainVersion(config);
    const opened = await openVersion(config, store.asc, store.appId, dry, store.lane);
    version = opened.version;
    if (opened.bumped) platforms = platformsOf(config);
    // One store moving the version on moves it for every lane, so the other store is not asked to move it again.
    if (opened.version !== head) break;
  }
  // A Mac App Store bump builds every platform, so iOS can join the run here and needs its key and app.
  if (ios && platforms.includes("ios") && !credentials) {
    credentials = loadCredentials(config);
    asc = new Asc(credentials, dry);
    appId = (await asc.app(ios.bundleId)).id;
  }

  // One instant for every build number of this run.
  const now = new Date();
  const build = pinned?.build ?? runBuildNumber(config, now, dry);
  const versionCode = versionCodeFor(now);
  const commit = pinned?.commit ?? (await git(config.root, "rev-parse", options.ref ?? (await mainRef(config.root))));
  log(
    `beta ${config.name} ${version} build ${build}${platforms.includes("android") ? ` (Android ${versionCode})` : ""} from ${commit.slice(0, 7)}${dry ? " [dry run]" : ""}`,
  );

  const persistent = ios?.kind === "expo" && platforms.includes("ios");
  await withWorktree(
    config,
    commit,
    async (worktree) => {
      copyIgnored(config, worktree, [
        ...(platforms.includes("ios") ? (ios?.copy ?? []) : []),
        ...(platforms.includes("android") ? (config.android?.copy ?? []) : []),
        ...(platforms.includes("mac") ? (mac?.copy ?? []) : []),
        ...(platforms.includes("macAppStore") ? (macAppStore?.copy ?? []) : []),
        ...(windowsHere ? (config.windows?.copy ?? []) : []),
      ]);
      // A dry run after a bump builds the version the bump would have pushed.
      const versionFile = join(worktree, config.version.file);
      const text = readFileSync(versionFile, "utf8");
      if (readVersion(config.version, text) !== version)
        writeFileSync(versionFile, writeVersion(config.version, text, version));

      if (
        existsSync(join(worktree, "package.json")) &&
        (ios?.kind === "expo" ||
          config.checks.length ||
          ios?.checks.length ||
          config.android?.checks.length ||
          mac?.checks.length ||
          macAppStore?.checks.length ||
          (windowsHere && config.windows?.checks.length))
      ) {
        await run(
          [
            "bun",
            "install",
            ...(existsSync(join(worktree, "bun.lock")) || existsSync(join(worktree, "bun.lockb"))
              ? ["--frozen-lockfile"]
              : []),
          ],
          { cwd: worktree },
        );
      }
      if (!options.skipChecks) {
        const checks = [
          ...config.checks,
          ...(platforms.includes("ios") ? (ios?.checks ?? []) : []),
          ...(platforms.includes("android") ? (config.android?.checks ?? []) : []),
          ...(platforms.includes("mac") ? (mac?.checks ?? []) : []),
          ...(platforms.includes("macAppStore") ? (macAppStore?.checks ?? []) : []),
          ...(windowsHere ? (config.windows?.checks ?? []) : []),
        ];
        for (const check of checks) {
          log(`== ${check}`);
          await run(["bash", "-c", check], { cwd: worktree });
        }
      }
      if (ios?.preArchive && platforms.includes("ios") && !existsSync(join(worktree, ios.preArchive))) {
        throw new Error(`ios.preArchive ${ios.preArchive} is not in the repository on main`);
      }

      let notes = await notesSince(config, await previousTag(config.root, commit), commit, WHAT_TO_TEST_LIMIT);
      if (notes === GENERIC_NOTES) notes = await subjectOf(config.root, commit);

      const failures: string[] = [];
      let shipped = false;
      let iosUploaded = false;
      let iosBuilt = false;
      let macPublished = false;
      let storeUploaded = false;
      let androidBuilt = false;
      if (platforms.includes("android") && config.android) {
        try {
          const bundle = await buildAndroid({ config, worktree, version, build, versionCode });
          if (dry) log("dry run: skipped uploading the bundle to Play internal testing");
          else if (config.android.playKey) {
            if (!existsSync(resolvePath(config.root, config.android.playKey)))
              throw new Error(`Play key ${config.android.playKey} is missing`);
            await uploadInternal(config, bundle, notes);
          } else log(`android: no playKey in ship.json; upload ${bundle} to Play internal testing by hand`);
          shipped = !dry;
          androidBuilt = true;
        } catch (error) {
          failures.push(`android: ${errorMessage(error)}`);
        }
      }
      if (platforms.includes("ios") && credentials) {
        try {
          const result = await buildIos({ config, worktree, credentials, version, build, dry });
          iosUploaded = result.uploaded;
          iosBuilt = true;
          shipped ||= result.uploaded;
        } catch (error) {
          failures.push(`ios: ${errorMessage(error)}`);
        }
      }
      if (platforms.includes("mac")) {
        try {
          const result = await shipMac({
            config,
            worktree,
            version,
            build,
            dry,
            skipUpload: options.skipUpload ?? false,
          });
          macPublished = result.published;
          shipped ||= result.published;
        } catch (error) {
          failures.push(`mac: ${errorMessage(error)}`);
        }
      }
      if (platforms.includes("macAppStore")) {
        try {
          const result = await shipMacAppStore({
            config,
            worktree,
            version,
            build,
            dry,
            skipUpload: options.skipUpload ?? false,
          });
          storeUploaded = result.uploaded;
          shipped ||= result.uploaded;
        } catch (error) {
          failures.push(`macAppStore: ${errorMessage(error)}`);
        }
      }
      let windowsRelease: WindowsRelease | undefined;
      if (platforms.includes("windows") && config.windows) {
        try {
          windowsRelease = await shipWindows({
            config,
            windows: config.windows,
            worktree,
            version,
            build,
            commit,
            notes,
            dry,
          });
          shipped ||= !dry;
        } catch (error) {
          failures.push(`windows: ${errorMessage(error)}`);
        }
      }

      // The tag maps the build to its commit, for release notes.
      // A tag failure never blocks distribution: the build is already uploaded and testers should get it.
      const tagged = (names: Platform[]) =>
        buildTags({
          name: config.name,
          version,
          build,
          platforms: names,
          versionCode: androidBuilt ? versionCode : undefined,
        });
      const planned = tagged(platforms).map(({ tag }) => tag);
      await write(dry, `tagging ${planned.join(" and ")} and pushing the tags`, async () => {
        // A pinned run's tag belongs to the run that dispatched it.
        if (!shipped || pinned) return;
        const names = platforms.filter((platform) =>
          platform === "ios"
            ? iosUploaded
            : platform === "mac"
              ? macPublished
              : platform === "macAppStore"
                ? storeUploaded
                : platform === "windows"
                  ? Boolean(windowsRelease)
                  : true,
        );
        for (const { tag, message } of tagged(names)) {
          try {
            await tagBuild(config, tag, commit, message);
            log(`tagged ${tag}`);
          } catch (error) {
            warn(`uploaded build ${build} but could not tag ${tag}: ${errorMessage(error)}`);
            failures.push(`tag ${tag}: ${errorMessage(error)}`);
          }
        }
      });

      if (ios && asc && appId && iosBuilt && ios.externalGroups.length) {
        try {
          await distribute({ asc, appId, build, version, whatToTest: notes, groups: ios.externalGroups, dry });
        } catch (error) {
          failures.push(`ios distribution: ${errorMessage(error)}`);
        }
      }

      if (failures.length) throw new Error(failures.join("\n"));
      if (windowsRelease && !pinned) await publishRelease(windowsRelease, dry);
      log(
        dry
          ? `dry run done: ${version} build ${build}, nothing uploaded`
          : options.skipUpload
            ? `built ${version} build ${build}; --skip-upload published and tagged nothing`
            : `released ${version} build ${build}`,
      );
    },
    { persistent },
  );
}
