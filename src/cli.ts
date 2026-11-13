#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isTarget, loadConfig, PENDING_TARGETS, PLATFORMS, type Target } from "./config.ts";
import { BusyError } from "./git.ts";
import { errorMessage } from "./log.ts";

const USAGE = `ship: one release tool for every native app

  ship beta [ios|android|mac|macAppStore|windows] [--dry-run [--ref R]] [--skip-checks] [--skip-upload]
                                                         build main, upload to TestFlight / Play internal / the Sparkle feed / GitHub
  ship release [ios|android|mac|macAppStore|windows] [--dry-run] [--skip-checks] [--skip-upload]
                                                         run ship beta, then send it to App Review / Play production
  ship promote [mac] [--dry-run] [--build N]             move the newest Mac beta (or build N) to everyone
  ship listing [ios|android] [--dry-run]                 push the store listing on main; never submits for review
  ship version [patch|minor|major] [--dry-run]           print the version, or bump it on main
  ship update "what changed" [--dry-run]                 publish main as an over-the-air EAS update (expo, JS only)
  ship ci [ios|android|mac|macAppStore|windows]          clean origin/main only: run gates, then build every lane (dry run for now)
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
    "skip-upload": { type: "boolean", default: false },
    ref: { type: "string" },
    build: { type: "string" },
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

function platformArg(): Target | undefined {
  const [platform] = rest;
  if (platform === undefined) return undefined;
  if (!isTarget(platform))
    throw new Error(
      `unknown platform "${platform}": use ${PLATFORMS.join(", ")} (${PENDING_TARGETS.join(", ")} have no lane yet)`,
    );
  return platform;
}

async function main() {
  switch (command) {
    case "beta": {
      const { beta } = await import("./commands/beta.ts");
      return beta(loadConfig(root), {
        platform: platformArg(),
        dry,
        skipChecks: values["skip-checks"],
        skipUpload: values["skip-upload"],
        ref: values.ref,
      });
    }
    case "release": {
      const { release } = await import("./commands/release.ts");
      return release(loadConfig(root), {
        platform: platformArg(),
        dry,
        skipChecks: values["skip-checks"],
        skipUpload: values["skip-upload"],
      });
    }
    case "promote": {
      const { promote } = await import("./commands/promote.ts");
      return promote(loadConfig(root), { platform: platformArg(), dry, build: values.build });
    }
    case "listing": {
      const { listing } = await import("./commands/listing.ts");
      return listing(loadConfig(root), { platform: platformArg(), dry });
    }
    case "version": {
      const { versionCommand } = await import("./commands/version.ts");
      return versionCommand(loadConfig(root), { kind: rest[0], dry });
    }
    case "update": {
      const { update } = await import("./commands/update.ts");
      return update(loadConfig(root), {
        message: rest.join(" "),
        dry,
        allowNativeDiff: process.env.SHIP_ALLOW_NATIVE_DIFF === "1",
      });
    }
    case "status": {
      const { status } = await import("./commands/status.ts");
      return status(loadConfig(root));
    }
    case "doctor": {
      const { doctor } = await import("./commands/doctor.ts");
      return doctor(loadConfig(root));
    }
    case "ci": {
      const { ci } = await import("./commands/ci.ts");
      return ci(loadConfig(root), { platform: platformArg() });
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
