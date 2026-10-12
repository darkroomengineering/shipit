import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AscCredentials, type ShipConfig, slug } from "./config.ts";
import { log, run } from "./log.ts";

export interface IosBuild {
  config: ShipConfig;
  /** Clean worktree of the commit being built. */
  worktree: string;
  credentials: AscCredentials;
  version: string;
  build: string;
  /** Archive and export locally; never upload. */
  dry: boolean;
}

export interface IosBuildResult {
  uploaded: boolean;
  /** Where a dry run left the exported build. */
  exportDir?: string;
}

const LIB = join(import.meta.dir, "..", "lib");

/** Archives, build logs and exports for one run. Logs outlive the worktree. */
function buildDirectory(config: ShipConfig, build: string): string {
  const dir = join(homedir(), "Library", "Caches", "shipit", slug(config), `build-${build}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Deletes the large archive, keeps the logs (and the export of a dry run, which is the point of it). */
function tidy(dir: string, keepExport: boolean) {
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".xcarchive") || (!keepExport && entry.startsWith("export-")))
      rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

export async function buildIos(input: IosBuild): Promise<IosBuildResult> {
  const { config, worktree, version, build, dry } = input;
  const ios = config.ios;
  if (!ios) throw new Error("ship.json has no ios section");
  const dir = buildDirectory(config, build);
  const hook = ios.preArchive ? join(worktree, ios.preArchive) : undefined;
  let failed = true;
  try {
    const exportDir = ios.kind === "expo" ? await buildExpo(input, dir, hook) : await buildXcodegen(input, dir, hook);
    failed = false;
    if (dry) log(`dry run: exported ${version} (${build}) to ${exportDir}; nothing uploaded`);
    return { uploaded: !dry, exportDir: dry ? exportDir : undefined };
  } finally {
    tidy(dir, dry && !failed);
    if (failed) log(`build logs are in ${dir}`);
    else if (!dry) rmSync(dir, { recursive: true, force: true });
  }
}

/** Expo: prebuild, pod install, archive, archive checks, and export or upload, all in the ported shell script. */
async function buildExpo(input: IosBuild, dir: string, hook: string | undefined): Promise<string> {
  const { config, worktree, credentials, version, build, dry } = input;
  const ios = config.ios;
  if (!ios) throw new Error("ship.json has no ios section");
  // The Expo project root is the folder above ios/ (apps/mobile for a monorepo app).
  const projectRoot = join(worktree, ios.dir, "..");
  await run(["bash", join(LIB, "expo-ios.sh")], {
    cwd: projectRoot,
    env: {
      SHIP_ROOT: projectRoot,
      SHIP_SCHEME: ios.scheme,
      SHIP_VERSION: version,
      SHIP_BUILD_NUMBER: build,
      SHIP_BUILD_DIR: dir,
      SHIP_UPLOAD: dry ? "0" : "1",
      SHIP_KEY_FILE: credentials.keyPath,
      ASC_KEY_ID: credentials.keyId,
      ASC_ISSUER_ID: credentials.issuerId,
      APPLE_TEAM_ID: credentials.teamId,
      SHIP_PRE_ARCHIVE: hook,
    },
  });
  return join(dir, `export-${version}-${build}`);
}

const exportOptions = (team: string, destination: "export" | "upload") => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${destination}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>${team}</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
`;

/** Runs xcodebuild into a log file; on failure prints the error lines and where the full log is. */
async function xcodebuild(args: string[], cwd: string, logFile: string, label: string) {
  const proc = Bun.spawn(["xcodebuild", ...args], {
    cwd,
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
    stdin: "ignore",
  });
  if ((await proc.exited) === 0) return;
  const text = await Bun.file(logFile).text();
  const errors = text
    .split("\n")
    .filter((line) => line.includes("error:"))
    .slice(0, 20);
  if (errors.length) console.error(errors.join("\n"));
  throw new Error(`${label} failed; full log at ${logFile}`);
}

/** xcodegen: generate the project, archive with the version and build overrides, then export or upload. */
async function buildXcodegen(input: IosBuild, dir: string, hook: string | undefined): Promise<string> {
  const { config, worktree, credentials, version, build, dry } = input;
  const ios = config.ios;
  if (!ios) throw new Error("ship.json has no ios section");
  const project = join(worktree, ios.dir);
  const xcodegen = Bun.which("xcodegen") ?? "/opt/homebrew/bin/xcodegen";
  log(`== xcodegen generate (${ios.dir})`);
  await run([xcodegen, "generate"], { cwd: project });
  const xcodeproj = readdirSync(project).find((entry) => entry.endsWith(".xcodeproj"));
  if (!xcodeproj) throw new Error(`xcodegen produced no .xcodeproj in ${project}`);

  const auth = [
    "-authenticationKeyPath",
    credentials.keyPath,
    "-authenticationKeyID",
    credentials.keyId,
    "-authenticationKeyIssuerID",
    credentials.issuerId,
  ];
  const archive = join(dir, `${ios.scheme}-${version}-${build}.xcarchive`);
  log(`== archive ${version} (${build})`);
  await xcodebuild(
    [
      "-project",
      xcodeproj,
      "-scheme",
      ios.scheme,
      "-destination",
      "generic/platform=iOS",
      "archive",
      "-archivePath",
      archive,
      `MARKETING_VERSION=${version}`,
      `CURRENT_PROJECT_VERSION=${build}`,
      "-allowProvisioningUpdates",
      ...auth,
    ],
    project,
    join(dir, "archive.log"),
    "archive",
  );

  if (hook) {
    log("== preArchive hook");
    await run([hook], {
      cwd: worktree,
      env: { SHIP_ARCHIVE: archive, SHIP_VERSION: version, SHIP_BUILD_NUMBER: build },
    });
  }

  const destination = dry ? "export" : "upload";
  const options = join(dir, "export-options.plist");
  writeFileSync(options, exportOptions(credentials.teamId, destination));
  const exportDir = join(dir, `export-${version}-${build}`);
  log(`== ${destination}`);
  await xcodebuild(
    [
      "-exportArchive",
      "-archivePath",
      archive,
      "-exportOptionsPlist",
      options,
      "-exportPath",
      exportDir,
      "-allowProvisioningUpdates",
      ...auth,
    ],
    project,
    join(dir, "export.log"),
    destination,
  );
  return exportDir;
}
