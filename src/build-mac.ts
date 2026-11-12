import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_TEAM_ID, loadCredentials, type MacDirectConfig, type ShipConfig, slug } from "./config.ts";
import { errorMessage, log, run, warn } from "./log.ts";
import { hostFor } from "./mac-host.ts";
import {
  appcastProblems,
  architectureProblem,
  changelogSection,
  enclosureName,
  entitlementProblems,
  keyProblem,
  newestArchives,
  padBase64,
  preflightProblems,
  publicKeyFromPrivate,
  type SignedCode,
} from "./sparkle.ts";

export interface StepOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Send the output to this file instead of the terminal; a failure prints its error lines. */
  logFile?: string;
}

/** Runs the lane's commands, or in a dry run prints each one and runs none. */
export interface Runner {
  readonly dry: boolean;
  run(argv: string[], options?: StepOptions): Promise<void>;
  /** A command run for its output. A dry run prints it and returns undefined, so checks on the output are skipped. */
  capture(argv: string[], options?: StepOptions): Promise<string | undefined>;
  /** A step that is not a command, such as a file write or a download. Only a dry run prints it. */
  note(what: string): void;
}

const SAFE = /^[\w@%+=:,./-]+$/;
const quote = (arg: string) => (SAFE.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

/** A command as a shell line, with its environment and folder, for logs and dry-run plans. */
export function shellLine(argv: string[], options: StepOptions = {}): string {
  const env = Object.entries(options.env ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${quote(value as string)} `)
    .join("");
  const cwd = options.cwd ? `(cd ${quote(options.cwd)} && ` : "";
  const out = options.logFile ? ` > ${quote(options.logFile)} 2>&1` : "";
  return `${cwd}${env}${argv.map(quote).join(" ")}${out}${cwd ? ")" : ""}`;
}

async function runToFile(argv: string[], options: StepOptions & { logFile: string }) {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: Bun.file(options.logFile),
    stderr: Bun.file(options.logFile),
    stdin: "ignore",
  });
  if ((await proc.exited) === 0) return;
  const errors = (await Bun.file(options.logFile).text())
    .split("\n")
    .filter((line) => line.includes("error:"))
    .slice(0, 20);
  if (errors.length) console.error(errors.join("\n"));
  throw new Error(`${basename(argv[0] ?? "")} failed; full log at ${options.logFile}`);
}

export function commandRunner(dry: boolean, print: (line: string) => void = log): Runner {
  return {
    dry,
    async run(argv, options = {}) {
      if (dry) return print(`dry run: would run ${shellLine(argv, options)}`);
      print(`$ ${shellLine(argv, options)}`);
      if (options.logFile) await runToFile(argv, { ...options, logFile: options.logFile });
      else await run(argv, options);
    },
    async capture(argv, options = {}) {
      if (dry) {
        print(`dry run: would run ${shellLine(argv, options)}`);
        return undefined;
      }
      return run(argv, { ...options, capture: true });
    },
    note(what) {
      if (dry) print(`dry run: would ${what}`);
    },
  };
}

export interface MacBuild {
  config: ShipConfig;
  /** Clean worktree of the commit being built. */
  worktree: string;
  version: string;
  build: string;
  /** Print the plan; run nothing and read nothing remote except the public feed. */
  dry: boolean;
  /** Build, sign, notarize and write the appcast, then stop before uploading. */
  skipUpload: boolean;
  runner?: Runner;
  /** Where this build's files go. Default ~/Library/Caches/shipit/<app>/mac-<build>. */
  dir?: string;
  /** Where every generated appcast is kept as appcast-<build>.xml. Default ~/Library/Caches/shipit/<app>/appcasts. */
  history?: string;
  env?: NodeJS.ProcessEnv;
  /** Reads a URL; undefined when it is not there (404). */
  fetchText?: (url: string) => Promise<string | undefined>;
  download?: (url: string, file: string) => Promise<void>;
}

export interface MacResult {
  /** The archives, appcast and alias were uploaded. */
  published: boolean;
}

async function fetchText(url: string): Promise<string | undefined> {
  const response = await fetch(url, { redirect: "follow" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function download(url: string, file: string) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  await Bun.write(file, response);
}

/** browsee's Developer ID lookup: the first "Developer ID Application" identity of the team in `security` output. */
export function developerIdentity(output: string, team: string): string | undefined {
  const line = output
    .split("\n")
    .find((row) => row.includes('"Developer ID Application: ') && row.includes(`(${team})`));
  return line?.trim().split(/\s+/)[1];
}

const SPARKLE = "Contents/Frameworks/Sparkle.framework";
/** Sparkle's nested code, deepest first. The XPC services keep the entitlements Sparkle ships them with. */
const SPARKLE_PARTS = [
  { path: `${SPARKLE}/Versions/B/XPCServices/Downloader.xpc`, preserve: true },
  { path: `${SPARKLE}/Versions/B/XPCServices/Installer.xpc`, preserve: true },
  { path: `${SPARKLE}/Versions/B/Autoupdate`, preserve: false },
  { path: `${SPARKLE}/Versions/B/Updater.app`, preserve: false },
  { path: SPARKLE, preserve: false },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Mac direct-download lane: preflight, archive with the version and build, sign inside-out, verify, notarize and
 * staple the app, make and notarize the DMG, write the Sparkle appcast, and upload archives first and the appcast
 * last. Tagging is the caller's, as for the other lanes.
 */
export async function shipMac(input: MacBuild): Promise<MacResult> {
  const { config, worktree, version, build, dry, skipUpload } = input;
  const mac = config.mac;
  if (!mac) throw new Error("ship.json has no mac section");
  const env = input.env ?? process.env;
  const r = input.runner ?? commandRunner(dry);
  const read = input.fetchText ?? fetchText;
  const cache = join(homedir(), "Library", "Caches", "shipit", slug(config));
  const dir = input.dir ?? join(cache, `mac-${build}`);
  const history = input.history ?? join(cache, "appcasts");
  const host = hostFor(mac, env);
  const say = (message: string) => log(`mac: ${message}`);
  const stop = (problems: string[]) => {
    if (!problems.length) return;
    if (!dry) throw new Error(problems.join("\n"));
    for (const problem of problems) warn(`dry run: a real run stops here: ${problem}`);
  };
  if (!dry) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  const project = join(worktree, mac.dir);
  const derived = join(dir, "DerivedData");
  const archive = join(dir, `${mac.scheme}-${version}-${build}.xcarchive`);
  const app = join(dir, mac.app);
  const staging = join(dir, "updates");
  const enclosure = enclosureName(mac.dmg, build);
  const dmg = join(staging, enclosure);
  const sparkleBin = env.SPARKLE_BIN ?? join(derived, "SourcePackages", "artifacts", "sparkle", "Sparkle", "bin");
  const ciKey = env.SPARKLE_PRIVATE_KEY;

  // 1. Preflight. The commit is main's head in a clean worktree (see runBeta), so tree and branch need no check here.
  say(`== preflight ${version} (${build})`);
  const changelogFile = config.changelog ?? "CHANGELOG.md";
  const changelogPath = join(worktree, changelogFile);
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : undefined;
  let published: string | undefined;
  try {
    published = await read(mac.feedUrl);
    say(
      published === undefined ? `no appcast at ${mac.feedUrl} yet; this is the first release` : `read ${mac.feedUrl}`,
    );
  } catch (error) {
    if (!dry) throw error;
    warn(`dry run: could not read ${mac.feedUrl}, so the build number is unchecked: ${errorMessage(error)}`);
  }
  const problems = preflightProblems({
    version,
    build,
    changelog,
    changelogFile,
    published,
    signingKey: ciKey ? publicKeyFromPrivate(ciKey) : undefined,
    publicKey: mac.publicKey,
  });
  for (const check of host.checks()) {
    const out = await r.capture(check.argv, { env: check.env });
    const problem = out === undefined ? undefined : check.problem(out);
    if (problem) problems.push(problem);
  }
  stop(problems);

  // 2. Stamp the version and build, and archive unsigned; ship signs below.
  if (mac.kind === "xcodegen") await r.run(["xcodegen", "generate"], { cwd: project });
  const xcodebuild = ["xcodebuild", "-scheme", mac.scheme, "-configuration", "Release", "-derivedDataPath", derived];
  await r.run([...xcodebuild, "-resolvePackageDependencies"], { cwd: project, logFile: join(dir, "resolve.log") });
  if (!ciKey) {
    // Asks whether the item exists without reading the secret, so it raises no keychain prompt. generate_keys
    // must never run without a key: without -p it creates one.
    const lookup = ["security", "find-generic-password", "-s", "https://sparkle-project.org", "-a", mac.sparkleAccount];
    const found = await r.capture(lookup).then(
      () => true,
      () => false,
    );
    if (!found)
      stop([
        `no Sparkle private key for keychain account ${mac.sparkleAccount}; set mac.sparkleAccount, or pass the key in SPARKLE_PRIVATE_KEY`,
      ]);
    else {
      // The keychain key is only readable once the package graph has Sparkle's tools.
      const key = await r.capture([join(sparkleBin, "generate_keys"), "--account", mac.sparkleAccount, "-p"]);
      const problem = key === undefined ? undefined : keyProblem(key.trim(), mac.publicKey);
      stop(problem ? [problem] : []);
    }
  }
  await r.run(
    [
      ...xcodebuild,
      "-destination",
      "generic/platform=macOS",
      "-archivePath",
      archive,
      "archive",
      `MARKETING_VERSION=${version}`,
      `CURRENT_PROJECT_VERSION=${build}`,
      `ARCHS=${mac.architectures.join(" ")}`,
      "ONLY_ACTIVE_ARCH=NO",
      "CODE_SIGNING_ALLOWED=NO",
    ],
    { cwd: project, logFile: join(dir, "archive.log") },
  );
  await r.run(["ditto", join(archive, "Products", "Applications", mac.app), app]);
  const plist = join(app, "Contents", "Info.plist");
  // Installed copies only follow this feed and trust this key, so the app carries ship.json's, whatever it was built with.
  await r.run([
    "/usr/libexec/PlistBuddy",
    "-c",
    `Set :SUFeedURL ${mac.feedUrl}`,
    "-c",
    `Set :SUPublicEDKey ${mac.publicKey}`,
    plist,
  ]);
  let executable = mac.app.replace(/\.app$/, "");
  let signedFeed = false;
  const info = await r.capture(["plutil", "-convert", "json", "-o", "-", plist]);
  if (info !== undefined) {
    const values = JSON.parse(info) as Record<string, unknown>;
    executable = String(values.CFBundleExecutable ?? executable);
    signedFeed = values.SURequireSignedFeed === true;
    const expected: Record<string, string> = {
      CFBundleIdentifier: mac.bundleId,
      CFBundleShortVersionString: version,
      CFBundleVersion: build,
      SUFeedURL: mac.feedUrl,
      SUPublicEDKey: mac.publicKey,
    };
    stop(
      Object.entries(expected)
        .filter(([key, value]) => values[key] !== value)
        .map(([key, value]) => `${mac.app} has ${key} ${JSON.stringify(values[key])}, expected ${value}`),
    );
  }

  // 3. Sign inside-out with the hardened runtime and a timestamp. Never --deep: it would copy the app's
  // entitlements onto every helper.
  const identity = await signingIdentity(r, env);
  const codesign = (...args: string[]) => [
    "codesign",
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--sign",
    identity,
    ...args,
  ];
  say("== sign");
  if (!dry && !existsSync(join(app, SPARKLE)))
    throw new Error(`${mac.app} has no ${SPARKLE}; the mac lane ships Sparkle apps`);
  for (const part of SPARKLE_PARTS) {
    if (!dry && !existsSync(join(app, part.path))) continue;
    await r.run(codesign(...(part.preserve ? ["--preserve-metadata=entitlements"] : []), join(app, part.path)));
  }
  const nested = expand(mac, app, dry);
  for (const { path, pattern } of nested) {
    const file = mac.helperEntitlements[pattern];
    await r.run(codesign(...(file ? ["--entitlements", join(worktree, file)] : []), join(app, path)));
  }
  await r.run(codesign(...(mac.entitlements ? ["--entitlements", join(worktree, mac.entitlements)] : []), app));
  await r.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);

  // 4. Verify entitlements and architectures before anything leaves the machine.
  say("== verify");
  const entitlements = (path: string) => r.capture(["codesign", "-d", "--entitlements", ":-", path]);
  const appEntitlements = await entitlements(app);
  const nestedCode: SignedCode[] = [];
  // Sparkle's parts keep the entitlements Sparkle ships them with, which may be anything but a forbidden key.
  for (const part of SPARKLE_PARTS) {
    if (!dry && !existsSync(join(app, part.path))) continue;
    const text = await entitlements(join(app, part.path));
    if (text !== undefined) nestedCode.push({ path: part.path, entitlements: text, ownEntitlements: true });
  }
  for (const { path, pattern } of nested) {
    const text = await entitlements(join(app, path));
    if (text !== undefined)
      nestedCode.push({ path, entitlements: text, ownEntitlements: pattern in mac.helperEntitlements });
  }
  const verifyProblems =
    appEntitlements === undefined
      ? []
      : entitlementProblems({ path: mac.app, entitlements: appEntitlements, ownEntitlements: true }, nestedCode, {
          required: mac.requiredEntitlements,
          forbidden: mac.forbiddenEntitlements,
        });
  for (const binary of [`Contents/MacOS/${executable}`, ...mac.binaries]) {
    const lipo = await r.capture(["lipo", "-archs", join(app, binary)]);
    const problem = lipo === undefined ? undefined : architectureProblem(binary, lipo, mac.architectures);
    if (problem) verifyProblems.push(problem);
  }
  stop(verifyProblems);

  // 5. Notarize and staple the app, so a copy dragged out of the DMG launches offline too.
  const auth = notaryAuth(mac, config, env, dry);
  const zip = join(dir, `${executable}-notary.zip`);
  await r.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  await notarize(r, zip, auth);
  await staple(r, app);
  await r.run(["spctl", "-a", "-vv", "--type", "execute", app]);

  // 6. The DMG: the stapled app and an Applications link, signed, notarized and stapled.
  say("== dmg");
  const root = join(dir, "dmg");
  await r.run(["mkdir", "-p", root, staging]);
  await r.run(["ditto", app, join(root, mac.app)]);
  await r.run(["ln", "-s", "/Applications", join(root, "Applications")]);
  await r.run(["hdiutil", "create", "-volname", executable, "-srcfolder", root, "-format", "UDZO", "-ov", dmg]);
  await r.run(["codesign", "--force", "--timestamp", "--sign", identity, dmg]);
  await r.run(["codesign", "--verify", "--strict", dmg]);
  await notarize(r, dmg, auth);
  await staple(r, dmg);
  await r.run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmg]);

  // 7. The appcast extends the published one. generate_appcast makes deltas from the previous archives, embeds the
  // CHANGELOG section, signs the archive and, when the app requires it, the whole feed. Nothing may edit it after.
  say("== appcast");
  const fetched = new Set<string>();
  if (published !== undefined) {
    r.note(`write the published appcast to ${join(staging, "appcast.xml")}`);
    if (!dry) writeFileSync(join(staging, "appcast.xml"), published);
    for (const url of newestArchives(published, mac.deltas)) {
      if (!url.startsWith(host.downloadPrefix) || url.slice(host.downloadPrefix.length).includes("/"))
        throw new Error(`the published appcast has an archive outside ${host.downloadPrefix}: ${url}`);
      const name = url.slice(host.downloadPrefix.length);
      r.note(`download ${url} to ${join(staging, name)} for deltas`);
      if (!dry) await (input.download ?? download)(url, join(staging, name));
      fetched.add(name);
    }
  }
  const notes = join(staging, enclosure.replace(/\.dmg$/, ".md"));
  r.note(`write ${notes} from the ${version} section of ${changelogFile}`);
  if (!dry) writeFileSync(notes, `${changelogSection(changelog ?? "", version) ?? ""}\n`);
  const keyFile = join(dir, "sparkle-private-key");
  if (ciKey) {
    r.note(`write SPARKLE_PRIVATE_KEY to ${keyFile} (mode 600)`);
    if (!dry) {
      // Programa's CI stores the key without base64 padding, which generate_appcast does not read.
      writeFileSync(keyFile, padBase64(ciKey), { mode: 0o600 });
      chmodSync(keyFile, 0o600);
    }
  }
  try {
    await r.run([
      join(sparkleBin, "generate_appcast"),
      ...(ciKey ? ["--ed-key-file", keyFile] : ["--account", mac.sparkleAccount]),
      "--download-url-prefix",
      host.downloadPrefix,
      "--maximum-deltas",
      String(mac.deltas),
      "--embed-release-notes",
      staging,
    ]);
  } finally {
    if (ciKey && !dry) rmSync(keyFile, { force: true });
  }
  const appcast = join(staging, "appcast.xml");
  if (!dry) {
    stop(
      appcastProblems(readFileSync(appcast, "utf8"), {
        build,
        version,
        url: `${host.downloadPrefix}${enclosure}`,
        signedFeed,
      }),
    );
  }
  const historyCopy = join(dir, `appcast-${build}.xml`);
  r.note(`keep the appcast as ${historyCopy} and ${join(history, `appcast-${build}.xml`)}`);
  if (!dry) {
    cpSync(appcast, historyCopy);
    mkdirSync(history, { recursive: true });
    cpSync(appcast, join(history, `appcast-${build}.xml`));
  }
  const alias = join(dir, "alias", mac.dmg);
  r.note(`copy ${dmg} to ${alias}`);
  if (!dry) {
    mkdirSync(join(dir, "alias"), { recursive: true });
    cpSync(dmg, alias);
  }

  // 8. Upload: archives first, the appcast last, then the stable download name.
  const deltas = dry ? [] : readdirSync(staging).filter((name) => name.endsWith(".delta") && !fetched.has(name));
  const uploads = host.uploads({
    build,
    archives: [dmg, ...deltas.map((name) => join(staging, name))],
    history: historyCopy,
    appcast,
    alias,
  });
  say("== upload");
  if (dry) r.note("upload, along with any .delta files generate_appcast made:");
  if (skipUpload && !dry) {
    say(`--skip-upload: ${dmg} and ${appcast} are ready; a release would run:`);
    for (const command of uploads) log(`  ${shellLine(command.argv, { env: command.env })}`);
    return { published: false };
  }
  for (const command of uploads) await r.run(command.argv, { env: command.env });
  if (!dry) say(`published ${version} (${build}) to ${mac.feedUrl}`);
  return { published: !dry };
}

/** The nested code listed in `mac.sign`, with `*` patterns expanded against the built app. A dry run lists patterns. */
function expand(mac: MacDirectConfig, app: string, dry: boolean): { path: string; pattern: string }[] {
  return mac.sign.flatMap((pattern) => {
    if (dry || !pattern.includes("*")) {
      if (!dry && !existsSync(join(app, pattern))) throw new Error(`mac.sign: ${pattern} is not in ${mac.app}`);
      return [{ path: pattern, pattern }];
    }
    const paths = [...new Bun.Glob(pattern).scanSync({ cwd: app, onlyFiles: false })].sort();
    if (!paths.length) throw new Error(`mac.sign: ${pattern} matches nothing in ${mac.app}`);
    return paths.map((path) => ({ path, pattern }));
  });
}

async function signingIdentity(r: Runner, env: NodeJS.ProcessEnv): Promise<string> {
  if (env.SIGN_IDENTITY) return env.SIGN_IDENTITY;
  const team = env.APPLE_TEAM_ID ?? DEFAULT_TEAM_ID;
  const out = await r.capture(["security", "find-identity", "-v", "-p", "codesigning"]);
  if (out === undefined) return `Developer ID Application (${team})`;
  const identity = developerIdentity(out, team);
  if (!identity) throw new Error(`no "Developer ID Application" identity for team ${team} in the keychain`);
  return identity;
}

/** notarytool's credentials: the keychain profile on a Mac, the App Store Connect key in CI or without a profile. */
function notaryAuth(mac: MacDirectConfig, config: ShipConfig, env: NodeJS.ProcessEnv, dry: boolean): string[] {
  if (mac.notaryProfile && !env.CI) return ["--keychain-profile", mac.notaryProfile];
  try {
    const key = loadCredentials(config);
    return ["--key", key.keyPath, "--key-id", key.keyId, "--issuer", key.issuerId];
  } catch (error) {
    if (!dry) throw error;
    warn(`dry run: no App Store Connect key for notarytool: ${errorMessage(error)}`);
    return ["--key", "<AuthKey.p8>", "--key-id", "<ASC_KEY_ID>", "--issuer", "<ASC_ISSUER_ID>"];
  }
}

async function notarize(r: Runner, file: string, auth: string[]) {
  log(`mac: notarizing ${basename(file)}; this takes minutes`);
  const out = await r.capture(["xcrun", "notarytool", "submit", file, ...auth, "--wait", "--output-format", "json"]);
  if (out === undefined) return;
  const result = JSON.parse(out) as { id?: string; status?: string };
  if (result.status === "Accepted") return log(`mac: notarized ${basename(file)} (submission ${result.id})`);
  if (result.id) await r.run(["xcrun", "notarytool", "log", result.id, ...auth]).catch(() => undefined);
  throw new Error(
    `notarization of ${basename(file)} ended ${result.status ?? "with no status"} (submission ${result.id})`,
  );
}

/** Staples and validates. Apple's ticket service drops connections often enough that Programa retries five times. */
async function staple(r: Runner, file: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await r.run(["xcrun", "stapler", "staple", file]);
      await r.run(["xcrun", "stapler", "validate", file]);
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      warn(`stapling ${basename(file)} failed (attempt ${attempt}); retrying`);
      await sleep(attempt * 15_000);
    }
  }
}
