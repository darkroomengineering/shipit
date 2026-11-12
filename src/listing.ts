import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { spawn } from "bun";
import { type Asc, attr, type Resource } from "./asc.ts";
import { expandHome } from "./config.ts";
import { git, mainRef } from "./git.ts";
import { log, warn, write } from "./log.ts";
import type { Play } from "./play.ts";

/** Closes every store description an Incubator app pushes. */
export const CREDIT = "A sidequest by Darkroom Engineering Incubator.";

/** The description with the credit line as its last paragraph, added once. */
export function withCredit(description: string): string {
  if (description.includes(CREDIT)) return description;
  return [description.trimEnd(), CREDIT].filter(Boolean).join("\n\n");
}

export const copyrightLine = (now = new Date()) => `© ${now.getUTCFullYear()} Darkroom Engineering LLC`;

export type ListingFormat = "json" | "fastlane";

/** App Store text. A field left out is left as it is in App Store Connect. */
export interface AppStoreText {
  name?: string;
  subtitle?: string;
  promotionalText?: string;
  keywords?: string;
  description?: string;
  supportUrl?: string;
  marketingUrl?: string;
  privacyPolicyUrl?: string;
}

/** Google Play text for the en-US listing. A field left out is left as it is in Play Console. */
export interface PlayText {
  title?: string;
  shortDescription?: string;
  fullDescription?: string;
}

export interface StoreListing {
  appStore: AppStoreText;
  play: PlayText;
  /** Folders of screenshots, in upload order by file name; null sends none and leaves the store's as they are. */
  screenshots: { ios: string | null; android: string | null };
  /** A fastlane app_privacy_details.json file. */
  privacy: string | null;
}

/** Where listing files are read from: GitHub's main for repo-relative paths, the disk for `~` and absolute ones. */
export interface Source {
  /** The file's text, or undefined when it does not exist. */
  text(path: string): Promise<string | undefined>;
  bytes(path: string): Promise<Uint8Array<ArrayBuffer>>;
  /** Names of the entries in a folder; empty when it does not exist. */
  list(dir: string): Promise<string[]>;
}

export function diskSource(root: string): Source {
  const at = (path: string) => join(root, path);
  return {
    text: async (path) => (existsSync(at(path)) ? readFileSync(at(path), "utf8") : undefined),
    bytes: async (path) => new Uint8Array(readFileSync(at(path))),
    list: async (dir) => (existsSync(at(dir)) && statSync(at(dir)).isDirectory() ? readdirSync(at(dir)) : []),
  };
}

async function gitBytes(root: string, object: string): Promise<Uint8Array<ArrayBuffer>> {
  const proc = spawn(["git", "-C", root, "show", object], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [bytes, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git show ${object} exited ${code}: ${stderr.trim()}`);
  return new Uint8Array(bytes);
}

/** Files as they are on main (see `mainRef`), so uncommitted edits never reach the stores. */
export async function mainSource(root: string): Promise<Source> {
  const ref = await mainRef(root);
  const exists = (path: string) =>
    git(root, "cat-file", "-e", `${ref}:${path}`).then(
      () => true,
      () => false,
    );
  return {
    text: async (path) =>
      (await exists(path)) ? new TextDecoder().decode(await gitBytes(root, `${ref}:${path}`)) : undefined,
    bytes: (path) => gitBytes(root, `${ref}:${path}`),
    list: async (dir) =>
      (await exists(dir))
        ? (await git(root, "ls-tree", "--name-only", `${ref}:${dir}`)).split("\n").filter(Boolean)
        : [],
  };
}

/** A path from a listing: `~` and absolute paths are read from the disk, anything else from `repo`. */
export function resolveIn(repo: Source, path: string): { source: Source; path: string } {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? { source: diskSource("/"), path: expanded } : { source: repo, path };
}

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function strings<K extends string>(raw: Raw, keys: readonly K[], where: string): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new Error(`${where}${key}: expected a string`);
    out[key] = value;
  }
  return out;
}

const APP_STORE_KEYS = [
  "name",
  "subtitle",
  "promotionalText",
  "keywords",
  "description",
  "supportUrl",
  "marketingUrl",
  "privacyPolicyUrl",
] as const;

/** nocam's shared/store/listing.json: App Store fields at the top, Play fields under `play`. */
function parseJsonListing(text: string, file: string): StoreListing {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!isObject(raw)) throw new Error(`${file} must be a JSON object`);
  const where = `${file}: `;
  const play = raw.play ?? {};
  if (!isObject(play)) throw new Error(`${where}play: expected an object`);
  const screenshots = raw.screenshots ?? {};
  if (!isObject(screenshots)) throw new Error(`${where}screenshots: expected an object`);
  const shots = strings(screenshots, ["ios", "android"], `${where}screenshots.`);
  const appStore = strings(raw, APP_STORE_KEYS, where);
  const playText = strings(play, ["title", "shortDescription", "fullDescription"], `${where}play.`);
  return {
    appStore,
    play: { title: appStore.name, ...playText },
    screenshots: { ios: shots.ios ?? null, android: shots.android ?? null },
    privacy: strings(raw, ["privacy"], where).privacy ?? null,
  };
}

const LOCALE = "en-US";
const FASTLANE_APP_STORE: Record<string, keyof AppStoreText> = {
  "name.txt": "name",
  "subtitle.txt": "subtitle",
  "promotional_text.txt": "promotionalText",
  "keywords.txt": "keywords",
  "description.txt": "description",
  "support_url.txt": "supportUrl",
  "marketing_url.txt": "marketingUrl",
  "privacy_url.txt": "privacyPolicyUrl",
};
const FASTLANE_PLAY: Record<string, keyof PlayText> = {
  "title.txt": "title",
  "short_description.txt": "shortDescription",
  "full_description.txt": "fullDescription",
};

async function readTexts<T>(source: Source, dir: string, files: Record<string, keyof T>): Promise<Partial<T>> {
  const present = new Set(await source.list(dir));
  const out: Partial<Record<keyof T, string>> = {};
  for (const [file, key] of Object.entries(files)) {
    if (!present.has(file)) continue;
    // fastlane trims every value and skips an empty file.
    const value = (await source.text(posix.join(dir, file)))?.trim();
    if (value) out[key] = value;
  }
  return out as Partial<T>;
}

/**
 * A fastlane metadata folder (deliver's `fastlane/metadata`): App Store text in `en-US/*.txt`, Play text in supply's
 * `android/en-US/*.txt`. Screenshots and App Privacy answers are found where fastlane keeps them, next to the folder.
 */
async function parseFastlane(source: Source, dir: string): Promise<StoreListing> {
  if (!(await source.list(dir)).includes(LOCALE)) throw new Error(`${dir} has no ${LOCALE} folder`);
  const parent = posix.dirname(dir);
  const iosShots = posix.join(parent, "screenshots", LOCALE);
  const androidShots = posix.join(dir, "android", LOCALE, "images", "phoneScreenshots");
  const privacy = posix.join(parent, "app_privacy_details.json");
  return {
    appStore: await readTexts<AppStoreText>(source, posix.join(dir, LOCALE), FASTLANE_APP_STORE),
    play: await readTexts<PlayText>(source, posix.join(dir, "android", LOCALE), FASTLANE_PLAY),
    screenshots: {
      ios: (await source.list(iosShots)).length ? iosShots : null,
      android: (await source.list(androidShots)).length ? androidShots : null,
    },
    privacy: (await source.list(parent)).includes("app_privacy_details.json") ? privacy : null,
  };
}

/** Reads a listing and closes both store descriptions with the credit line. */
export async function loadListing(source: Source, path: string, format: ListingFormat): Promise<StoreListing> {
  let listing: StoreListing;
  if (format === "fastlane") listing = await parseFastlane(source, path);
  else {
    const text = await source.text(path);
    if (text === undefined) throw new Error(`${path} does not exist`);
    listing = parseJsonListing(text, path);
  }
  const { description } = listing.appStore;
  const { fullDescription } = listing.play;
  if (description !== undefined) listing.appStore.description = withCredit(description);
  if (fullDescription !== undefined) listing.play.fullDescription = withCredit(fullDescription);
  return listing;
}

// App Store Connect Help, "App information" (name, subtitle) and "Platform version information" (promotional
// text, keywords, description):
// https://developer.apple.com/help/app-store-connect/reference/app-information/app-information
// https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information
export const APP_STORE_LIMITS = {
  name: 30,
  subtitle: 30,
  keywords: 100,
  promotionalText: 170,
  description: 4000,
} satisfies Partial<Record<keyof AppStoreText, number>>;

// Play Console Help, "Add preview assets to showcase your app": https://support.google.com/googleplay/android-developer/answer/9866151
export const PLAY_LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000 } satisfies Record<
  keyof PlayText,
  number
>;

/** Characters as a person counts them, so an emoji or accented letter is one. */
export const chars = (text: string) => [...text].length;

/** UTF-8 bytes, which App Store Connect uses for keywords: "up to 100 bytes". */
export const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function overLimits(
  text: Record<string, string | undefined>,
  limits: Record<string, number>,
  store: string,
  byteKeys: ReadonlySet<string> = new Set(),
): string[] {
  return Object.entries(limits).flatMap(([key, limit]) => {
    const value = text[key];
    if (value === undefined) return [];
    const [size, unit] = byteKeys.has(key) ? [bytes(value), "bytes"] : [chars(value), "characters"];
    return size > limit ? [`${key} is ${size} ${unit}; ${store} allows ${limit}`] : [];
  });
}

const URL_KEYS = ["supportUrl", "marketingUrl", "privacyPolicyUrl"] as const;

/** Everything App Store Connect would refuse in this text, checked before any call. */
export function appStoreProblems(text: AppStoreText): string[] {
  const urls = URL_KEYS.flatMap((key) => {
    const value = text[key];
    return value !== undefined && !URL.canParse(value) ? [`${key} is not a URL: ${value}`] : [];
  });
  return [...overLimits({ ...text }, APP_STORE_LIMITS, "App Store Connect", new Set(["keywords"])), ...urls];
}

export function playProblems(text: PlayText): string[] {
  return overLimits({ ...text }, PLAY_LIMITS, "Google Play");
}

export interface Screenshot {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

/** Width and height from a PNG or JPEG header. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452)
    return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return undefined;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    at += 2 + view.getUint16(at + 2);
  }
  return undefined;
}

const IMAGE = /\.(png|jpe?g)$/i;

/** Every PNG and JPEG in `dir`, ordered by file name with numbers compared as numbers (2.png before 10.png). */
export async function loadScreenshots(source: Source, dir: string): Promise<Screenshot[]> {
  const names = (await source.list(dir))
    .filter((name) => IMAGE.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (!names.length) throw new Error(`${dir} has no PNG or JPEG screenshots`);
  return Promise.all(
    names.map(async (name) => {
      const bytes = await source.bytes(posix.join(dir, name));
      const size = imageSize(bytes);
      if (!size) throw new Error(`${posix.join(dir, name)} is not a readable PNG or JPEG`);
      return { name, bytes, ...size };
    }),
  );
}

// Pixel sizes App Store Connect takes for each iPhone and iPad screenshot set, from Apple's screenshot
// specifications (https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications) as
// fastlane deliver maps them (deliver/lib/deliver/app_screenshot.rb, 2.241.2). Either orientation.
const DISPLAY_TYPES: Record<string, [number, number][]> = {
  APP_IPHONE_67: [
    [1260, 2736],
    [1290, 2796],
    [1320, 2868],
  ],
  APP_IPHONE_65: [
    [1242, 2688],
    [1284, 2778],
  ],
  APP_IPHONE_61: [
    [1179, 2556],
    [1206, 2622],
  ],
  APP_IPHONE_58: [
    [1170, 2532],
    [1125, 2436],
    [1080, 2340],
  ],
  APP_IPHONE_55: [[1242, 2208]],
  APP_IPAD_PRO_3GEN_129: [
    [2048, 2732],
    [2064, 2752],
  ],
  APP_IPAD_PRO_3GEN_11: [
    [1488, 2266],
    [1668, 2420],
    [1668, 2388],
    [1640, 2360],
  ],
};

export function displayType(width: number, height: number): string | undefined {
  const [short, long] = width < height ? [width, height] : [height, width];
  return Object.keys(DISPLAY_TYPES).find((type) => DISPLAY_TYPES[type]?.some(([w, h]) => w === short && h === long));
}

const SET_LIMIT = 10;

/** Screenshots grouped into App Store Connect screenshot sets, plus anything that would be refused. */
export function appStoreSets(shots: Screenshot[]): { sets: Map<string, Screenshot[]>; problems: string[] } {
  const sets = new Map<string, Screenshot[]>();
  const problems: string[] = [];
  for (const shot of shots) {
    const type = displayType(shot.width, shot.height);
    if (!type) {
      problems.push(`screenshot ${shot.name} is ${shot.width}x${shot.height}, which no iPhone or iPad set takes`);
      continue;
    }
    sets.set(type, [...(sets.get(type) ?? []), shot]);
  }
  for (const [type, list] of sets)
    if (list.length > SET_LIMIT)
      problems.push(`${type} has ${list.length} screenshots; App Store Connect takes ${SET_LIMIT}`);
  return { sets, problems };
}

export const PLAY_SHOTS = { min: 2, max: 8 };

export function playShotProblems(shots: Screenshot[]): string[] {
  return shots.length < PLAY_SHOTS.min || shots.length > PLAY_SHOTS.max
    ? [`Play takes ${PLAY_SHOTS.min} to ${PLAY_SHOTS.max} phone screenshots; found ${shots.length}`]
    : [];
}

export interface PrivacyAnswer {
  category?: string;
  purposes: string[];
  dataProtections: string[];
}

// The values fastlane's upload_app_privacy_details_to_app_store accepts (spaceship's AppDataUsage models).
const PROTECTIONS = new Set([
  "DATA_LINKED_TO_YOU",
  "DATA_NOT_LINKED_TO_YOU",
  "DATA_USED_TO_TRACK_YOU",
  "DATA_NOT_COLLECTED",
]);
const PURPOSES = new Set([
  "THIRD_PARTY_ADVERTISING",
  "DEVELOPERS_ADVERTISING",
  "ANALYTICS",
  "PRODUCT_PERSONALIZATION",
  "APP_FUNCTIONALITY",
  "OTHER_PURPOSES",
]);

/** Parses fastlane's app_privacy_details.json: one entry per data category, or one DATA_NOT_COLLECTED entry. */
export function parsePrivacy(text: string, file: string): PrivacyAnswer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${file}: expected a non-empty array`);
  const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  const problems: string[] = [];
  const answers = raw.map((entry, i): PrivacyAnswer => {
    const where = `${file}[${i}]`;
    if (!isObject(entry)) {
      problems.push(`${where}: expected an object`);
      return { purposes: [], dataProtections: [] };
    }
    const { category, purposes = [], data_protections: protections } = entry;
    if (!isStrings(protections) || !protections.length) problems.push(`${where}.data_protections: expected strings`);
    if (!isStrings(purposes)) problems.push(`${where}.purposes: expected strings`);
    const answer: PrivacyAnswer = {
      purposes: isStrings(purposes) ? purposes : [],
      dataProtections: isStrings(protections) ? protections : [],
    };
    for (const value of answer.dataProtections)
      if (!PROTECTIONS.has(value)) problems.push(`${where}: unknown data protection ${value}`);
    for (const value of answer.purposes) if (!PURPOSES.has(value)) problems.push(`${where}: unknown purpose ${value}`);
    if (answer.dataProtections.includes("DATA_NOT_COLLECTED")) {
      if (raw.length > 1 || category !== undefined)
        problems.push(`${where}: DATA_NOT_COLLECTED must be the only entry, with no category`);
      return answer;
    }
    if (typeof category !== "string" || !category) problems.push(`${where}.category: expected a string`);
    else answer.category = category;
    if (!answer.purposes.length) problems.push(`${where}.purposes: name at least one purpose`);
    return answer;
  });
  if (problems.length) throw new Error(problems.join("\n"));
  return answers;
}

// App Store Connect takes listing edits only on a version that is not in review or live.
const EDITABLE = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
]);

const say = (message: string) => log(`ios: ${message}`);
const preview = (value: string) =>
  value.length > 80 ? `${JSON.stringify(value.slice(0, 77))}... (${chars(value)} characters)` : JSON.stringify(value);

/** The fields of `want` whose value differs from the resource's, with a line logged for each field. */
function changes(resource: Resource | undefined, want: Record<string, string | undefined>, label: string): Raw {
  const changed: Raw = {};
  for (const [key, value] of Object.entries(want)) {
    if (value === undefined) continue;
    const same = attr(resource, key) === value;
    say(`${label} ${key}${same ? " (unchanged)" : `: ${preview(value)}`}`);
    if (!same) changed[key] = value;
  }
  return changed;
}

const localizationOf = (localizations: Resource[]) =>
  localizations.find((localization) => attr(localization, "locale") === LOCALE) ?? localizations[0];

interface UploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders: { name: string; value: string }[];
}

const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

async function uploadScreenshot(asc: Asc, setId: string, shot: Screenshot) {
  const reserved = (await asc.post("/appScreenshots", {
    data: {
      type: "appScreenshots",
      attributes: { fileName: shot.name, fileSize: shot.bytes.length },
      relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } } },
    },
  })) as { data: Resource };
  const operations = (reserved.data.attributes?.uploadOperations ?? []) as UploadOperation[];
  for (const operation of operations) {
    // A bare fetch: the upload URL is presigned and must not get the API's bearer token.
    const response = await fetch(operation.url, {
      method: operation.method,
      headers: Object.fromEntries(operation.requestHeaders.map((header) => [header.name, header.value])),
      body: shot.bytes.slice(operation.offset, operation.offset + operation.length),
    });
    if (!response.ok) throw new Error(`uploading ${shot.name} -> ${response.status}: ${await response.text()}`);
  }
  await asc.patch(`/appScreenshots/${reserved.data.id}`, {
    data: {
      type: "appScreenshots",
      id: reserved.data.id,
      attributes: { uploaded: true, sourceFileChecksum: md5(shot.bytes) },
    },
  });
}

/**
 * Replaces each screenshot set the listing has shots for. A set whose screenshots already match, file for file, is
 * left alone; sets the listing has no shots for are never touched.
 */
async function pushScreenshots(
  asc: Asc,
  localization: Resource | undefined,
  sets: Map<string, Screenshot[]>,
  dry: boolean,
) {
  const existing = localization
    ? await asc.list(`/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`)
    : [];
  for (const [type, shots] of sets) {
    let set = existing.find((candidate) => attr(candidate, "screenshotDisplayType") === type);
    const current = set ? await asc.list(`/appScreenshotSets/${set.id}/appScreenshots`) : [];
    if (
      current.length === shots.length &&
      current.every((old, i) => attr(old, "sourceFileChecksum") === md5(shots[i]?.bytes ?? new Uint8Array()))
    ) {
      say(`${type}: ${shots.length} screenshots (unchanged)`);
      continue;
    }
    say(`${type}: replacing ${current.length} screenshots with ${shots.map((shot) => shot.name).join(", ")}`);
    await write(dry, `replacing the ${type} screenshots`, async () => {
      if (!localization) throw new Error("no version localization to hold screenshots");
      set ??= (
        (await asc.post("/appScreenshotSets", {
          data: {
            type: "appScreenshotSets",
            attributes: { screenshotDisplayType: type },
            relationships: {
              appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localization.id } },
            },
          },
        })) as { data: Resource }
      ).data;
      for (const old of current) await asc.api(`/appScreenshots/${old.id}`, { method: "DELETE" });
      for (const shot of shots) await uploadScreenshot(asc, set.id, shot);
    });
  }
}

export interface AppStorePush {
  appId: string;
  version: string;
  text: AppStoreText;
  copyright: string;
  sets: Map<string, Screenshot[]>;
  privacy: PrivacyAnswer[] | null;
  dry: boolean;
}

/**
 * Writes the listing to the App Store version `version` and the app info being prepared with it. It never submits
 * anything for review: the listing waits on the version until `ship release` sends it.
 */
export async function pushAppStore(asc: Asc, push: AppStorePush) {
  const { appId, version, text, dry } = push;
  const [found] = await asc.list(
    `/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${version}&fields[appStoreVersions]=versionString,appStoreState,copyright`,
  );
  const state = attr(found, "appStoreState");
  if (state && !EDITABLE.has(state))
    throw new Error(
      `${version} is ${state}; App Store Connect takes listing changes only on a version being prepared (ship beta starts the next one)`,
    );
  let target = found;
  if (!target) {
    say(`${version} has no App Store version yet`);
    target = await write(
      dry,
      `creating App Store version ${version}`,
      async () =>
        (
          (await asc.post("/appStoreVersions", {
            data: {
              type: "appStoreVersions",
              attributes: { platform: "IOS", versionString: version },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          })) as { data: Resource }
        ).data,
    );
  }
  const versionLocalization = target
    ? localizationOf(await asc.list(`/appStoreVersions/${target.id}/appStoreVersionLocalizations`))
    : undefined;
  if (target && !versionLocalization) throw new Error(`App Store version ${version} has no localization`);
  // Name, subtitle and privacy policy live on the app info, which App Store Connect opens with the new version.
  const infos = await asc.list(`/apps/${appId}/appInfos`);
  const info = infos.find((candidate) =>
    EDITABLE.has(attr(candidate, "state") ?? attr(candidate, "appStoreState") ?? ""),
  );
  if (!info && target)
    throw new Error("the app has no app info being prepared, so its name and subtitle cannot change");
  const infoLocalization = info
    ? localizationOf(await asc.list(`/appInfos/${info.id}/appInfoLocalizations`))
    : undefined;
  if (info && !infoLocalization) throw new Error("the app info has no localization");

  say(`listing for ${version} (${state ?? "new version"}), ${attr(versionLocalization, "locale") ?? LOCALE}`);
  const infoChanges = changes(
    infoLocalization,
    { name: text.name, subtitle: text.subtitle, privacyPolicyUrl: text.privacyPolicyUrl },
    "app info",
  );
  const versionChanges = changes(
    versionLocalization,
    {
      description: text.description,
      keywords: text.keywords,
      promotionalText: text.promotionalText,
      supportUrl: text.supportUrl,
      marketingUrl: text.marketingUrl,
    },
    "version",
  );
  const copyrightChanges = changes(target, { copyright: push.copyright }, "version");

  if (Object.keys(infoChanges).length)
    await write(dry, `updating ${Object.keys(infoChanges).join(", ")} on the app info`, async () => {
      if (!infoLocalization) throw new Error("no app info localization");
      await asc.patch(`/appInfoLocalizations/${infoLocalization.id}`, {
        data: { type: "appInfoLocalizations", id: infoLocalization.id, attributes: infoChanges },
      });
    });
  if (Object.keys(versionChanges).length)
    await write(dry, `updating ${Object.keys(versionChanges).join(", ")} on ${version}`, async () => {
      if (!versionLocalization) throw new Error(`App Store version ${version} has no localization`);
      await asc.patch(`/appStoreVersionLocalizations/${versionLocalization.id}`, {
        data: { type: "appStoreVersionLocalizations", id: versionLocalization.id, attributes: versionChanges },
      });
    });
  if (Object.keys(copyrightChanges).length)
    await write(dry, `setting the copyright on ${version}`, async () => {
      if (!target) throw new Error(`no App Store version ${version}`);
      await asc.patch(`/appStoreVersions/${target.id}`, {
        data: { type: "appStoreVersions", id: target.id, attributes: copyrightChanges },
      });
    });

  await pushScreenshots(asc, versionLocalization, push.sets, dry);

  if (push.privacy) {
    for (const answer of push.privacy)
      say(
        `App Privacy: ${answer.category ?? "no data collected"}${answer.purposes.length ? ` for ${answer.purposes.join(", ")}` : ""} (${answer.dataProtections.join(", ")})`,
      );
    // fastlane sends these through App Store Connect's private iris API, signed in with an Apple ID; the API key
    // ship signs in with has no endpoint for them.
    warn("ios: App Privacy answers are checked but not sent: the App Store Connect API key cannot set them");
  }
}

/**
 * Writes the en-US Play listing in one edit. The commit sets changesNotSentForReview=true, which asks Play not to
 * send the change for review, and ERROR_IF_IN_REVIEW, so changes already in review are never cancelled. A dry run
 * never calls `connect`, so it needs no Play key.
 */
export async function pushPlay(connect: () => Play, text: PlayText, shots: Screenshot[] | null, dry: boolean) {
  const sayPlay = (message: string) => log(`android: ${message}`);
  const fields = Object.fromEntries(Object.entries(text).filter(([, value]) => value !== undefined));
  for (const [key, value] of Object.entries(fields)) sayPlay(`${key}: ${preview(String(value))}`);
  if (shots) sayPlay(`phoneScreenshots: ${shots.map((shot) => shot.name).join(", ")}`);
  if (!Object.keys(fields).length && !shots) {
    sayPlay("the listing has no Play text or screenshots");
    return;
  }
  if (dry) {
    sayPlay("dry run: skipped the Play edit (listing text, screenshots, commit); Play was not contacted");
    return;
  }
  const play = connect();
  const edit = await play.newEdit();
  try {
    const listing = `${play.api}/edits/${edit}/listings/${LOCALE}`;
    if (Object.keys(fields).length)
      await play.call(listing, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
    if (shots) {
      await play.call(`${listing}/phoneScreenshots`, { method: "DELETE" });
      for (const shot of shots)
        await play.call(`${play.upload}/edits/${edit}/listings/${LOCALE}/phoneScreenshots?uploadType=media`, {
          method: "POST",
          headers: { "Content-Type": /\.png$/i.test(shot.name) ? "image/png" : "image/jpeg" },
          body: shot.bytes,
        });
    }
    await play.call(
      `${play.api}/edits/${edit}:commit?changesNotSentForReview=true&changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
      { method: "POST" },
    );
  } catch (error) {
    await play.deleteEdit(edit).catch(() => undefined);
    throw error;
  }
  sayPlay("listing committed with changesNotSentForReview");
}
