import { lanesFor, type ShipConfig, type Target } from "../config.ts";
import { assertCurrentMain, assertRepoRoot, git, hasRemote } from "../git.ts";
import { log, run } from "../log.ts";
import { beta } from "./beta.ts";

/**
 * Releases from a clean checkout of GitHub's current main: records its commit, runs the gates, builds every
 * lane from that commit, and checks main has not moved before publishing. Publishing is not wired yet, so the
 * lanes run as dry runs.
 */
export async function ci(config: ShipConfig, options: { platform?: Target }) {
  const { root } = config;
  lanesFor(config, options.platform);
  await assertRepoRoot(root);
  if (!(await hasRemote(root))) throw new Error("ship ci releases GitHub's main, and this repository has no origin");
  const dirty = await git(root, "status", "--porcelain");
  if (dirty) throw new Error(`the checkout has uncommitted or untracked files:\n${dirty}`);
  const sha = await git(root, "rev-parse", "HEAD");
  await assertCurrentMain(root, sha);
  log(`ci ${config.name} at ${sha}`);

  for (const gate of config.gates) {
    log(`== ${gate}`);
    await run(["bash", "-c", gate], { cwd: root });
  }
  await beta(config, { platform: options.platform, dry: true, skipChecks: false, ref: sha });

  await assertCurrentMain(root, sha);
  log(`${sha.slice(0, 7)} is still main; publishing is not wired into ship ci yet, so nothing was released`);
}
