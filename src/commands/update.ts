import { join } from "node:path";
import type { ShipConfig } from "../config.ts";
import { assertRepoRoot, lock } from "../git.ts";
import { log, run, write } from "../log.ts";
import { checkOta, easUpdateCommand, expoDir } from "../ota.ts";

export interface UpdateOptions {
  message: string;
  dry: boolean;
  /** Publish even though native inputs changed since the runtimeVersion commit (SHIP_ALLOW_NATIVE_DIFF=1). */
  allowNativeDiff: boolean;
}

/**
 * Publishes the JS bundle and assets of main as an over-the-air EAS update, only from a clean checkout of
 * GitHub's main and only when nothing native changed since the current runtimeVersion was set. Native changes
 * need a store build (`ship beta`).
 */
export async function update(config: ShipConfig, options: UpdateOptions) {
  const ios = config.ios;
  const settings = ios?.update;
  if (!ios || !settings) throw new Error("ship.json has no ios.update section; ship update publishes expo apps only");
  if (!options.message.trim()) throw new Error('usage: ship update "what changed" [--dry-run]');
  await assertRepoRoot(config.root);
  const unlock = lock(config);
  try {
    const check = await checkOta(config.root, ios, settings, options.allowNativeDiff);
    for (const { guard, refusal } of check.verdicts)
      log(refusal ? `refused: ${guard}: ${refusal.replace(/\n/g, "\n    ")}` : `ok: ${guard}`);
    const short = check.head.slice(0, 7);
    const override = check.overridden.length ? " [native-diff-override]" : "";
    const command = easUpdateCommand(settings, `${options.message.trim()} (${short})${override}`);
    const install = "bun install --frozen-lockfile";
    const publish = `${command.join(" ")} (in ${expoDir(ios)})`;
    const refusals = check.verdicts.filter((verdict) => verdict.refusal);
    if (refusals.length) {
      if (options.dry) log(`dry run: once every guard passes, ship update runs ${install}, then ${publish}`);
      throw new Error(`refusing to publish: ${refusals.map((verdict) => verdict.guard).join("; ")}`);
    }

    log(`publishing ${short} to channel ${settings.channel} (runtime ${check.runtime})`);
    await write(options.dry, install, () =>
      run(["bun", "install", "--frozen-lockfile"], { cwd: config.root, capture: true }),
    );
    await write(options.dry, publish, async () => {
      // An install script, or anything else running meanwhile, can change the tree or move main; check again.
      const again = await checkOta(config.root, ios, settings, options.allowNativeDiff);
      const changed = again.verdicts.filter((verdict) => verdict.refusal).map((verdict) => verdict.guard);
      if (again.head !== check.head) changed.unshift(`HEAD moved from ${short} to ${again.head.slice(0, 7)}`);
      if (changed.length) throw new Error(`refusing to publish: changed during bun install: ${changed.join("; ")}`);
      return run(command, { cwd: join(config.root, expoDir(ios)) });
    });
  } finally {
    unlock();
  }
}
