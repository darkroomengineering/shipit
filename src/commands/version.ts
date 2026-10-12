import type { ShipConfig } from "../config.ts";
import { assertRepoRoot, fetchMain, lock, mainVersion, pushVersion } from "../git.ts";
import { log } from "../log.ts";
import { bump, isBump } from "../version.ts";

/** Prints the version on GitHub's main, or bumps it there with a `chore: start version X` commit. */
export async function versionCommand(config: ShipConfig, options: { kind?: string; dry: boolean }) {
  await assertRepoRoot(config.root);
  await fetchMain(config.root);
  const current = await mainVersion(config);
  if (!options.kind) return console.log(current);
  if (!isBump(options.kind)) throw new Error(`unknown bump "${options.kind}": use patch, minor or major`);
  const next = bump(current, options.kind);
  if (options.dry) return log(`dry run: ${current} -> ${next}; skipped pushing "chore: start version ${next}" to main`);
  const unlock = lock(config);
  try {
    await pushVersion(config, next);
  } finally {
    unlock();
  }
  log(`${current} -> ${next}`);
}
