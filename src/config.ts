import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_TEAM_ID = "ZNHHMX2RP6";
export const DEFAULT_CREDENTIALS = "~/.config/shipit/asc.env";

export interface VersionSpec {
  file: string;
  /** Dotted path into a JSON file, such as `expo.version`. */
  json?: string;
  /** Dotted path into a YAML file; the last segment is matched by name on every line that carries it. */
  yaml?: string;
  /** Pattern whose first capture group is the version; a bump rewrites every match. */
  regex?: string;
}

export interface IosConfig {
  kind: "expo" | "xcodegen";
  dir: string;
  scheme: string;
  bundleId: string;
  externalGroups: string[];
  copy: string[];
  checks: string[];
  preArchive: string | null;
  keepAlive: string | null;
  listing: string | null;
  /** How `listing` is laid out: nocam's JSON file, or a fastlane metadata folder. */
  listingFormat: "json" | "fastlane";
  /** `ship update`: over-the-air publishing for expo apps. */
  update: UpdateConfig | null;
}

export interface UpdateConfig {
  channel: string;
  /** The EAS environment whose variables the bundle gets (`eas update --environment`). */
  environment: string | null;
  /** The pinned eas-cli that publishes, run through bunx, such as `eas-cli@23.1.0`. */
  easCli: string;
  /** Repo-relative git pathspecs that change the binary; any change since the runtimeVersion commit refuses. */
  nativeInputs: string[];
  /** A variable every `.env*` file in the expo project must leave unset or set to `value`. */
  envCheck: { key: string; value: string } | null;
}

export interface AndroidConfig {
  dir: string;
  package: string;
  versionCodeProperty: string;
  playKey: string | null;
  copy: string[];
  checks: string[];
}

/** A file that carries the version besides `version.file`: plain text, a JSON or YAML path, or a regex. */
export type VersionFileSpec = VersionSpec;

/** Fields every target without a lane accepts until its lane defines more. */
export interface TargetConfig {
  dir: string;
  copy: string[];
  checks: string[];
}

/** A Mac app built with Xcode: `mac` is signed and notarized for direct download, `macAppStore` goes to the store. */
export interface MacConfig extends TargetConfig {
  scheme: string;
  bundleId: string;
}

/** Sparkle archives on one GitHub release, such as Programa's `rolling` release. */
export interface GithubHosting {
  type: "github";
  /** `owner/name` of the repository whose release holds the archives. */
  repo: string;
  tag: string;
}

/** Sparkle archives in an R2 bucket served at the feed URL's folder, such as browsee's updates.browsee.app. */
export interface R2Hosting {
  type: "r2";
  bucket: string;
  /** Cloudflare account id; the S3 endpoint is https://<accountId>.r2.cloudflarestorage.com. */
  accountId: string;
  /** aws CLI profile with the bucket keys; AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment win. */
  profile: string | null;
}

export type MacHosting = GithubHosting | R2Hosting;

/** The direct-download lane: Developer ID signing, notarization, a DMG and a Sparkle feed. */
export interface MacDirectConfig extends MacConfig {
  /** `xcodegen` runs `xcodegen generate` in `dir` before building. */
  kind: "xcodeproj" | "xcodegen";
  /** The built bundle's name, such as `Programa.app`. */
  app: string;
  architectures: string[];
  /** The app's SUFeedURL. Installed copies read it, so ship never changes it. */
  feedUrl: string;
  /** The app's SUPublicEDKey. Installed copies trust only this key, so ship never changes it. */
  publicKey: string;
  /** Keychain account of the Sparkle EdDSA private key. CI passes the key in SPARKLE_PRIVATE_KEY instead. */
  sparkleAccount: string;
  /** Repo-relative entitlements file for the app itself. */
  entitlements: string | null;
  /** App-relative nested code signed before the app, deepest first; `*` matches within one path segment. */
  sign: string[];
  /** Entitlements files for entries of `sign`, keyed by the same app-relative path. */
  helperEntitlements: Record<string, string>;
  /** Entitlements the app must carry and nested code without its own entitlements must not. */
  requiredEntitlements: string[];
  /** Entitlements nothing in the app may carry. */
  forbiddenEntitlements: string[];
  /** App-relative Mach-O files that must hold exactly `architectures`, besides the main executable. */
  binaries: string[];
  /** notarytool keychain profile for local runs. Without one, and always in CI, the App Store Connect key is used. */
  notaryProfile: string | null;
  /** How many previous releases generate_appcast makes delta updates from. */
  deltas: number;
  /** Stable download name that always holds the newest DMG. Each build is also published as `<base>-<build>.dmg`. */
  dmg: string;
  hosting: MacHosting;
}

/** Azure Artifact Signing (formerly Trusted Signing). The runner signs in with azure/login over OIDC first. */
export interface WindowsSigning {
  /** Account endpoint, such as `https://eus.codesigning.azure.net/`. */
  endpoint: string;
  account: string;
  /** Public Trust certificate profile name. */
  profile: string;
  publisher: string;
}

/** The GitHub release the installer and update feed go to, shared with the other desktop lanes. */
export interface WindowsRelease {
  /** `owner/name`; a private app publishes to a public `<app>-releases` repository. */
  repo: string;
  tag: string;
}

/** A Windows app packaged with Velopack: a Setup.exe installer plus the update feed installed copies read. */
export interface WindowsConfig extends TargetConfig {
  /** PowerShell command, run in `dir`, that publishes the app into `publishDir`. */
  publish: string;
  /** Relative to `dir`. */
  publishDir: string;
  packId: string;
  packTitle: string;
  mainExe: string;
  runtime: "win-x64" | "win-arm64" | "win-x86";
  channel: string;
  /** vpk version; keep it equal to the app's Velopack NuGet package. */
  vpk: string;
  /** The app's workflow_dispatch workflow that calls shipit's windows-lane.yml. */
  workflow: string;
  release: WindowsRelease;
  /** `null` ships unsigned, with a warning on every run. */
  signing: WindowsSigning | null;
}

export interface NpmConfig extends TargetConfig {
  package: string;
}

export interface SecretSpec {
  name: string;
  /** Where the secret lives on disk; set this or `env`. */
  path?: string;
  /** The environment variable that carries it; set this or `path`. */
  env?: string;
  /** The 1Password item that holds it, such as `op://Incubator/nocam-play/credential`. */
  onePassword: string | null;
  /** How to get the secret back when it is lost. */
  restoreHint: string | null;
}

export interface ShipConfig {
  /** Absolute path of the directory that holds ship.json (the git repository root). */
  root: string;
  name: string;
  nightly: boolean;
  version: VersionSpec;
  checks: string[];
  notesPaths: string[];
  /** Repo-relative file of hand-written store release notes, read from main. */
  notesFile: string | null;
  credentials: string | null;
  /** More files to stamp with the version. */
  versionFiles: VersionFileSpec[];
  /** Repo-relative changelog file. */
  changelog: string | null;
  secrets: SecretSpec[];
  /** Commands `ship ci` runs in the checkout before any lane. */
  gates: string[];
  /** Where build numbers come from: the UTC time of the run, or the GitHub Actions run that releases it. */
  buildNumber: "time" | "githubRun";
  ios?: IosConfig;
  android?: AndroidConfig;
  mac?: MacDirectConfig;
  macAppStore?: MacConfig;
  windows?: WindowsConfig;
  linux?: TargetConfig;
  tauri?: TargetConfig;
  npm?: NpmConfig;
}

/** Targets with a lane: ship can build and release them. */
export const PLATFORMS = ["ios", "android", "mac", "windows"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Targets ship.json accepts whose lanes do not exist yet. */
export const PENDING_TARGETS = ["macAppStore", "linux", "tauri", "npm"] as const;
export type PendingTarget = (typeof PENDING_TARGETS)[number];
export type Target = Platform | PendingTarget;

const isPlatform = (value: string): value is Platform => (PLATFORMS as readonly string[]).includes(value);

export const isTarget = (value: string): value is Target =>
  isPlatform(value) || (PENDING_TARGETS as readonly string[]).includes(value);

export class LaneNotImplementedError extends Error {
  constructor(targets: readonly string[], hint = "") {
    super(`${targets.join(", ")}: lane not implemented yet (INC-998/999/1000)${hint}`);
  }
}

export function expandHome(path: string): string {
  const home = homedir();
  if (path === "~") return home;
  return path.replace(/^~\//, `${home}/`).replace(/^\$HOME\b|^\$\{HOME\}/, home);
}

/** Resolves a ship.json path field: `~` expands, relative paths are relative to the repository root. */
export function resolvePath(root: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(root, expanded);
}

/** Names an app's cache folder and lock. The path hash keeps `foo_bar` and `foo-bar`, or two checkouts of one app, apart. */
export const slug = (config: ShipConfig) =>
  `${basename(config.root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}-${createHash("sha256").update(config.root).digest("hex").slice(0, 8)}`;

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

class Reader {
  readonly errors: string[] = [];
  constructor(
    private readonly raw: Raw,
    private readonly where: string,
  ) {}

  private fail(key: string, expected: string) {
    this.errors.push(`${this.where}${key}: expected ${expected}`);
  }

  string(key: string): string {
    const value = this.raw[key];
    if (typeof value === "string" && value) return value;
    this.fail(key, "a non-empty string");
    return "";
  }

  optionalString(key: string): string | null {
    const value = this.raw[key];
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && value) return value;
    this.fail(key, "a non-empty string or null");
    return null;
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.raw[key];
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    this.fail(key, "true or false");
    return fallback;
  }

  strings(key: string): string[] {
    const value = this.raw[key];
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
    this.fail(key, "an array of strings");
    return [];
  }

  count(key: string, fallback: number): number {
    const value = this.raw[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    this.fail(key, "a whole number, 0 or more");
    return fallback;
  }

  stringMap(key: string): Record<string, string> {
    const value = this.raw[key];
    if (value === undefined) return {};
    if (isObject(value) && Object.values(value).every((item) => typeof item === "string" && item))
      return value as Record<string, string>;
    this.fail(key, "an object of non-empty strings");
    return {};
  }

  objects(key: string): Raw[] {
    const value = this.raw[key];
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every(isObject)) return value;
    this.fail(key, "an array of objects");
    return [];
  }

  object(key: string): Raw | undefined {
    const value = this.raw[key];
    if (value === undefined || value === null) return undefined;
    if (isObject(value)) return value;
    this.fail(key, "an object");
    return undefined;
  }

  rejectUnknown(known: string[]) {
    for (const key of Object.keys(this.raw)) {
      if (!known.includes(key)) this.errors.push(`${this.where}${key}: unknown key`);
    }
  }
}

function parseVersion(raw: Raw | undefined, errors: string[]): VersionSpec {
  if (!raw) {
    errors.push('version: expected an object such as { "file": "VERSION" }');
    return { file: "" };
  }
  return parseVersionFile(raw, "version.", errors);
}

function parseVersionFile(raw: Raw, where: string, errors: string[]): VersionFileSpec {
  const reader = new Reader(raw, where);
  const spec: VersionFileSpec = { file: reader.string("file") };
  const json = reader.optionalString("json");
  const yaml = reader.optionalString("yaml");
  const regex = reader.optionalString("regex");
  if (json) spec.json = json;
  if (yaml) spec.yaml = yaml;
  if (regex) {
    spec.regex = regex;
    let groups = 0;
    try {
      // The empty alternative always matches, so the result's length counts the pattern's capture groups.
      groups = (new RegExp(`(?:${regex})|`).exec("")?.length ?? 1) - 1;
    } catch {
      // An invalid pattern has no groups; the error below names it.
    }
    if (groups < 1) reader.errors.push(`${where}regex: expected a valid pattern with a capture group for the version`);
  }
  if ([json, yaml, regex].filter(Boolean).length > 1) reader.errors.push(`${where}: set one of json, yaml or regex`);
  reader.rejectUnknown(["file", "json", "yaml", "regex"]);
  errors.push(...reader.errors);
  return spec;
}

function parseSecret(raw: Raw, where: string, errors: string[]): SecretSpec {
  const reader = new Reader(raw, where);
  const secret: SecretSpec = {
    name: reader.string("name"),
    onePassword: reader.optionalString("onePassword"),
    restoreHint: reader.optionalString("restoreHint"),
  };
  const path = reader.optionalString("path");
  const env = reader.optionalString("env");
  if (path) secret.path = path;
  if (env) secret.env = env;
  if (Boolean(path) === Boolean(env)) reader.errors.push(`${where}: set exactly one of path or env`);
  reader.rejectUnknown(["name", "path", "env", "onePassword", "restoreHint"]);
  errors.push(...reader.errors);
  return secret;
}

function parseTarget<T extends object>(
  raw: Raw,
  name: string,
  errors: string[],
  extra: (reader: Reader) => T,
  extraKeys: string[] = [],
): TargetConfig & T {
  const reader = new Reader(raw, `${name}.`);
  const config = {
    dir: reader.optionalString("dir") ?? ".",
    copy: reader.strings("copy"),
    checks: reader.strings("checks"),
    ...extra(reader),
  };
  reader.rejectUnknown(["dir", "copy", "checks", ...extraKeys]);
  errors.push(...reader.errors);
  return config;
}

const parseMac = (raw: Raw, name: string, errors: string[]): MacConfig =>
  parseTarget(
    raw,
    name,
    errors,
    (reader) => ({ scheme: reader.string("scheme"), bundleId: reader.string("bundleId") }),
    ["scheme", "bundleId"],
  );

const WINDOWS_RUNTIMES = ["win-x64", "win-arm64", "win-x86"] as const;
/** Values that end up inside the cmd.exe signing template, so a quote cannot break out of it. */
const NO_QUOTES = /^[^"]+$/;

function parseWindowsSigning(raw: Raw | undefined, errors: string[]): WindowsSigning | null {
  if (!raw) return null;
  const reader = new Reader(raw, "windows.signing.");
  const signing: WindowsSigning = {
    endpoint: reader.string("endpoint"),
    account: reader.string("account"),
    profile: reader.string("profile"),
    publisher: reader.optionalString("publisher") ?? "Darkroom Engineering",
  };
  if (signing.endpoint && !/^https:\/\/[\w.-]+\/?$/.test(signing.endpoint))
    reader.errors.push("windows.signing.endpoint: expected an https URL such as https://eus.codesigning.azure.net/");
  for (const key of ["account", "profile"] as const)
    if (signing[key] && !/^[\w-]+$/.test(signing[key]))
      reader.errors.push(`windows.signing.${key}: expected letters, digits, - and _`);
  if (!NO_QUOTES.test(signing.publisher)) reader.errors.push("windows.signing.publisher: must not contain quotes");
  reader.rejectUnknown(["endpoint", "account", "profile", "publisher"]);
  errors.push(...reader.errors);
  return signing;
}

function parseWindowsRelease(raw: Raw | undefined, errors: string[]): WindowsRelease {
  if (!raw) {
    errors.push('windows.release: expected { "repo": "owner/name", "tag": "..." }');
    return { repo: "", tag: "" };
  }
  const reader = new Reader(raw, "windows.release.");
  const release: WindowsRelease = { repo: reader.string("repo"), tag: reader.string("tag") };
  if (release.repo && !/^[\w.-]+\/[\w.-]+$/.test(release.repo))
    reader.errors.push("windows.release.repo: expected owner/name");
  reader.rejectUnknown(["repo", "tag"]);
  errors.push(...reader.errors);
  return release;
}

const parseWindows = (raw: Raw, errors: string[]): WindowsConfig =>
  parseTarget(
    raw,
    "windows",
    errors,
    (reader) => {
      const packId = reader.string("packId");
      if (packId && !/^[A-Za-z0-9][\w.-]*$/.test(packId))
        reader.errors.push("windows.packId: expected letters, digits, ., - and _");
      const runtime = reader.optionalString("runtime") ?? "win-x64";
      if (!(WINDOWS_RUNTIMES as readonly string[]).includes(runtime))
        reader.errors.push(`windows.runtime: expected ${WINDOWS_RUNTIMES.join(", ")}`);
      const vpk = reader.string("vpk");
      if (vpk && !/^\d+\.\d+\.\d+$/.test(vpk)) reader.errors.push('windows.vpk: expected a version such as "1.2.161"');
      const packTitle = reader.optionalString("packTitle") ?? packId;
      if (packTitle && !NO_QUOTES.test(packTitle)) reader.errors.push("windows.packTitle: must not contain quotes");
      return {
        publish: reader.string("publish"),
        publishDir: reader.string("publishDir"),
        packId,
        packTitle,
        mainExe: reader.string("mainExe"),
        runtime: runtime as WindowsConfig["runtime"],
        channel: reader.optionalString("channel") ?? "win",
        vpk,
        workflow: reader.optionalString("workflow") ?? "ship-windows.yml",
        release: parseWindowsRelease(reader.object("release"), errors),
        signing: parseWindowsSigning(reader.object("signing"), errors),
      };
    },
    [
      "publish",
      "publishDir",
      "packId",
      "packTitle",
      "mainExe",
      "runtime",
      "channel",
      "vpk",
      "workflow",
      "release",
      "signing",
    ],
  );

const ARCHITECTURES = ["arm64", "x86_64"];
/** A file name with no folder, so it is one asset or object key. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseHosting(raw: Raw | undefined, errors: string[]): MacHosting {
  if (!raw) {
    errors.push('mac.hosting: expected { "type": "github", ... } or { "type": "r2", ... }');
    return { type: "github", repo: "", tag: "" };
  }
  const reader = new Reader(raw, "mac.hosting.");
  const type = reader.string("type");
  let hosting: MacHosting;
  if (type === "r2") {
    hosting = {
      type,
      bucket: reader.string("bucket"),
      accountId: reader.string("accountId"),
      profile: reader.optionalString("profile"),
    };
    reader.rejectUnknown(["type", "bucket", "accountId", "profile"]);
  } else {
    if (type && type !== "github") reader.errors.push('mac.hosting.type: expected "github" or "r2"');
    hosting = { type: "github", repo: reader.string("repo"), tag: reader.string("tag") };
    if (hosting.repo && !/^[\w.-]+\/[\w.-]+$/.test(hosting.repo))
      reader.errors.push("mac.hosting.repo: expected owner/name");
    reader.rejectUnknown(["type", "repo", "tag"]);
  }
  errors.push(...reader.errors);
  return hosting;
}

function parseMacDirect(raw: Raw, appName: string, errors: string[]): MacDirectConfig {
  const keys = [
    "kind",
    "app",
    "architectures",
    "feedUrl",
    "publicKey",
    "sparkleAccount",
    "entitlements",
    "sign",
    "helperEntitlements",
    "requiredEntitlements",
    "forbiddenEntitlements",
    "binaries",
    "notaryProfile",
    "deltas",
    "dmg",
    "hosting",
  ];
  const local: string[] = [];
  const config = parseTarget(
    raw,
    "mac",
    errors,
    (reader) => {
      const kind = reader.optionalString("kind") ?? "xcodeproj";
      if (kind !== "xcodeproj" && kind !== "xcodegen") local.push('mac.kind: expected "xcodeproj" or "xcodegen"');
      const architectures = reader.strings("architectures");
      return {
        scheme: reader.string("scheme"),
        bundleId: reader.string("bundleId"),
        kind: kind === "xcodegen" ? ("xcodegen" as const) : ("xcodeproj" as const),
        app: reader.optionalString("app") ?? `${appName}.app`,
        architectures: architectures.length ? architectures : ["arm64"],
        feedUrl: reader.string("feedUrl"),
        publicKey: reader.string("publicKey"),
        sparkleAccount: reader.optionalString("sparkleAccount") ?? "ed25519",
        entitlements: reader.optionalString("entitlements"),
        sign: reader.strings("sign"),
        helperEntitlements: reader.stringMap("helperEntitlements"),
        requiredEntitlements: reader.strings("requiredEntitlements"),
        forbiddenEntitlements: reader.strings("forbiddenEntitlements"),
        binaries: reader.strings("binaries"),
        notaryProfile: reader.optionalString("notaryProfile"),
        deltas: reader.count("deltas", 1),
        dmg: reader.optionalString("dmg") ?? `${appName}-mac.dmg`,
        hosting: parseHosting(reader.object("hosting"), local),
      };
    },
    ["scheme", "bundleId", ...keys],
  );
  if (!config.app.endsWith(".app") || config.app.includes("/"))
    local.push("mac.app: expected a bundle name ending in .app");
  if (config.architectures.some((arch) => !ARCHITECTURES.includes(arch)))
    local.push(`mac.architectures: expected some of ${ARCHITECTURES.join(", ")}`);
  if (config.feedUrl && !/^https:\/\/[^/]+\/(.*\/)?appcast\.xml$/.test(config.feedUrl))
    local.push("mac.feedUrl: expected an https URL of an appcast.xml");
  else if (config.feedUrl) {
    const problem = feedProblem(config.hosting, config.feedUrl);
    if (problem) local.push(`mac.feedUrl: ${problem}`);
  }
  if (config.publicKey && Buffer.from(config.publicKey, "base64").length !== 32)
    local.push("mac.publicKey: expected the base64 Ed25519 public key from SUPublicEDKey");
  if (!config.dmg.endsWith(".dmg") || !FILE_NAME.test(config.dmg))
    local.push("mac.dmg: expected a file name ending in .dmg, such as Programa-mac.dmg");
  for (const path of Object.keys(config.helperEntitlements))
    if (!config.sign.includes(path)) local.push(`mac.helperEntitlements.${path}: not listed in mac.sign`);
  for (const path of [...config.sign, ...config.binaries])
    if (!path.startsWith("Contents/") || path.split("/").includes(".."))
      local.push(`mac: ${path} must be a path inside the app, starting with Contents/`);
  errors.push(...local);
  return config;
}

/**
 * Why the feed URL cannot be served by the hosting, if it cannot. A GitHub feed is the release's own appcast.xml, or
 * the latest release's; an R2 feed is appcast.xml at the bucket's root, served at the feed URL's folder.
 */
export function feedProblem(hosting: MacHosting, feedUrl: string): string | undefined {
  if (hosting.type === "r2")
    return new URL(feedUrl).pathname === "/appcast.xml"
      ? undefined
      : "an r2 feed is appcast.xml at the root of the bucket's domain";
  const base = `https://github.com/${hosting.repo}/releases`;
  if (feedUrl === `${base}/latest/download/appcast.xml` || feedUrl === `${base}/download/${hosting.tag}/appcast.xml`)
    return undefined;
  return `expected ${base}/latest/download/appcast.xml or ${base}/download/${hosting.tag}/appcast.xml for the github hosting`;
}

function parseUpdate(raw: Raw, errors: string[]): UpdateConfig {
  const reader = new Reader(raw, "ios.update.");
  const easCli = reader.string("easCli");
  if (easCli && !/^eas-cli@\d+\.\d+\.\d+$/.test(easCli))
    reader.errors.push('ios.update.easCli: expected a pinned version such as "eas-cli@23.1.0"');
  const nativeInputs = reader.strings("nativeInputs");
  if (!nativeInputs.length) reader.errors.push("ios.update.nativeInputs: expected at least one pathspec");
  let envCheck: UpdateConfig["envCheck"] = null;
  const env = reader.object("envCheck");
  if (env) {
    const envReader = new Reader(env, "ios.update.envCheck.");
    envCheck = { key: envReader.string("key"), value: envReader.string("value") };
    envReader.rejectUnknown(["key", "value"]);
    reader.errors.push(...envReader.errors);
  }
  const config: UpdateConfig = {
    channel: reader.string("channel"),
    environment: reader.optionalString("environment"),
    easCli,
    nativeInputs,
    envCheck,
  };
  reader.rejectUnknown(["channel", "environment", "easCli", "nativeInputs", "envCheck"]);
  errors.push(...reader.errors);
  return config;
}

function parseIos(raw: Raw, errors: string[]): IosConfig {
  const reader = new Reader(raw, "ios.");
  const kind = reader.string("kind");
  if (kind !== "expo" && kind !== "xcodegen") reader.errors.push('ios.kind: expected "expo" or "xcodegen"');
  const dir = reader.optionalString("dir") ?? "ios";
  if (kind === "expo" && basename(dir) !== "ios")
    reader.errors.push("ios.dir: an expo project's native folder is named ios");
  const keepAlive = reader.optionalString("keepAlive");
  if (keepAlive && !/^\d+d$/.test(keepAlive))
    reader.errors.push('ios.keepAlive: expected a number of days such as "75d"');
  const listingFormat = reader.optionalString("listingFormat") ?? "json";
  if (listingFormat !== "json" && listingFormat !== "fastlane")
    reader.errors.push('ios.listingFormat: expected "json" or "fastlane"');
  const update = reader.object("update");
  if (update && kind !== "expo") reader.errors.push("ios.update: over-the-air updates need an expo app");
  const config: IosConfig = {
    kind: kind === "expo" ? "expo" : "xcodegen",
    dir,
    scheme: reader.string("scheme"),
    bundleId: reader.string("bundleId"),
    externalGroups: reader.strings("externalGroups"),
    copy: reader.strings("copy"),
    checks: reader.strings("checks"),
    preArchive: reader.optionalString("preArchive"),
    keepAlive,
    listing: reader.optionalString("listing"),
    listingFormat: listingFormat === "fastlane" ? "fastlane" : "json",
    update: update ? parseUpdate(update, reader.errors) : null,
  };
  reader.rejectUnknown([
    "kind",
    "dir",
    "scheme",
    "bundleId",
    "externalGroups",
    "copy",
    "checks",
    "preArchive",
    "keepAlive",
    "listing",
    "listingFormat",
    "update",
  ]);
  errors.push(...reader.errors);
  return config;
}

function parseAndroid(raw: Raw, errors: string[]): AndroidConfig {
  const reader = new Reader(raw, "android.");
  const config: AndroidConfig = {
    dir: reader.optionalString("dir") ?? "android",
    package: reader.string("package"),
    versionCodeProperty: reader.string("versionCodeProperty"),
    playKey: reader.optionalString("playKey"),
    copy: reader.strings("copy"),
    checks: reader.strings("checks"),
  };
  reader.rejectUnknown(["dir", "package", "versionCodeProperty", "playKey", "copy", "checks"]);
  errors.push(...reader.errors);
  return config;
}

/** Parses ship.json text. `root` is the directory it lives in. */
export function parseConfig(text: string, root: string): ShipConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${join(root, "ship.json")} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!isObject(raw)) throw new Error(`${join(root, "ship.json")} must hold a JSON object`);
  const top = new Reader(raw, "");
  const errors: string[] = [];
  const buildNumber = top.optionalString("buildNumber") ?? "time";
  const config: ShipConfig = {
    root,
    name: top.string("name"),
    nightly: top.boolean("nightly", false),
    version: parseVersion(top.object("version"), errors),
    checks: top.strings("checks"),
    notesPaths: top.strings("notesPaths"),
    notesFile: top.optionalString("notesFile"),
    credentials: top.optionalString("credentials"),
    versionFiles: top.objects("versionFiles").map((raw, i) => parseVersionFile(raw, `versionFiles[${i}].`, errors)),
    changelog: top.optionalString("changelog"),
    secrets: top.objects("secrets").map((raw, i) => parseSecret(raw, `secrets[${i}].`, errors)),
    gates: top.strings("gates"),
    buildNumber: buildNumber === "githubRun" ? "githubRun" : "time",
  };
  if (buildNumber !== "time" && buildNumber !== "githubRun") errors.push('buildNumber: expected "time" or "githubRun"');
  const ios = top.object("ios");
  const android = top.object("android");
  if (ios) config.ios = parseIos(ios, errors);
  if (android) config.android = parseAndroid(android, errors);
  const mac = top.object("mac");
  const macAppStore = top.object("macAppStore");
  const windows = top.object("windows");
  const linux = top.object("linux");
  const tauri = top.object("tauri");
  const npm = top.object("npm");
  const none = () => ({});
  if (mac) config.mac = parseMacDirect(mac, config.name, errors);
  if (macAppStore) config.macAppStore = parseMac(macAppStore, "macAppStore", errors);
  if (windows) config.windows = parseWindows(windows, errors);
  if (linux) config.linux = parseTarget(linux, "linux", errors, none);
  if (tauri) config.tauri = parseTarget(tauri, "tauri", errors, none);
  if (npm)
    config.npm = parseTarget(npm, "npm", errors, (reader) => ({ package: reader.string("package") }), ["package"]);
  if (!targetsOf(config).length)
    errors.push(`targets: configure at least one platform (${[...PLATFORMS, ...PENDING_TARGETS].join(", ")})`);
  top.rejectUnknown([
    "name",
    "nightly",
    "version",
    "checks",
    "notesPaths",
    "notesFile",
    "credentials",
    "versionFiles",
    "changelog",
    "secrets",
    "gates",
    "buildNumber",
    ...PLATFORMS,
    ...PENDING_TARGETS,
  ]);
  errors.push(...top.errors);
  if (errors.length) throw new Error(`${join(root, "ship.json")}:\n  ${errors.join("\n  ")}`);
  return config;
}

export function loadConfig(root: string): ShipConfig {
  const path = join(root, "ship.json");
  if (!existsSync(path)) throw new Error(`no ship.json in ${root}; run ship from an app's folder or pass -C <path>`);
  return parseConfig(readFileSync(path, "utf8"), root);
}

export const platformsOf = (config: ShipConfig): Platform[] => PLATFORMS.filter((platform) => config[platform]);

const targetsOf = (config: ShipConfig): Target[] => [
  ...platformsOf(config),
  ...PENDING_TARGETS.filter((target) => config[target]),
];

/**
 * The platforms a command runs: the requested one, or every configured one. A target with no lane fails, and so
 * does a run of every target when one of them has no lane, so a half release never passes for a whole one.
 */
export function lanesFor(config: ShipConfig, requested?: Target): Platform[] {
  if (requested && !isPlatform(requested)) throw new LaneNotImplementedError([requested]);
  if (requested) {
    if (!config[requested]) throw new Error(`ship.json has no ${requested} section`);
    return [requested];
  }
  const pending = PENDING_TARGETS.filter((target) => config[target]);
  if (pending.length)
    throw new LaneNotImplementedError(
      pending,
      platformsOf(config).length ? `; pass ${platformsOf(config).join(" or ")} to ship only that` : "",
    );
  return platformsOf(config);
}

export interface AscCredentials {
  keyId: string;
  issuerId: string;
  keyPath: string;
  teamId: string;
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const INCLUDE_LINE = /^\s*(?:\.|source)\s+(.+?)\s*$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length > 1) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, "");
}

/**
 * Reads a shell-style env file without running it. Handles `KEY=value`, `export KEY=value`, quotes, comments,
 * `$VAR` and `${VAR}` references, `~` and `$HOME`, and `. other.env` / `source other.env` include lines
 * (minecompanion's asc.env includes pokefolio's).
 */
export function readEnvFile(path: string, seen = new Set<string>()): Record<string, string> {
  const file = expandHome(path);
  if (seen.has(file)) return {};
  seen.add(file);
  if (!existsSync(file)) throw new Error(`env file ${path} does not exist`);
  const vars: Record<string, string> = {};
  const lookup = (name: string) => vars[name] ?? process.env[name] ?? "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue;
    const include = INCLUDE_LINE.exec(line);
    if (include?.[1]) {
      Object.assign(vars, readEnvFile(unquote(include[1]), seen));
      continue;
    }
    const match = ENV_LINE.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const value = unquote(match[2])
      .replace(/\$\{(\w+)\}|\$(\w+)/g, (_all, braced?: string, bare?: string) => lookup(braced ?? bare ?? ""))
      .replace(/^~\//, `${homedir()}/`);
    vars[match[1]] = value;
  }
  return vars;
}

/**
 * Resolves App Store Connect credentials for a project. Accepts ASC_KEY_ID / ASC_ISSUER_ID (key file derived
 * from ~/.appstoreconnect/private_keys/AuthKey_<id>.p8) and KEY_ID / ISSUER_ID / KEY_PATH. Values come from the
 * project's credentials file first, then the process environment.
 */
export function loadCredentials(config: ShipConfig): AscCredentials {
  const explicit = config.credentials ? resolvePath(config.root, config.credentials) : null;
  const fallback = expandHome(DEFAULT_CREDENTIALS);
  let vars: Record<string, string> = {};
  if (explicit) vars = readEnvFile(explicit);
  else if (existsSync(fallback)) vars = readEnvFile(fallback);
  const get = (...names: string[]) => names.map((name) => vars[name] ?? process.env[name]).find(Boolean);

  const keyId = get("ASC_KEY_ID", "KEY_ID");
  const issuerId = get("ASC_ISSUER_ID", "ISSUER_ID");
  const where = explicit ?? `${DEFAULT_CREDENTIALS} or the environment`;
  if (!keyId) throw new Error(`no ASC_KEY_ID (or KEY_ID) in ${where}`);
  if (!issuerId) throw new Error(`no ASC_ISSUER_ID (or ISSUER_ID) in ${where}`);
  const keyPath = expandHome(
    get("KEY_PATH", "ASC_KEY_PATH") ?? join(homedir(), ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`),
  );
  return { keyId, issuerId, keyPath, teamId: get("APPLE_TEAM_ID") ?? DEFAULT_TEAM_ID };
}
