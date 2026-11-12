import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildMacApp, commandRunner, identityLine, type Runner } from "./build-mac.ts";
import { DEFAULT_TEAM_ID, type InfoPlistValue, loadCredentials, resolvePath, type ShipConfig, slug } from "./config.ts";
import { errorMessage, log, warn } from "./log.ts";
import { architectureProblem } from "./sparkle.ts";

export interface MacAppStoreBuild {
  config: ShipConfig;
  /** Clean worktree of the commit being built. */
  worktree: string;
  version: string;
  build: string;
  /** Print the plan; run nothing. */
  dry: boolean;
  /** Build, sign, package and validate, then stop before uploading. */
  skipUpload: boolean;
  runner?: Runner;
  /** Where this build's files go. Default ~/Library/Caches/shipit/<app>/appstore-<build>. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MacAppStoreResult {
  /** The package reached App Store Connect and its processing did not fail. */
  uploaded: boolean;
}

/** What altool prints when App Store Connect refuses a package. It can still exit 0, so its output is checked. */
const UPLOAD_FAILURES = ["UPLOAD FAILED", "BUILD-STATUS: FAILED", "IMPORT-STATUS: FAILED", "ERROR ITMS-"];

/** Why altool's output says the package was refused, if it does. */
export function uploadProblem(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => UPLOAD_FAILURES.some((marker) => line.includes(marker)));
  return lines.length ? `App Store Connect refused the package:\n${lines.slice(0, 20).join("\n")}` : undefined;
}

/** `plutil -replace` arguments for one Info.plist entry; it adds the key when it is missing. */
function plistArgs(key: string, value: InfoPlistValue): string[] {
  if (typeof value === "boolean") return [key, "-bool", String(value)];
  if (Array.isArray(value)) return [key, "-json", JSON.stringify(value)];
  return [key, "-string", value];
}

/**
 * The Mac App Store lane, ported from codigo's scripts/appstore.sh: build the app, embed the provisioning profile and
 * privacy manifest, write the Info.plist keys, sign with the Apple Distribution identity and the app's entitlements,
 * check the architectures, wrap it in an installer package signed for the store, validate it, and upload it with the
 * App Store Connect key. The upload lands in TestFlight; `ship release` submits it for review.
 */
export async function shipMacAppStore(input: MacAppStoreBuild): Promise<MacAppStoreResult> {
  const { config, worktree, version, build, dry, skipUpload } = input;
  const store = config.macAppStore;
  if (!store) throw new Error("ship.json has no macAppStore section");
  const env = input.env ?? process.env;
  const r = input.runner ?? commandRunner(dry);
  const dir = input.dir ?? join(homedir(), "Library", "Caches", "shipit", slug(config), `appstore-${build}`);
  const say = (message: string) => log(`macAppStore: ${message}`);
  const stop = (problems: string[]) => {
    if (!problems.length) return;
    if (!dry) throw new Error(problems.join("\n"));
    for (const problem of problems) warn(`dry run: a real run stops here: ${problem}`);
  };
  if (!dry) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  const app = join(dir, store.app);
  const plist = join(app, "Contents", "Info.plist");
  const pkg = join(dir, `${store.app.replace(/\.app$/, "")}-${version}-${build}.pkg`);
  const profile = resolvePath(config.root, store.provisioningProfile);

  // 1. Preflight: the profile, the key and both identities, before anything builds.
  say(`== preflight ${version} (${build})`);
  stop(existsSync(profile) ? [] : [`macAppStore.provisioningProfile: ${profile} does not exist`]);
  const auth = altoolAuth(config, dry);
  const identities = await storeIdentities(r, env);

  // 2. Build unsigned.
  say("== build");
  const project = join(worktree, store.dir);
  if (store.kind === "xcodegen") await r.run(["xcodegen", "generate"], { cwd: project });
  await buildMacApp(r, {
    source: store,
    lane: "macAppStore",
    worktree,
    project,
    dir,
    derived: join(dir, "DerivedData"),
    version,
    build,
    architectures: store.architectures,
    bundle: store.app,
    app,
  });

  // 3. What the store needs inside the app: the profile, the privacy manifest, and the Info.plist keys.
  await r.run(["cp", profile, join(app, "Contents", "embedded.provisionprofile")]);
  if (store.privacyManifest)
    await r.run([
      "cp",
      join(worktree, store.privacyManifest),
      join(app, "Contents", "Resources", "PrivacyInfo.xcprivacy"),
    ]);
  const entries: Record<string, InfoPlistValue> = {
    ...store.infoPlist,
    CFBundleShortVersionString: version,
    CFBundleVersion: build,
  };
  for (const [key, value] of Object.entries(entries))
    await r.run(["plutil", "-replace", ...plistArgs(key, value), plist]);
  await r.run(["plutil", "-lint", plist]);
  let executable = store.app.replace(/\.app$/, "");
  const info = await r.capture(["plutil", "-convert", "json", "-o", "-", plist]);
  if (info !== undefined) {
    const values = JSON.parse(info) as Record<string, unknown>;
    executable = String(values.CFBundleExecutable ?? executable);
    stop(
      values.CFBundleIdentifier === store.bundleId
        ? []
        : [
            `${store.app} has CFBundleIdentifier ${JSON.stringify(values.CFBundleIdentifier)}, expected ${store.bundleId}`,
          ],
    );
  }

  // 4. Sign for the store and check what was signed.
  say("== sign");
  await r.run([
    "codesign",
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--sign",
    identities.app,
    "--entitlements",
    join(worktree, store.entitlements),
    app,
  ]);
  // App Store Connect refuses files with quarantine attributes, which a sandboxed tool leaves on what it writes.
  await r.run(["xattr", "-r", "-d", "com.apple.quarantine", app]).catch(() => undefined);
  await r.run(["codesign", "--verify", "--strict", "--verbose=2", app]);
  const lipo = await r.capture(["lipo", "-archs", join(app, "Contents", "MacOS", executable)]);
  const archProblem =
    lipo === undefined ? undefined : architectureProblem(`Contents/MacOS/${executable}`, lipo, store.architectures);
  stop(archProblem ? [archProblem] : []);

  // 5. The installer package the store takes.
  say("== package");
  await r.run(["productbuild", "--component", app, "/Applications", "--sign", identities.installer, pkg]);
  await r.run(["xattr", "-d", "com.apple.quarantine", pkg]).catch(() => undefined);
  await r.run(["pkgutil", "--check-signature", pkg]);

  // 6. Validate, then upload and wait for App Store Connect to process it.
  say("== upload");
  const altool = async (step: string, args: string[]) => {
    const logFile = join(dir, `${step}.log`);
    await r.run(["xcrun", "altool", ...args, "-t", "macos", ...auth], {
      logFile,
    });
    if (r.dry) return;
    const problem = uploadProblem(readFileSync(logFile, "utf8"));
    if (problem) throw new Error(`${problem}\nfull log at ${logFile}`);
  };
  await altool("validate", ["--validate-app", pkg]);
  if (skipUpload && !dry) {
    say(`--skip-upload: validated ${pkg}; not uploaded`);
    return { uploaded: false };
  }
  say(`uploading ${version} (${build}); this takes minutes`);
  await altool("upload", ["--upload-package", pkg, "--wait"]);
  if (!dry) say(`uploaded ${version} (${build}) to App Store Connect`);
  return { uploaded: !dry };
}

/** altool's App Store Connect key arguments. A dry run without a key prints placeholders. */
function altoolAuth(config: ShipConfig, dry: boolean): string[] {
  try {
    const key = loadCredentials(config);
    return ["--api-key", key.keyId, "--api-issuer", key.issuerId, "--p8-file-path", key.keyPath];
  } catch (error) {
    if (!dry) throw error;
    warn(`dry run: no App Store Connect key for altool: ${errorMessage(error)}`);
    return ["--api-key", "<ASC_KEY_ID>", "--api-issuer", "<ASC_ISSUER_ID>", "--p8-file-path", "<AuthKey.p8>"];
  }
}

const APP_KINDS = ["Apple Distribution", "3rd Party Mac Developer Application"];
const INSTALLER_KINDS = ["3rd Party Mac Developer Installer", "Mac Installer Distribution"];

/**
 * The team's store signing identities, by name, as appstore.sh signs. APP_STORE_IDENTITY and
 * APP_STORE_INSTALLER_IDENTITY override the keychain lookup.
 */
async function storeIdentities(r: Runner, env: NodeJS.ProcessEnv): Promise<{ app: string; installer: string }> {
  const team = env.APPLE_TEAM_ID ?? DEFAULT_TEAM_ID;
  let app = env.APP_STORE_IDENTITY;
  let installer = env.APP_STORE_INSTALLER_IDENTITY;
  if (app && installer) return { app, installer };
  // No -p codesigning: installer certificates are not code-signing identities, and that policy hides them.
  const out = await r.capture(["security", "find-identity", "-v"]);
  const name = (kinds: string[]) => {
    if (out === undefined) return `${kinds[0]} (${team})`;
    return identityLine(out, team, kinds)?.match(/"([^"]+)"/)?.[1];
  };
  app ??= name(APP_KINDS);
  installer ??= name(INSTALLER_KINDS);
  if (!app) throw new Error(`no "${APP_KINDS.join('" or "')}" identity for team ${team} in the keychain`);
  if (!installer) throw new Error(`no "${INSTALLER_KINDS.join('" or "')}" identity for team ${team} in the keychain`);
  return { app, installer };
}
