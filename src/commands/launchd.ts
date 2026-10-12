import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LABEL = "com.frz.shipit.nightly";
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The launchd job runs unattended: it needs the tools a login shell would find, and GitHub access that works
 * without the SSH agent, which can refuse to sign while the Mac is locked. Git rewrites SSH remotes to HTTPS
 * and takes credentials from the gh CLI.
 */
function environment(home: string): Record<string, string> {
  return {
    PATH: `/opt/homebrew/bin:${home}/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_0: "git@github.com:",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "!/opt/homebrew/bin/gh auth git-credential",
  };
}

export function nightlyPlist(home: string): string {
  const cli = join(import.meta.dir, "..", "cli.ts");
  const log = join(home, "Library", "Logs", "shipit-nightly.log");
  const variables = Object.entries(environment(home))
    .map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(cli)}</string>
    <string>nightly</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${variables}
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Writes the 03:00 launchd agent for `ship nightly`. It is never loaded here; the launchctl commands are printed. */
export async function installLaunchd({ dry }: { dry: boolean }) {
  const home = homedir();
  const path = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const plist = nightlyPlist(home);
  if (dry) {
    console.log(`dry run: would write ${path}\n\n${plist}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plist);
    console.log(`wrote ${path}`);
  }
  console.log(`
Load it when you are ready (this command does not):
  launchctl bootstrap gui/$(id -u) ${path}
Run it once now to try it:
  launchctl kickstart -k gui/$(id -u)/${LABEL}
Unload it:
  launchctl bootout gui/$(id -u)/${LABEL}

It replaces the per-app agents. Once every app's ship.json is merged, unload those yourself:
  launchctl bootout gui/$(id -u)/com.frz.nocam.nightly
  launchctl bootout gui/$(id -u)/com.frz.antocam-testflight
Log: ~/Library/Logs/shipit-nightly.log`);
}
