#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, type Platform } from "./config.ts";
import { BusyError } from "./git.ts";
import { errorMessage } from "./log.ts";

const USAGE = `ship: one release tool for every native app

  ship beta [ios|android] [--dry-run] [--skip-checks]   build main, upload to TestFlight / Play internal
  ship release [ios|android] [--dry-run]                 send the newest beta to App Review / Play production
  ship version [patch|minor|major] [--dry-run]           print the version, or bump it on main
  ship nightly [--dry-run]                               release every nightly app and keep betas alive
  ship status                                            latest builds and store states
  ship doctor                                            check tools, credentials and the app record
  ship install-launchd [--dry-run]                       write the 03:00 launchd agent for ship nightly

Run inside an app folder (the one with ship.json) or pass -C <path>.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    "skip-checks": { type: "boolean", default: false },
    C: { type: "string", short: "C" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, ...rest] = positionals;
if (!command || values.help || command === "help") {
  console.log(USAGE);
  process.exit(command || values.help ? 0 : 1);
}

const dry = values["dry-run"];
const root = resolve(values.C ?? process.cwd());

function platformArg(): Platform | undefined {
  const [platform] = rest;
  if (platform === undefined) return undefined;
  if (platform !== "ios" && platform !== "android")
    throw new Error(`unknown platform "${platform}": use ios or android`);
  return platform;
}

async function main() {
  switch (command) {
    case "beta": {
      const { beta } = await import("./commands/beta.ts");
      return beta(loadConfig(root), { platform: platformArg(), dry, skipChecks: values["skip-checks"] });
    }
    case "release": {
      const { release } = await import("./commands/release.ts");
      return release(loadConfig(root), { platform: platformArg(), dry });
    }
    case "version": {
      const { versionCommand } = await import("./commands/version.ts");
      return versionCommand(loadConfig(root), { kind: rest[0], dry });
    }
    case "status": {
      const { status } = await import("./commands/status.ts");
      return status(loadConfig(root));
    }
    case "doctor": {
      const { doctor } = await import("./commands/doctor.ts");
      return doctor(loadConfig(root));
    }
    case "nightly": {
      const { nightly } = await import("./commands/nightly.ts");
      return nightly({ dry });
    }
    case "install-launchd": {
      const { installLaunchd } = await import("./commands/launchd.ts");
      return installLaunchd({ dry });
    }
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`ship ${command}: ${errorMessage(error)}`);
  process.exit(error instanceof BusyError ? 75 : 1);
});
