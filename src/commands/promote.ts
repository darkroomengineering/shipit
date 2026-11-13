import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRunner, download, fetchText, type Runner } from "../build-mac.ts";
import {
  assetNames,
  feedIndex,
  promoteUploads,
  releaseAssets,
  releaseDownload,
  releaseRead,
  windowsPromotion,
} from "../build-windows.ts";
import { type ShipConfig, slug, type Target } from "../config.ts";
import { lock } from "../git.ts";
import { errorMessage, log, run, warn } from "../log.ts";
import { hostFor } from "../mac-host.ts";
import { NothingToPromoteError, promoteAppcast } from "../sparkle.ts";

export interface PromoteOptions {
  platform?: Target;
  /** Print every command; download and upload nothing. */
  dry: boolean;
  /** Promote this build instead of the newest beta. */
  build?: string;
  runner?: Runner;
  /** Where the edited appcast or feed and the stable download go. Default a temporary folder, removed after. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** Reads a URL; undefined when it is not there (404). */
  fetchText?: (url: string) => Promise<string | undefined>;
  download?: (url: string, file: string) => Promise<void>;
  /** Runs a read-only gh command and returns its output; a dry run reads too. */
  ghOutput?: (argv: string[]) => Promise<string>;
}

/** Moves the newest beta build, or `build`, to the channel everyone gets. */
export async function promote(config: ShipConfig, options: PromoteOptions) {
  const platform = options.platform ?? "mac";
  if (platform !== "mac" && platform !== "windows") throw new Error(`no beta channel for ${platform}`);
  const unlock = lock(config);
  try {
    await (platform === "mac" ? runPromote(config, options) : runPromoteWindows(config, options));
  } finally {
    unlock();
  }
}

/**
 * The promote without taking the lock, for commands that already hold it. Edits only the published appcast and the
 * stable download name: the build's archive and signature are already on the hosting, and the feed URL stays.
 */
export async function runPromote(config: ShipConfig, options: PromoteOptions) {
  const mac = config.mac;
  if (!mac) throw new Error("ship.json has no mac section");
  if (!mac.betaChannel)
    throw new Error(
      "mac.betaChannel is off, so every build already goes straight to everyone and there is no beta to promote",
    );
  const { dry } = options;
  const r = options.runner ?? commandRunner(dry);
  const host = hostFor(mac, options.env ?? process.env);
  const say = (message: string) => log(`mac: ${message}`);

  const published = await (options.fetchText ?? fetchText)(mac.feedUrl);
  if (published === undefined) throw new Error(`no appcast at ${mac.feedUrl} yet; ship beta mac publishes the first`);
  const { xml, item } = promoteAppcast(published, options.build);
  const url = item.url ?? "";
  if (!url.startsWith(host.downloadPrefix) || url.slice(host.downloadPrefix.length).includes("/"))
    throw new Error(`build ${item.version} downloads ${url || "nothing"}, which is outside ${host.downloadPrefix}`);
  const version = item.shortVersion ?? item.version;
  say(`promoting ${version} (${item.version}) from beta to everyone`);

  const own = options.dir === undefined;
  const dir =
    options.dir ??
    (dry
      ? join(tmpdir(), `shipit-${slug(config)}-promote-${item.version}`)
      : mkdtempSync(join(tmpdir(), `shipit-${slug(config)}-promote-`)));
  try {
    // Both hosts name an upload by its file name, so the appcast and the alias keep theirs.
    const appcast = join(dir, "appcast.xml");
    const archive = join(dir, url.slice(host.downloadPrefix.length));
    const alias = join(dir, "alias", mac.dmg);
    r.note(`write the appcast with ${item.version} on the default channel to ${appcast}`);
    r.note(`download ${url} to ${archive} and copy it to ${alias}`);
    if (!dry) {
      mkdirSync(join(dir, "alias"), { recursive: true });
      writeFileSync(appcast, xml);
      await (options.download ?? download)(url, archive);
      cpSync(archive, alias);
    }
    for (const command of host.promoteUploads({ appcast, alias })) await r.run(command.argv, { env: command.env });
    if (!dry) say(`promoted ${version} (${item.version}) to everyone`);
  } finally {
    if (own && !dry) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `ship release`'s mac step, under release's lock. An app on the beta channel gets its newest beta promoted; a run
 * that finds nothing newer than what everyone has, such as a quiet night, is not a failure.
 */
export async function releaseMac(config: ShipConfig, options: PromoteOptions & { skipUpload?: boolean }) {
  if (!config.mac?.betaChannel)
    return log("mac: the beta is on the app's only Sparkle feed, so there is nothing to promote");
  if (options.skipUpload) return log("mac: --skip-upload published no beta, so there is nothing to promote");
  try {
    await runPromote(config, options);
  } catch (error) {
    if (error instanceof NothingToPromoteError) return log(`mac: ${error.message}`);
    // A dry run's beta was never published, so the feed it reads is not the one a real run would promote.
    if (options.dry) return warn(`dry run: a real run stops here: ${errorMessage(error)}`);
    throw error;
  }
}

/**
 * The Windows promote without taking the lock. Velopack bakes the channel into each package, so the stable channel
 * gets the build's separate stable pack, staged on the release under per-build names by `ship beta windows`: the
 * staged feed files go up under their stable names, and the versioned installer under the stable installer name.
 * Only gh reads and uploads, so it runs on any OS.
 */
export async function runPromoteWindows(config: ShipConfig, options: PromoteOptions) {
  const windows = config.windows;
  if (!windows) throw new Error("ship.json has no windows section");
  if (!windows.betaChannel)
    throw new Error(
      "windows.betaChannel is off, so every build already goes straight to everyone and there is no beta to promote",
    );
  const { dry } = options;
  const { release, channel } = windows;
  const r = options.runner ?? commandRunner(dry);
  const read = options.ghOutput ?? ((argv: string[]) => run(argv, { capture: true }));
  const say = (message: string) => log(`windows: ${message}`);

  const assets = assetNames(await read(releaseAssets(release)));
  const index = feedIndex(channel);
  const live = assets.includes(index) ? await read(releaseRead(release, index)) : undefined;
  const promotion = windowsPromotion(windows, assets, live, options.build);
  const { build, version } = promotion;
  say(`promoting ${version} (${build}) from beta to everyone`);

  const own = options.dir === undefined;
  const dir =
    options.dir ??
    (dry
      ? join(tmpdir(), `shipit-${slug(config)}-promote-windows-${build}`)
      : mkdtempSync(join(tmpdir(), `shipit-${slug(config)}-promote-windows-`)));
  try {
    const downloads = join(dir, "download");
    const feed = promotion.staged.map(({ name }) => join(dir, name));
    const alias = join(dir, promotion.alias);
    if (!dry) mkdirSync(downloads, { recursive: true });
    await r.run(
      releaseDownload(release, [...promotion.staged.map(({ asset }) => asset), promotion.versioned], downloads),
    );
    r.note(
      `rename ${promotion.staged.map(({ asset, name }) => `${asset} to ${name}`).join(", ")} and copy ${promotion.versioned} to ${promotion.alias}, in ${dir}`,
    );
    if (!dry) {
      for (const { asset, name } of promotion.staged) renameSync(join(downloads, asset), join(dir, name));
      cpSync(join(downloads, promotion.versioned), alias);
    }
    for (const command of promoteUploads(release, channel, alias, feed)) await r.run(command);
    if (!dry) say(`promoted ${version} (${build}) to everyone`);
  } finally {
    if (own && !dry) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `ship release`'s windows step, under release's lock, after the release is public. An app on the beta channel gets
 * its newest staged build promoted; a run that finds nothing newer than what everyone has is not a failure.
 */
export async function releaseWindows(config: ShipConfig, options: PromoteOptions) {
  if (!config.windows?.betaChannel) return;
  try {
    await runPromoteWindows(config, options);
  } catch (error) {
    if (error instanceof NothingToPromoteError) return log(`windows: ${error.message}`);
    // A dry run's beta was never uploaded, so the release it reads is not the one a real run would promote.
    if (options.dry) return warn(`dry run: a real run stops here: ${errorMessage(error)}`);
    throw error;
  }
}
