import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openVersion } from "../appstore.ts";
import { Asc } from "../asc.ts";
import { buildAndroid } from "../build-android.ts";
import { buildIos } from "../build-ios.ts";
import {
  lanesFor,
  loadCredentials,
  type Platform,
  platformsOf,
  resolvePath,
  type ShipConfig,
  type Target,
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
import { buildNumberFor, uploadInternal, versionCodeFor } from "../playlane.ts";
import { distribute } from "../testflight.ts";
import { readVersion, writeVersion } from "../version.ts";

export interface BetaOptions {
  platform?: Target;
  dry: boolean;
  skipChecks: boolean;
  /** Dry runs only: build this ref instead of main, to test a branch before it lands. */
  ref?: string;
}

const WHAT_TO_TEST_LIMIT = 2000;

/** Builds GitHub's main in a clean worktree and sends it to TestFlight and/or Play internal testing. */
export async function beta(config: ShipConfig, options: BetaOptions) {
  const requested = lanesFor(config, options.platform);
  if (options.ref && !options.dry) throw new Error("--ref only works with --dry-run; real builds ship main");
  await assertRepoRoot(config.root);
  const unlock = lock(config);
  try {
    await runBeta(config, requested, options);
  } finally {
    unlock();
  }
}

async function runBeta(config: ShipConfig, requested: Platform[], options: BetaOptions) {
  const { dry } = options;
  let platforms = requested;
  const { ios } = config;

  const credentials = ios && platforms.includes("ios") ? loadCredentials(config) : undefined;
  const asc = credentials ? new Asc(credentials, dry) : undefined;
  const appId = asc && ios ? (await asc.app(ios.bundleId)).id : undefined;

  // Release what GitHub has. App Store Connect stops taking builds of a version once it is approved, so an
  // iOS build first moves the version on, and a new version gets builds of every platform.
  await fetchMain(config.root);
  await fetchTags(config.root);
  let version = await mainVersion(config);
  if (asc && appId) {
    const opened = await openVersion(config, asc, appId, dry);
    version = opened.version;
    if (opened.bumped) platforms = platformsOf(config);
  }

  // One instant for every build number of this run.
  const now = new Date();
  const build = buildNumberFor(now);
  const versionCode = versionCodeFor(now);
  const commit = await git(config.root, "rev-parse", options.ref ?? (await mainRef(config.root)));
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
      ]);
      // A dry run after a bump builds the version the bump would have pushed.
      const versionFile = join(worktree, config.version.file);
      const text = readFileSync(versionFile, "utf8");
      if (readVersion(config.version, text) !== version)
        writeFileSync(versionFile, writeVersion(config.version, text, version));

      if (
        existsSync(join(worktree, "package.json")) &&
        (ios?.kind === "expo" || config.checks.length || ios?.checks.length || config.android?.checks.length)
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

      // The tag maps the build to its commit, for release notes.
      // A tag failure never blocks distribution: the build is already uploaded and testers should get it.
      const tag = `v${version}-${build}`;
      await write(dry, `tagging ${tag} and pushing the tag`, async () => {
        if (!shipped) return;
        const names = platforms.filter((platform) => (platform === "ios" ? iosUploaded : true)).join(" + ");
        try {
          await tagBuild(config, tag, commit, `${config.name} ${version} build ${build} (${names})`);
          log(`tagged ${tag}`);
        } catch (error) {
          warn(`uploaded build ${build} but could not tag ${tag}: ${errorMessage(error)}`);
          failures.push(`tag ${tag}: ${errorMessage(error)}`);
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
      log(
        dry ? `dry run done: ${version} build ${build} built, nothing uploaded` : `released ${version} build ${build}`,
      );
    },
    { persistent },
  );
}
