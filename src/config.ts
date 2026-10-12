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
}

export interface IosConfig {
  kind: "expo" | "xcodegen";
  dir: string;
  scheme: string;
  bundleId: string;
  externalGroups: string[];
  copy: string[];
  preArchive: string | null;
  keepAlive: string | null;
  listing: string | null;
}

export interface AndroidConfig {
  dir: string;
  package: string;
  versionCodeProperty: string;
  playKey: string | null;
  copy: string[];
}

export interface ShipConfig {
  /** Absolute path of the directory that holds ship.json (the git repository root). */
  root: string;
  name: string;
  nightly: boolean;
  version: VersionSpec;
  checks: string[];
  notesPaths: string[];
  credentials: string | null;
  ios?: IosConfig;
  android?: AndroidConfig;
}

export type Platform = "ios" | "android";

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
  const reader = new Reader(raw, "version.");
  const spec: VersionSpec = { file: reader.string("file") };
  const json = reader.optionalString("json");
  const yaml = reader.optionalString("yaml");
  if (json) spec.json = json;
  if (yaml) spec.yaml = yaml;
  if (json && yaml) reader.errors.push("version: set json or yaml, not both");
  reader.rejectUnknown(["file", "json", "yaml"]);
  errors.push(...reader.errors);
  return spec;
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
  const config: IosConfig = {
    kind: kind === "expo" ? "expo" : "xcodegen",
    dir,
    scheme: reader.string("scheme"),
    bundleId: reader.string("bundleId"),
    externalGroups: reader.strings("externalGroups"),
    copy: reader.strings("copy"),
    preArchive: reader.optionalString("preArchive"),
    keepAlive,
    listing: reader.optionalString("listing"),
  };
  reader.rejectUnknown([
    "kind",
    "dir",
    "scheme",
    "bundleId",
    "externalGroups",
    "copy",
    "preArchive",
    "keepAlive",
    "listing",
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
  };
  reader.rejectUnknown(["dir", "package", "versionCodeProperty", "playKey", "copy"]);
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
  const config: ShipConfig = {
    root,
    name: top.string("name"),
    nightly: top.boolean("nightly", false),
    version: parseVersion(top.object("version"), errors),
    checks: top.strings("checks"),
    notesPaths: top.strings("notesPaths"),
    credentials: top.optionalString("credentials"),
  };
  const ios = top.object("ios");
  const android = top.object("android");
  if (ios) config.ios = parseIos(ios, errors);
  if (android) config.android = parseAndroid(android, errors);
  if (!ios && !android) errors.push("ios or android: configure at least one platform");
  top.rejectUnknown(["name", "nightly", "version", "checks", "notesPaths", "credentials", "ios", "android"]);
  errors.push(...top.errors);
  if (errors.length) throw new Error(`${join(root, "ship.json")}:\n  ${errors.join("\n  ")}`);
  return config;
}

export function loadConfig(root: string): ShipConfig {
  const path = join(root, "ship.json");
  if (!existsSync(path)) throw new Error(`no ship.json in ${root}; run ship from an app's folder or pass -C <path>`);
  return parseConfig(readFileSync(path, "utf8"), root);
}

export const platformsOf = (config: ShipConfig): Platform[] => [
  ...(config.ios ? (["ios"] as const) : []),
  ...(config.android ? (["android"] as const) : []),
];

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
