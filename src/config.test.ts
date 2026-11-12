import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, platformsOf } from "./config.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", `${name}.ship.json`), "utf8");
const parse = (raw: unknown) => parseConfig(JSON.stringify(raw), "/apps/demo");
const minimal = {
  name: "Demo",
  version: { file: "VERSION" },
  ios: { kind: "xcodegen", scheme: "Demo", bundleId: "a.b" },
};

describe("parseConfig with the real configs", () => {
  test("nocam: plain VERSION file, iOS and Android", () => {
    const config = parseConfig(fixture("nocam"), "/apps/nocam");
    expect(config.version).toEqual({ file: "VERSION" });
    expect(config.notesFile).toBe("RELEASE_NOTES.md");
    expect(config.ios?.listing).toBe("shared/store/listing.json");
    expect(config.ios?.copy).toEqual([]);
    expect(config.android?.checks).toEqual(["android/scripts/check-permissions.sh"]);
    expect(platformsOf(config)).toEqual(["ios", "android"]);
  });

  test("mareas: YAML version, iOS only", () => {
    const config = parseConfig(fixture("mareas"), "/apps/mareas");
    expect(config.version).toEqual({ file: "project.yml", yaml: "settings.base.MARKETING_VERSION" });
    expect(config.ios?.dir).toBe(".");
    expect(config.ios?.listing).toBeNull();
    expect(config.android).toBeUndefined();
    expect(platformsOf(config)).toEqual(["ios"]);
  });

  test("pokefolio: JSON version, expo", () => {
    const config = parseConfig(fixture("pokefolio"), "/apps/pokefolio");
    expect(config.version).toEqual({ file: "apps/mobile/app.json", json: "expo.version" });
    expect(config.ios?.kind).toBe("expo");
    expect(config.ios?.preArchive).toBe("scripts/ship-pre-archive.sh");
    expect(config.checks).toHaveLength(4);
    expect(config.notesFile).toBeNull();
  });
});

describe("parseConfig defaults", () => {
  test("fills optional fields", () => {
    const config = parse({ ...minimal, android: { package: "a.b", versionCodeProperty: "v" } });
    expect(config.root).toBe("/apps/demo");
    expect(config.nightly).toBe(false);
    expect(config.checks).toEqual([]);
    expect(config.credentials).toBeNull();
    expect(config.ios?.dir).toBe("ios");
    expect(config.ios?.keepAlive).toBeNull();
    expect(config.ios?.listingFormat).toBe("json");
    expect(config.android?.dir).toBe("android");
    expect(config.android?.playKey).toBeNull();
  });
});

test("a fastlane metadata folder as the listing", () => {
  const config = parse({
    ...minimal,
    ios: { ...minimal.ios, listing: "ios/fastlane/metadata", listingFormat: "fastlane" },
  });
  expect(config.ios?.listingFormat).toBe("fastlane");
});

describe("parseConfig rejects", () => {
  const rejects = (raw: unknown, message: string) => expect(() => parse(raw)).toThrow(message);

  test("unknown keys at every level", () => {
    rejects({ ...minimal, nightlly: true }, "nightlly: unknown key");
    rejects({ ...minimal, version: { file: "VERSION", path: "x" } }, "version.path: unknown key");
    rejects({ ...minimal, ios: { ...minimal.ios, team: "x" } }, "ios.team: unknown key");
    rejects({ ...minimal, android: { package: "a", versionCodeProperty: "v", key: "x" } }, "android.key: unknown key");
  });

  test("a config with no platform", () => {
    rejects({ name: "Demo", version: { file: "VERSION" } }, "configure at least one platform");
  });

  test("a missing or malformed version", () => {
    rejects({ ...minimal, version: undefined }, "version: expected an object");
    rejects({ ...minimal, version: { file: "a.json", json: "v", yaml: "v" } }, "set json or yaml, not both");
  });

  test("wrong types and values", () => {
    rejects({ ...minimal, name: "" }, "name: expected a non-empty string");
    rejects({ ...minimal, nightly: "yes" }, "nightly: expected true or false");
    rejects({ ...minimal, checks: "bun test" }, "checks: expected an array of strings");
    rejects({ ...minimal, ios: { ...minimal.ios, kind: "flutter" } }, 'ios.kind: expected "expo" or "xcodegen"');
    rejects({ ...minimal, ios: { ...minimal.ios, keepAlive: "75" } }, "ios.keepAlive: expected a number of days");
    rejects({ ...minimal, ios: { ...minimal.ios, kind: "expo", dir: "native" } }, "native folder is named ios");
    rejects({ ...minimal, ios: { ...minimal.ios, listingFormat: "yaml" } }, 'ios.listingFormat: expected "json"');
  });

  test("text that is not a JSON object", () => {
    expect(() => parseConfig("{", "/apps/demo")).toThrow("is not valid JSON");
    expect(() => parseConfig("[]", "/apps/demo")).toThrow("must hold a JSON object");
  });

  test("every problem at once", () => {
    expect(() => parse({ ...minimal, name: 1, extra: true })).toThrow(/name: expected[\s\S]*extra: unknown key/);
  });
});
