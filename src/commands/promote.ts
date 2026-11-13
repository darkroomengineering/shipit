import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRunner, download, fetchText, type Runner } from "../build-mac.ts";
import { type ShipConfig, slug, type Target } from "../config.ts";
import { lock } from "../git.ts";
import { errorMessage, log, warn } from "../log.ts";
import { hostFor } from "../mac-host.ts";
import { NothingToPromoteError, promoteAppcast } from "../sparkle.ts";

export interface PromoteOptions {
  platform?: Target;
  /** Print every command; download and upload nothing. */
  dry: boolean;
  /** Promote this build instead of the newest beta. */
  build?: string;
  runner?: Runner;
  /** Where the edited appcast and the stable download go. Default a temporary folder, removed after. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** Reads a URL; undefined when it is not there (404). */
  fetchText?: (url: string) => Promise<string | undefined>;
  download?: (url: string, file: string) => Promise<void>;
}

/** Moves the newest beta build, or `build`, to the channel everyone gets. */
export async function promote(config: ShipConfig, options: PromoteOptions) {
  const platform = options.platform ?? "mac";
  if (platform !== "mac") throw new Error(`no beta channel for ${platform} yet; INC-1003 tracks it`);
  const unlock = lock(config);
  try {
    await runPromote(config, options);
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
