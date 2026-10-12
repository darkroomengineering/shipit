import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Asc } from "../asc.ts";
import { loadConfig, loadCredentials, type ShipConfig } from "../config.ts";
import { errorMessage, log, notify } from "../log.ts";
import { lastUpload } from "../testflight.ts";
import { beta } from "./beta.ts";
import { release } from "./release.ts";

const DAY = 24 * 60 * 60 * 1000;

/** Folder whose subfolders are scanned for ship.json; SHIPIT_PROJECTS overrides it. */
const projectsDir = () => process.env.SHIPIT_PROJECTS ?? join(homedir(), "Developer");

async function keepAlive(config: ShipConfig, dry: boolean): Promise<boolean> {
  const ios = config.ios;
  if (!ios?.keepAlive) return false;
  const days = Number.parseInt(ios.keepAlive, 10);
  const asc = new Asc(loadCredentials(config), true);
  const app = await asc.app(ios.bundleId);
  const uploaded = await lastUpload(asc, app.id);
  const age = uploaded ? Math.floor((Date.now() - uploaded.getTime()) / DAY) : Number.POSITIVE_INFINITY;
  if (age < days) {
    log(`${config.name}: newest usable TestFlight build is ${age}d old, under ${days}d`);
    return false;
  }
  log(
    `${config.name}: newest usable TestFlight build is ${Number.isFinite(age) ? `${age}d` : "missing"}, re-uploading to keep TestFlight alive`,
  );
  if (dry) {
    log(`${config.name}: dry run: skipped the keep-alive beta`);
    return false;
  }
  await beta(config, { platform: "ios", dry: false, skipChecks: false });
  return true;
}

/**
 * Every night: scans the projects folder for ship.json, sends nightly apps to the stores' review, and
 * re-uploads betas that are close to TestFlight's 90-day expiry. One project's failure never stops the rest.
 */
export async function nightly({ dry }: { dry: boolean }) {
  const root = projectsDir();
  const projects = readdirSync(root, { withFileTypes: true })
    .filter((entry) => existsSync(join(root, entry.name, "ship.json")))
    .map((entry) => join(root, entry.name))
    .sort();
  if (!projects.length) return log(`no ship.json under ${root}`);

  const failures: string[] = [];
  for (const dir of projects) {
    let config: ShipConfig;
    try {
      config = loadConfig(dir);
    } catch (error) {
      log(`${dir}: ${errorMessage(error)}`);
      failures.push(dir);
      continue;
    }
    if (!config.nightly && !config.ios?.keepAlive) {
      log(`${config.name}: not a nightly app`);
      continue;
    }
    if (config.nightly) {
      try {
        await release(config, { dry, unattended: true });
      } catch (error) {
        log(`${config.name}: release failed: ${errorMessage(error)}`);
        failures.push(`${config.name} release`);
      }
    }
    try {
      if (await keepAlive(config, dry)) await notify(config.name, "Build re-uploaded to TestFlight");
    } catch (error) {
      log(`${config.name}: keep-alive failed: ${errorMessage(error)}`);
      failures.push(`${config.name} keep-alive`);
    }
  }

  if (failures.length) {
    await notify("ship nightly", `Failed: ${failures.join(", ")}`);
    throw new Error(`failed: ${failures.join(", ")}`);
  }
  log("nightly finished");
}
