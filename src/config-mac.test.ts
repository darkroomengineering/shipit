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

  test("macAppStore takes no Sparkle fields", () => {
    expect(() => parse({ ...base, macAppStore: { ...mac } })).toThrow("macAppStore.feedUrl: unknown key");
  });

  test("a command build names its command and the app it leaves, and needs no scheme", () => {
    const { scheme: _, ...noScheme } = mac;
    const config = parse({
      ...base,
      mac: { ...noScheme, kind: "command", build: "scripts/bundle.sh", app: "target/release/Demo.app" },
    });
    expect(config.mac).toMatchObject({
      kind: "command",
      build: "scripts/bundle.sh",
      appPath: "target/release/Demo.app",
      app: "Demo.app",
      sparkleBin: null,
    });
    expect(config.mac && "scheme" in config.mac).toBe(false);
    expect(parse({ ...base, mac: { ...mac, sparkleBin: "~/Sparkle/bin" } }).mac?.sparkleBin).toBe("~/Sparkle/bin");
  });

  test("a command build rejects what only an Xcode build has, and an app outside the repository", () => {
    const command = { ...mac, scheme: undefined, kind: "command", build: "make app", app: "build/Demo.app" };
    rejects({ mac: { ...command, scheme: "Demo" } }, "mac.scheme: a command build has no scheme");
    rejects({ mac: { ...command, app: undefined } }, "mac.app: a command build needs the repo-relative path");
    rejects({ mac: { ...command, build: undefined } }, "mac.build: expected a non-empty string");
    for (const app of ["/tmp/Demo.app", "../Demo.app", "~/Demo.app", "build/Demo"])
      rejects({ mac: { ...command, app } }, "mac.app: expected a path inside the repository ending in .app");
    rejects({ mac: { ...mac, build: "make app" } }, 'mac.build: only a "command" build runs a build command');
    rejects({ mac: { ...mac, scheme: undefined } }, "mac.scheme: expected a non-empty string");
  });

  test("rejects unknown keys and bad values", () => {
    rejects({ mac: { ...mac, channel: "beta" } }, "mac.channel: unknown key");
    rejects({ mac: { ...mac, hosting: { ...mac.hosting, branch: "x" } } }, "mac.hosting.branch: unknown key");
    rejects({ mac: { ...mac, hosting: { type: "s3" } } }, 'mac.hosting.type: expected "github" or "r2"');
    rejects({ mac: { ...mac, hosting: undefined } }, "mac.hosting: expected");
    rejects({ mac: { ...mac, publicKey: "abc" } }, "mac.publicKey: expected the base64 Ed25519 public key");
    rejects({ mac: { ...mac, feedUrl: "http://x/appcast.xml" } }, "mac.feedUrl: expected an https URL");
    rejects({ mac: { ...mac, kind: "expo" } }, 'mac.kind: expected "xcodeproj", "xcodegen" or "command"');
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

describe("the Mac App Store lane config", () => {
  const codigo = readFileSync(join(import.meta.dir, "fixtures", "codigo.ship.json"), "utf8");
  const store = { scheme: "Demo", bundleId: "a.b.mac", entitlements: "Demo.entitlements", provisioningProfile: "p" };

  test("the codigo example parses: a command build with codigo's bundle id, profile and Info.plist keys", () => {
    const config = parseConfig(codigo, "/apps/codigo");
    expect(config.macAppStore).toEqual({
      dir: ".",
      copy: [],
      checks: [],
      bundleId: "dev.darkroom.codigo",
      architectures: ["arm64"],
      kind: "command",
      build: "scripts/bundle.sh",
      appPath: "target/release/codigo.app",
      app: "codigo.app",
      entitlements: "assets/appstore/codigo.entitlements",
      provisioningProfile: "~/.appstoreconnect/codigo/codigo_Mac_App_Store.provisionprofile",
      privacyManifest: "assets/appstore/PrivacyInfo.xcprivacy",
      infoPlist: {
        CFBundleDisplayName: "codigo",
        CFBundleInfoDictionaryVersion: "6.0",
        CFBundleSupportedPlatforms: ["MacOSX"],
        LSMinimumSystemVersion: "13.0",
        ITSAppUsesNonExemptEncryption: false,
        NSHumanReadableCopyright: "Copyright 2026 Darkroom Engineering LLC",
      },
    });
    expect(lanesFor(config)).toEqual(["macAppStore"]);
  });

  test("codigo's direct-download block parses next to it, with the codigo-releases feed", () => {
    const raw = JSON.parse(codigo);
    const {
      entitlements: _,
      provisioningProfile: __,
      privacyManifest: ___,
      infoPlist: ____,
      ...shared
    } = raw.macAppStore;
    const config = parse({
      ...raw,
      mac: {
        ...shared,
        feedUrl: "https://github.com/darkroomengineering/codigo-releases/releases/latest/download/appcast.xml",
        publicKey: KEY,
        sparkleBin: "~/Developer/Sparkle/bin",
        hosting: { type: "github", repo: "darkroomengineering/codigo-releases", tag: "rolling" },
      },
    });
    expect(config.mac).toMatchObject({ kind: "command", app: "codigo.app", appPath: "target/release/codigo.app" });
    expect(lanesFor(config)).toEqual(["mac", "macAppStore"]);
  });

  test("an Xcode build defaults like the mac lane", () => {
    const config = parse({ ...base, macAppStore: store });
    expect(config.macAppStore).toMatchObject({
      kind: "xcodeproj",
      scheme: "Demo",
      app: "Demo.app",
      architectures: ["arm64"],
      privacyManifest: null,
      infoPlist: {},
    });
  });

  test("rejects missing store fields, bad Info.plist entries and unknown keys", () => {
    const { entitlements: _, ...noEntitlements } = store;
    const { provisioningProfile: __, ...noProfile } = store;
    rejects({ macAppStore: noEntitlements }, "macAppStore.entitlements: expected a non-empty string");
    rejects({ macAppStore: noProfile }, "macAppStore.provisioningProfile: expected a non-empty string");
    rejects(
      { macAppStore: { ...store, infoPlist: { LSMinimumSystemVersion: 13 } } },
      "macAppStore.infoPlist.LSMinimumSystemVersion: expected a string",
    );
    rejects(
      { macAppStore: { ...store, infoPlist: { "a b": "x" } } },
      "macAppStore.infoPlist.a b: expected an Info.plist key name",
    );
    rejects({ macAppStore: { ...store, architectures: ["ppc"] } }, "macAppStore.architectures: expected some of");
    rejects({ macAppStore: { ...store, kind: "command", build: "make" } }, "macAppStore.app: a command build needs");
    rejects({ macAppStore: { ...store, sparkleBin: "x" } }, "macAppStore.sparkleBin: unknown key");
  });
});
