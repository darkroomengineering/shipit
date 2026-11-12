import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lanesFor, parseConfig } from "./config.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "programa.ship.json"), "utf8");
const parse = (raw: unknown) => parseConfig(JSON.stringify(raw), "/apps/demo");
const KEY = "K4pw6WgryZqN0NI9t/FaNdroYWdSSuy2gejC3utPCQQ=";
const mac = {
  scheme: "Demo",
  bundleId: "a.b.mac",
  feedUrl: "https://github.com/acme/demo/releases/latest/download/appcast.xml",
  publicKey: KEY,
  hosting: { type: "github", repo: "acme/demo", tag: "rolling" },
};
const base = { name: "Demo", version: { file: "VERSION" } };
const rejects = (raw: object, message: string) => expect(() => parse({ ...base, ...raw })).toThrow(message);

describe("the mac lane config", () => {
  test("the Programa fixture parses with its real identity, feed and key", () => {
    const config = parseConfig(fixture, "/apps/programa");
    expect(config.buildNumber).toBe("githubRun");
    expect(config.version.regex).toBe("MARKETING_VERSION = ([0-9.]+);");
    expect(config.mac).toMatchObject({
      kind: "xcodeproj",
      dir: ".",
      scheme: "programa",
      bundleId: "com.darkroom.programa",
      app: "Programa.app",
      architectures: ["arm64"],
      feedUrl: "https://github.com/darkroomengineering/programa/releases/latest/download/appcast.xml",
      publicKey: KEY,
      sparkleAccount: "ed25519",
      entitlements: "programa.entitlements",
      helperEntitlements: {},
      notaryProfile: null,
      deltas: 1,
      dmg: "programa-macos.dmg",
      hosting: { type: "github", repo: "darkroomengineering/programa", tag: "rolling" },
    });
    expect(config.mac?.forbiddenEntitlements).toContain("com.apple.security.cs.disable-library-validation");
    expect(lanesFor(config)).toEqual(["mac"]);
    expect(lanesFor(config, "mac")).toEqual(["mac"]);
  });

  test("defaults: the app is named after ship.json's name and the stable DMG is <App>-mac.dmg", () => {
    const config = parse({ ...base, mac });
    expect(config.mac?.app).toBe("Demo.app");
    expect(config.mac?.dmg).toBe("Demo-mac.dmg");
    expect(config.mac?.architectures).toEqual(["arm64"]);
    expect(config.buildNumber).toBe("time");
  });

  test("r2 hosting with a per-app stable name, as browsee publishes Browsee.dmg", () => {
    const config = parse({
      ...base,
      mac: {
        ...mac,
        kind: "xcodegen",
        dir: "mac",
        feedUrl: "https://updates.browsee.app/appcast.xml",
        sparkleAccount: "browsee",
        notaryProfile: "browsee-notary",
        dmg: "Browsee.dmg",
        sign: ["Contents/Frameworks/browsee Helper*.app"],
        helperEntitlements: { "Contents/Frameworks/browsee Helper*.app": "mac/Support/Helper.entitlements" },
        hosting: { type: "r2", bucket: "browsee-updates", accountId: "abc", profile: "browsee-r2" },
      },
    });
    expect(config.mac?.hosting).toEqual({
      type: "r2",
      bucket: "browsee-updates",
      accountId: "abc",
      profile: "browsee-r2",
    });
    expect(config.mac?.dmg).toBe("Browsee.dmg");
    expect(config.mac?.kind).toBe("xcodegen");
  });

  test("macAppStore keeps the plain shape and still has no lane", () => {
    expect(() => parse({ ...base, macAppStore: { ...mac } })).toThrow("macAppStore.feedUrl: unknown key");
  });

  test("rejects unknown keys and bad values", () => {
    rejects({ mac: { ...mac, channel: "beta" } }, "mac.channel: unknown key");
    rejects({ mac: { ...mac, hosting: { ...mac.hosting, branch: "x" } } }, "mac.hosting.branch: unknown key");
    rejects({ mac: { ...mac, hosting: { type: "s3" } } }, 'mac.hosting.type: expected "github" or "r2"');
    rejects({ mac: { ...mac, hosting: undefined } }, "mac.hosting: expected");
    rejects({ mac: { ...mac, publicKey: "abc" } }, "mac.publicKey: expected the base64 Ed25519 public key");
    rejects({ mac: { ...mac, feedUrl: "http://x/appcast.xml" } }, "mac.feedUrl: expected an https URL");
    rejects({ mac: { ...mac, kind: "expo" } }, 'mac.kind: expected "xcodeproj" or "xcodegen"');
    rejects({ mac: { ...mac, architectures: ["arm64e"] } }, "mac.architectures: expected some of arm64, x86_64");
    rejects({ mac: { ...mac, dmg: "dist/Demo.dmg" } }, "mac.dmg: expected a file name ending in .dmg");
    rejects({ mac: { ...mac, deltas: -1 } }, "mac.deltas: expected a whole number");
    rejects({ mac: { ...mac, sign: ["../x"] } }, "mac: ../x must be a path inside the app");
    rejects({ mac: { ...mac, helperEntitlements: { "Contents/x.app": "x" } } }, "not listed in mac.sign");
    rejects({ mac, buildNumber: "commits" }, 'buildNumber: expected "time" or "githubRun"');
  });

  test("the feed URL must be one the hosting serves, so ship never moves an app's feed", () => {
    rejects(
      { mac: { ...mac, feedUrl: "https://github.com/acme/other/releases/latest/download/appcast.xml" } },
      "mac.feedUrl: expected https://github.com/acme/demo/releases/latest/download/appcast.xml or https://github.com/acme/demo/releases/download/rolling/appcast.xml",
    );
    expect(
      parse({ ...base, mac: { ...mac, feedUrl: "https://github.com/acme/demo/releases/download/rolling/appcast.xml" } })
        .mac?.feedUrl,
    ).toContain("/download/rolling/");
    rejects(
      {
        mac: {
          ...mac,
          feedUrl: "https://updates.example.com/mac/appcast.xml",
          hosting: { type: "r2", bucket: "b", accountId: "a" },
        },
      },
      "an r2 feed is appcast.xml at the root",
    );
  });
});
