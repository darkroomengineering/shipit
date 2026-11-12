import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asc, type Resource } from "./asc.ts";
import { git } from "./git.ts";
import {
  appStoreProblems,
  appStoreSets,
  CREDIT,
  copyrightLine,
  diskSource,
  displayType,
  imageSize,
  loadListing,
  loadScreenshots,
  mainSource,
  parsePrivacy,
  playProblems,
  playShotProblems,
  pushAppStore,
  pushPlay,
  type Screenshot,
} from "./listing.ts";
import { Play } from "./play.ts";

const count = (text: string) => text.split(CREDIT).length - 1;
const fixtures = diskSource(join(import.meta.dir, "fixtures", "listing"));
const tmp = mkdtempSync(join(tmpdir(), "shipit-listing-"));
const saved = { ...process.env };

beforeAll(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "ship test",
    GIT_AUTHOR_EMAIL: "ship@example.com",
    GIT_COMMITTER_NAME: "ship test",
    GIT_COMMITTER_EMAIL: "ship@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
});

afterAll(() => {
  process.env = saved;
  rmSync(tmp, { recursive: true, force: true });
});

/** The first 33 bytes of a PNG, enough for its size to be read. */
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A JPEG header: SOI, an APP0 segment, then a baseline SOF0 frame. */
function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, ...new Array(9).fill(0)]);
}

const shot = (name: string, width = 1320, height = 2868): Screenshot => ({
  name,
  bytes: png(width, height),
  width,
  height,
});

describe("loadListing", () => {
  test("nocam's JSON: App Store fields at the top, Play under play, the name as the Play title", async () => {
    const listing = await loadListing(fixtures, "listing.json", "json");
    expect(listing.appStore).toEqual({
      name: "NoCam Film",
      subtitle: "Analog film & VHS camcorder",
      promotionalText: "Nine film stocks, five tape looks and a fisheye.",
      keywords: "camera,vintage,retro,90s,grain",
      description: `NoCam Film turns your iPhone into a 90s film camera.\n\nPRIVATE BY DESIGN\nNo accounts, no ads.\n\n${CREDIT}`,
      supportUrl: "https://nocamfilm.com/support",
      marketingUrl: "https://nocamfilm.com",
      privacyPolicyUrl: "https://nocamfilm.com/privacy",
    });
    expect(listing.play).toEqual({
      title: "NoCam Film",
      shortDescription: "Analog film camera and VHS camcorder",
      fullDescription: `NoCam Film turns your phone into a 90s film camera.\n\n${CREDIT}`,
    });
    expect(listing.screenshots).toEqual({ ios: "out/ios", android: "~/nocam-shots/android" });
    expect(listing.privacy).toBe("shared/store/privacy.json");
  });

  test("fastlane metadata: trimmed text files, supply's android folder, privacy next to the folder", async () => {
    const listing = await loadListing(fixtures, "fastlane/metadata", "fastlane");
    expect(listing.appStore).toEqual({
      name: "Tidewatch",
      subtitle: "Tides for your beach",
      promotionalText: "The next high tide, at a glance.",
      keywords: "tide,surf,beach",
      description: `Tidewatch shows the tides.\n\nNo ads, no tracking.\n\n${CREDIT}`,
      supportUrl: "https://tidewatch.example/support",
      privacyPolicyUrl: "https://tidewatch.example/privacy",
    });
    // An empty marketing_url.txt is skipped, as fastlane skips it.
    expect(listing.appStore.marketingUrl).toBeUndefined();
    expect(listing.play).toEqual({
      title: "Tidewatch",
      shortDescription: "Tides for your beach, hour by hour",
      fullDescription: `Tidewatch shows the tides on Android.\n\n${CREDIT}`,
    });
    expect(listing.screenshots).toEqual({ ios: null, android: null });
    expect(listing.privacy).toBe("fastlane/app_privacy_details.json");
  });

  test("fastlane screenshots are found in fastlane/screenshots/en-US and supply's phoneScreenshots", async () => {
    const root = join(tmp, "fastlane-shots");
    mkdirSync(join(root, "fastlane", "metadata", "en-US"), { recursive: true });
    mkdirSync(join(root, "fastlane", "screenshots", "en-US"), { recursive: true });
    mkdirSync(join(root, "fastlane", "metadata", "android", "en-US", "images", "phoneScreenshots"), {
      recursive: true,
    });
    writeFileSync(join(root, "fastlane", "metadata", "en-US", "name.txt"), "Demo");
    writeFileSync(join(root, "fastlane", "screenshots", "en-US", "1.png"), png(1320, 2868));
    writeFileSync(join(root, "fastlane", "metadata", "android", "en-US", "images", "phoneScreenshots", "1.png"), "");
    const listing = await loadListing(diskSource(root), "fastlane/metadata", "fastlane");
    expect(listing.screenshots).toEqual({
      ios: "fastlane/screenshots/en-US",
      android: "fastlane/metadata/android/en-US/images/phoneScreenshots",
    });
    expect(listing.privacy).toBeNull();
  });

  test("the credit is appended once, even when the file already ends with it", async () => {
    const root = join(tmp, "credited");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "listing.json"), JSON.stringify({ description: `Tides.\n\n${CREDIT}` }));
    const listing = await loadListing(diskSource(root), "listing.json", "json");
    expect(listing.appStore.description).toBe(`Tides.\n\n${CREDIT}`);
    expect(count(listing.appStore.description ?? "")).toBe(1);
  });

  test("a field of the wrong type, a missing file, or a fastlane folder without en-US is refused", async () => {
    const root = join(tmp, "broken");
    mkdirSync(join(root, "metadata", "es-ES"), { recursive: true });
    writeFileSync(join(root, "listing.json"), JSON.stringify({ keywords: ["tide"] }));
    await expect(loadListing(diskSource(root), "listing.json", "json")).rejects.toThrow("keywords: expected a string");
    await expect(loadListing(diskSource(root), "missing.json", "json")).rejects.toThrow("does not exist");
    await expect(loadListing(diskSource(root), "metadata", "fastlane")).rejects.toThrow("has no en-US folder");
  });
});

describe("limits", () => {
  const at = (n: number) => "x".repeat(n);

  test("a listing at every limit passes", () => {
    expect(
      appStoreProblems({
        name: at(30),
        subtitle: at(30),
        keywords: at(100),
        promotionalText: at(170),
        description: at(4000),
        supportUrl: "https://example.com/support",
      }),
    ).toEqual([]);
    expect(playProblems({ title: at(30), shortDescription: at(80), fullDescription: at(4000) })).toEqual([]);
  });

  test("one character over any App Store limit is refused, naming the field", () => {
    const problems = appStoreProblems({
      name: at(31),
      subtitle: at(31),
      keywords: at(101),
      promotionalText: at(171),
      description: at(4001),
    });
    expect(problems).toEqual([
      "name is 31 characters; App Store Connect allows 30",
      "subtitle is 31 characters; App Store Connect allows 30",
      "keywords is 101 bytes; App Store Connect allows 100",
      "promotionalText is 171 characters; App Store Connect allows 170",
      "description is 4001 characters; App Store Connect allows 4000",
    ]);
  });

  test("keywords are counted in UTF-8 bytes, so accented letters count double", () => {
    expect(appStoreProblems({ keywords: "é".repeat(50) })).toEqual([]);
    expect(appStoreProblems({ keywords: "é".repeat(51) })).toEqual([
      "keywords is 102 bytes; App Store Connect allows 100",
    ]);
  });

  test("the credit line counts toward the description limit", async () => {
    const root = join(tmp, "long");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "listing.json"), JSON.stringify({ description: at(3990) }));
    const listing = await loadListing(diskSource(root), "listing.json", "json");
    expect(appStoreProblems(listing.appStore)).toEqual([
      `description is ${3990 + 2 + CREDIT.length} characters; App Store Connect allows 4000`,
    ]);
  });

  test("an emoji counts as one character", () => {
    expect(appStoreProblems({ name: "🌊".repeat(30) })).toEqual([]);
  });

  test("a URL that does not parse is refused", () => {
    expect(appStoreProblems({ supportUrl: "nocamfilm.com/support" })).toEqual([
      "supportUrl is not a URL: nocamfilm.com/support",
    ]);
  });

  test("Play limits", () => {
    expect(playProblems({ title: at(31), shortDescription: at(81), fullDescription: at(4001) })).toHaveLength(3);
    expect(playShotProblems([shot("1.png")])).toHaveLength(1);
    expect(playShotProblems([shot("1.png"), shot("2.png")])).toEqual([]);
  });
});

describe("screenshots", () => {
  test("reads the size of PNG and JPEG files", () => {
    expect(imageSize(png(1320, 2868))).toEqual({ width: 1320, height: 2868 });
    expect(imageSize(jpeg(1290, 2796))).toEqual({ width: 1290, height: 2796 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  test("maps sizes to App Store screenshot sets in either orientation", () => {
    expect(displayType(1320, 2868)).toBe("APP_IPHONE_67");
    expect(displayType(2868, 1320)).toBe("APP_IPHONE_67");
    expect(displayType(1242, 2688)).toBe("APP_IPHONE_65");
    expect(displayType(2064, 2752)).toBe("APP_IPAD_PRO_3GEN_129");
    expect(displayType(1000, 1000)).toBeUndefined();
  });

  test("loads images in numeric file order and groups them into sets, refusing unknown sizes and over 10", async () => {
    const dir = join(tmp, "shots");
    mkdirSync(dir, { recursive: true });
    for (const n of [10, 2, 1]) writeFileSync(join(dir, `${n}.png`), png(1320, 2868));
    writeFileSync(join(dir, "notes.txt"), "not a screenshot");
    const shots = await loadScreenshots(diskSource(dir), ".");
    expect(shots.map((s) => s.name)).toEqual(["1.png", "2.png", "10.png"]);
    expect(appStoreSets(shots).sets.get("APP_IPHONE_67")).toHaveLength(3);

    const odd = appStoreSets([shot("a.png", 100, 100)]);
    expect(odd.problems).toEqual(["screenshot a.png is 100x100, which no iPhone or iPad set takes"]);
    const many = appStoreSets(Array.from({ length: 11 }, (_, i) => shot(`${i}.png`)));
    expect(many.problems).toEqual(["APP_IPHONE_67 has 11 screenshots; App Store Connect takes 10"]);
  });
});

describe("parsePrivacy", () => {
  test("reads fastlane's app_privacy_details.json", async () => {
    const text = (await fixtures.text("fastlane/app_privacy_details.json")) ?? "";
    expect(parsePrivacy(text, "privacy.json")).toEqual([
      { category: "PRECISE_LOCATION", purposes: ["APP_FUNCTIONALITY"], dataProtections: ["DATA_LINKED_TO_YOU"] },
      { category: "USER_ID", purposes: ["APP_FUNCTIONALITY"], dataProtections: ["DATA_LINKED_TO_YOU"] },
    ]);
  });

  test("takes DATA_NOT_COLLECTED alone", () => {
    expect(parsePrivacy(JSON.stringify([{ data_protections: ["DATA_NOT_COLLECTED"] }]), "p.json")).toEqual([
      { purposes: [], dataProtections: ["DATA_NOT_COLLECTED"] },
    ]);
  });

  test("refuses unknown values, a missing category, and DATA_NOT_COLLECTED next to other answers", () => {
    const parse = (raw: unknown) => () => parsePrivacy(JSON.stringify(raw), "p.json");
    expect(parse([{ category: "NAME", purposes: ["FUN"], data_protections: ["DATA_LINKED_TO_YOU"] }])).toThrow(
      "unknown purpose FUN",
    );
    expect(parse([{ purposes: ["ANALYTICS"], data_protections: ["DATA_LINKED_TO_YOU"] }])).toThrow(
      "category: expected a string",
    );
    expect(
      parse([
        { data_protections: ["DATA_NOT_COLLECTED"] },
        { category: "NAME", purposes: ["ANALYTICS"], data_protections: ["DATA_LINKED_TO_YOU"] },
      ]),
    ).toThrow("DATA_NOT_COLLECTED must be the only entry");
    expect(parse({})).toThrow("expected a non-empty array");
  });
});

describe("mainSource", () => {
  test("reads text, folders and binary files as they are on main, not the working copy", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "shots"), { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "listing.json"), '{"name":"On main"}');
    writeFileSync(join(repo, "shots", "1.png"), png(1320, 2868));
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "listing");
    writeFileSync(join(repo, "listing.json"), '{"name":"Uncommitted"}');
    writeFileSync(join(repo, "shots", "2.png"), png(1320, 2868));

    const source = await mainSource(repo);
    expect(await source.text("listing.json")).toBe('{"name":"On main"}');
    expect(await source.text("missing.json")).toBeUndefined();
    expect(await source.list("shots")).toEqual(["1.png"]);
    expect(await source.list("missing")).toEqual([]);
    expect(await source.bytes("shots/1.png")).toEqual(png(1320, 2868));
  });
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** An App Store Connect client that answers from `routes` and records every request. */
class FakeAsc extends Asc {
  readonly calls: Call[] = [];
  constructor(private readonly routes: (method: string, path: string) => unknown) {
    super({ keyId: "", issuerId: "", keyPath: "", teamId: "" });
  }
  override async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method ?? "GET";
    this.calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return this.routes(method, path) as T;
  }
}

const page = (data: Resource[]) => ({ data });

function routes(state = "PREPARE_FOR_SUBMISSION") {
  let uploads = 0;
  return (method: string, path: string): unknown => {
    if (method === "POST" && path === "/appScreenshots") {
      uploads++;
      return {
        data: {
          id: `shot${uploads}`,
          attributes: {
            uploadOperations: [
              {
                method: "PUT",
                url: `https://upload.example/${uploads}`,
                offset: 0,
                length: 33,
                requestHeaders: [{ name: "Content-Type", value: "image/png" }],
              },
            ],
          },
        },
      };
    }
    if (method !== "GET") return null;
    if (path.startsWith("/apps/app1/appStoreVersions"))
      return page([
        {
          id: "v1",
          attributes: { versionString: "1.2.0", appStoreState: state, copyright: "© 2025 Darkroom Engineering LLC" },
        },
      ]);
    if (path === "/appStoreVersions/v1/appStoreVersionLocalizations")
      return page([{ id: "vl1", attributes: { locale: "en-US", description: "Old.", keywords: "tide,surf,beach" } }]);
    if (path === "/apps/app1/appInfos")
      return page([
        { id: "live", attributes: { state: "READY_FOR_DISTRIBUTION" } },
        { id: "next", attributes: { state: "PREPARE_FOR_SUBMISSION" } },
      ]);
    if (path === "/appInfos/next/appInfoLocalizations")
      return page([{ id: "il1", attributes: { locale: "en-US", name: "Old name", subtitle: "Tides for your beach" } }]);
    if (path === "/appStoreVersionLocalizations/vl1/appScreenshotSets")
      return page([{ id: "set1", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }]);
    if (path === "/appScreenshotSets/set1/appScreenshots")
      return page([{ id: "old1", attributes: { sourceFileChecksum: "stale" } }]);
    throw new Error(`unexpected GET ${path}`);
  };
}

const appStore = (state?: string) => new FakeAsc(routes(state));

describe("pushAppStore", () => {
  const stubFetch = () =>
    spyOn(globalThis, "fetch").mockImplementation((async () => new Response("")) as unknown as typeof fetch);
  let uploads: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    uploads = stubFetch();
  });
  afterEach(() => uploads.mockRestore());

  async function push(asc: FakeAsc, dry: boolean) {
    const listing = await loadListing(fixtures, "fastlane/metadata", "fastlane");
    await pushAppStore(asc, {
      appId: "app1",
      version: "1.2.0",
      text: listing.appStore,
      copyright: copyrightLine(new Date(Date.UTC(2026, 10, 12))),
      sets: new Map([["APP_IPHONE_67", [shot("1.png"), shot("2.png")]]]),
      privacy: [{ category: "USER_ID", purposes: ["APP_FUNCTIONALITY"], dataProtections: ["DATA_LINKED_TO_YOU"] }],
      dry,
    });
    return listing;
  }

  test("writes only the changed text, the copyright and the screenshots, and never touches review", async () => {
    const asc = appStore();
    const listing = await push(asc, false);
    const writes = asc.calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PATCH /appInfoLocalizations/il1",
      "PATCH /appStoreVersionLocalizations/vl1",
      "PATCH /appStoreVersions/v1",
      "DELETE /appScreenshots/old1",
      "POST /appScreenshots",
      "PATCH /appScreenshots/shot1",
      "POST /appScreenshots",
      "PATCH /appScreenshots/shot2",
    ]);
    expect(writes[0]?.body).toEqual({
      data: {
        type: "appInfoLocalizations",
        id: "il1",
        attributes: { name: "Tidewatch", privacyPolicyUrl: "https://tidewatch.example/privacy" },
      },
    });
    expect(writes[1]?.body).toEqual({
      data: {
        type: "appStoreVersionLocalizations",
        id: "vl1",
        attributes: {
          description: listing.appStore.description,
          promotionalText: "The next high tide, at a glance.",
          supportUrl: "https://tidewatch.example/support",
        },
      },
    });
    expect(writes[2]?.body).toEqual({
      data: { type: "appStoreVersions", id: "v1", attributes: { copyright: "© 2026 Darkroom Engineering LLC" } },
    });
    expect(asc.calls.some((call) => /reviewSubmission|appDataUsage/i.test(call.path))).toBe(false);

    // Screenshot bytes go to the presigned URL without the API's bearer token.
    expect(uploads).toHaveBeenCalledTimes(2);
    const [url, init] = uploads.mock.calls[0] ?? [];
    expect(url).toBe("https://upload.example/1");
    expect(JSON.stringify(init?.headers)).not.toContain("Authorization");
  });

  test("a dry run writes nothing", async () => {
    const asc = appStore();
    await push(asc, true);
    expect(asc.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(uploads).not.toHaveBeenCalled();
  });

  test("a version in review or live is refused before any write", async () => {
    for (const state of ["WAITING_FOR_REVIEW", "READY_FOR_SALE"]) {
      const asc = appStore(state);
      await expect(push(asc, false)).rejects.toThrow(`1.2.0 is ${state}`);
      expect(asc.calls.filter((call) => call.method !== "GET")).toEqual([]);
    }
  });

  test("screenshots that already match are not uploaded again", async () => {
    const same = shot("1.png");
    const checksum = new Bun.CryptoHasher("md5").update(same.bytes).digest("hex");
    const asc = new FakeAsc((method, path) => {
      if (path === "/appScreenshotSets/set1/appScreenshots")
        return page([{ id: "s1", attributes: { sourceFileChecksum: checksum } }]);
      if (path === "/appStoreVersionLocalizations/vl1/appScreenshotSets")
        return page([{ id: "set1", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }]);
      return routes()(method, path);
    });
    await pushAppStore(asc, {
      appId: "app1",
      version: "1.2.0",
      text: {},
      copyright: "© 2025 Darkroom Engineering LLC",
      sets: new Map([["APP_IPHONE_67", [same]]]),
      privacy: null,
      dry: false,
    });
    expect(asc.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});

/** A Play client that records every request and answers an edit's creation. */
class FakePlay extends Play {
  readonly urls: string[] = [];
  constructor(private readonly failOn?: string) {
    super("/dev/null", "com.example.app");
  }
  override async call<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    this.urls.push(`${init.method ?? "GET"} ${url}`);
    if (this.failOn && url.includes(this.failOn)) throw new Error(`refused ${url}`);
    return (url.endsWith("/edits") ? { id: "e1" } : null) as T;
  }
}

describe("pushPlay", () => {
  const text = { title: "Tidewatch", shortDescription: "Tides", fullDescription: `Tides.\n\n${CREDIT}` };

  test("patches the text, replaces the phone screenshots, and commits without sending for review", async () => {
    const play = new FakePlay();
    await pushPlay(() => play, text, [shot("1.png"), shot("2.jpg")], false);
    const api = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app";
    const upload = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/com.example.app";
    expect(play.urls).toEqual([
      `POST ${api}/edits`,
      `PATCH ${api}/edits/e1/listings/en-US`,
      `DELETE ${api}/edits/e1/listings/en-US/phoneScreenshots`,
      `POST ${upload}/edits/e1/listings/en-US/phoneScreenshots?uploadType=media`,
      `POST ${upload}/edits/e1/listings/en-US/phoneScreenshots?uploadType=media`,
      `POST ${api}/edits/e1:commit?changesNotSentForReview=true&changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
    ]);
    expect(play.urls.some((url) => /CANCEL_IN_REVIEW_AND_SUBMIT|\/tracks\//.test(url))).toBe(false);
  });

  test("a failed edit is deleted, not committed", async () => {
    const play = new FakePlay("phoneScreenshots?uploadType");
    await expect(pushPlay(() => play, text, [shot("1.png"), shot("2.png")], false)).rejects.toThrow("refused");
    expect(play.urls.at(-1)).toMatch(/^DELETE .*\/edits\/e1$/);
    expect(play.urls.some((url) => url.includes(":commit"))).toBe(false);
  });

  test("a dry run never creates the Play client", async () => {
    let connected = false;
    await pushPlay(
      () => {
        connected = true;
        return new FakePlay();
      },
      text,
      null,
      true,
    );
    expect(connected).toBe(false);
  });
});
