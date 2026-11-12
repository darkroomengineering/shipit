import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Asc } from "../asc.ts";
import { loadConfig, loadCredentials, type ShipConfig } from "../config.ts";
import { errorMessage, log, notify } from "../log.ts";
import { lastUpload } from "../testflight.ts";
import { beta } from "./beta.ts";
import { release } from "./release.ts";

const DAY = 24 * 60 * 60 * 1000;

/** Folder scanned two levels deep for ship.json; SHIPIT_PROJECTS overrides it. */
const projectsDir = () => process.env.SHIPIT_PROJECTS ?? join(homedir(), "Developer");

const SKIPPED = new Set(["node_modules", ".worktrees"]);

const subfolders = (dir: string) =>
  readdirSync(dir)
    .filter((name) => !name.startsWith(".") && !SKIPPED.has(name))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory());

/**
 * Folders under `root` that hold a ship.json, one or two levels down (`~/Developer/app` and
 * `~/Developer/@darkroom/app`). A folder with a ship.json is a project, so its own subfolders are not searched.
 */
export function findProjects(root: string): string[] {
  const projects: string[] = [];
  for (const dir of subfolders(root)) {
    if (existsSync(join(dir, "ship.json"))) projects.push(dir);
    else {
      let children: string[] = [];
      try {
        children = subfolders(dir);
      } catch (error) {
        log(`${dir}: skipped, ${errorMessage(error)}`);
      }
      projects.push(...children.filter((child) => existsSync(join(child, "ship.json"))));
    }
  }
  return projects.sort();
}

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
  const projects = findProjects(root);
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
