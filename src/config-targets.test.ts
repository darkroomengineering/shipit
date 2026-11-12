import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LaneNotImplementedError, lanesFor, parseConfig } from "./config.ts";

const parse = (raw: unknown) => parseConfig(JSON.stringify(raw), "/apps/demo");
const base = { name: "Demo", version: { file: "VERSION" } };
const ios = { kind: "xcodegen", scheme: "Demo", bundleId: "a.b" };
const store = {
  scheme: "Demo",
  bundleId: "a.b.mac",
  entitlements: "Demo.entitlements",
  provisioningProfile: "Demo.provisionprofile",
};

describe("the real configs parse unchanged", () => {
  for (const name of ["nocam", "mareas", "pokefolio"]) {
    test(name, () => {
      const config = parseConfig(readFileSync(join(import.meta.dir, "fixtures", `${name}.ship.json`), "utf8"), "/a");
      expect(config.versionFiles).toEqual([]);
      expect(config.changelog).toBeNull();
      expect(config.secrets).toEqual([]);
      expect(config.gates).toEqual([]);
      expect([config.mac, config.macAppStore, config.windows, config.linux, config.tauri, config.npm]).toEqual(
        Array(6).fill(undefined),
      );
    });
  }
});

describe("new top-level fields", () => {
  test("accepts and types them", () => {
    const config = parse({
      ...base,
      ios,
      versionFiles: [
        { file: "package.json", json: "version" },
        { file: "project.yml", yaml: "settings.base.MARKETING_VERSION" },
        { file: "Cargo.toml", regex: '^version = "([0-9.]+)"' },
        { file: "VERSION" },
      ],
      changelog: "CHANGELOG.md",
      secrets: [
        {
          name: "Play service account",
          path: "~/.config/nocam/play-service-account.json",
          onePassword: "op://Incubator/nocam-play/credential",
          restoreHint: "Play Console, Setup, API access",
        },
        { name: "npm token", env: "NPM_TOKEN" },
      ],
      gates: ["bun run lint", "bun test"],
    });
    expect(config.versionFiles[2]).toEqual({ file: "Cargo.toml", regex: '^version = "([0-9.]+)"' });
    expect(config.versionFiles[3]).toEqual({ file: "VERSION" });
    expect(config.changelog).toBe("CHANGELOG.md");
    expect(config.secrets[0]?.onePassword).toBe("op://Incubator/nocam-play/credential");
    expect(config.secrets[1]).toEqual({ name: "npm token", env: "NPM_TOKEN", onePassword: null, restoreHint: null });
    expect(config.gates).toEqual(["bun run lint", "bun test"]);
  });

  test("rejects bad entries and unknown keys", () => {
    const rejects = (raw: object, message: string) => expect(() => parse({ ...base, ios, ...raw })).toThrow(message);
    rejects(
      { versionFiles: [{ file: "a", json: "v", regex: "(.)" }] },
      "versionFiles[0].: set one of json, yaml or regex",
    );
    rejects({ versionFiles: [{ file: "a", regex: "version" }] }, "versionFiles[0].regex: expected a valid pattern");
    rejects({ versionFiles: [{ file: "a", regex: "(" }] }, "versionFiles[0].regex: expected a valid pattern");
    rejects({ versionFiles: [{ file: "a", path: "v" }] }, "versionFiles[0].path: unknown key");
    rejects({ versionFiles: ["VERSION"] }, "versionFiles: expected an array of objects");
    rejects({ secrets: [{ name: "x" }] }, "secrets[0].: set exactly one of path or env");
    rejects({ secrets: [{ name: "x", path: "a", env: "B" }] }, "secrets[0].: set exactly one of path or env");
    rejects({ secrets: [{ name: "x", env: "B", restore: "y" }] }, "secrets[0].restore: unknown key");
    rejects({ changelog: 3 }, "changelog: expected a non-empty string or null");
    rejects({ gates: "bun test" }, "gates: expected an array of strings");
    rejects({ releases: [] }, "releases: unknown key");
  });
});

describe("target blocks without a lane", () => {
  test("accepts all three with their fields", () => {
    const config = parse({
      ...base,
      linux: { dir: "linux", copy: ["secrets.json"], checks: ["make test"] },
      tauri: { dir: "src-tauri" },
      npm: { package: "@darkroom/thing" },
    });
    expect(config.linux).toEqual({ dir: "linux", copy: ["secrets.json"], checks: ["make test"] });
    expect(parse({ ...base, linux: {} }).linux?.dir).toBe(".");
    expect(config.tauri?.dir).toBe("src-tauri");
    expect(config.npm?.package).toBe("@darkroom/thing");
    expect(config.ios).toBeUndefined();
  });

  test("rejects unknown keys and missing fields inside them", () => {
    expect(() => parse({ ...base, windows: { installer: "msi" } })).toThrow("windows.installer: unknown key");
    expect(() => parse({ ...base, mac: { scheme: "Demo" } })).toThrow("mac.bundleId: expected a non-empty string");
    expect(() => parse({ ...base, npm: {} })).toThrow("npm.package: expected a non-empty string");
    expect(() => parse({ ...base, linux: true })).toThrow("linux: expected an object");
  });

  test("a config with no target at all is still rejected", () => {
    expect(() => parse(base)).toThrow("targets: configure at least one platform (ios, android, mac, macAppStore,");
  });
});

describe("lanesFor", () => {
  const notImplemented = "lane not implemented yet (INC-998/999/1000)";

  test("existing platforms run as before", () => {
    const config = parse({ ...base, ios, android: { package: "a.b", versionCodeProperty: "v" } });
    expect(lanesFor(config)).toEqual(["ios", "android"]);
    expect(lanesFor(config, "android")).toEqual(["android"]);
    expect(() => lanesFor(parse({ ...base, ios }), "android")).toThrow("ship.json has no android section");
  });

  test("macAppStore has a lane", () => {
    const config = parse({ ...base, ios, macAppStore: store });
    expect(lanesFor(config)).toEqual(["ios", "macAppStore"]);
    expect(lanesFor(config, "macAppStore")).toEqual(["macAppStore"]);
    expect(() => lanesFor(parse({ ...base, ios }), "macAppStore")).toThrow("ship.json has no macAppStore section");
  });

  test("a target with no lane fails, configured or not", () => {
    const config = parse({ ...base, ios, linux: {} });
    expect(() => lanesFor(config, "linux")).toThrow(`linux: ${notImplemented}`);
    expect(() => lanesFor(config, "npm")).toThrow(LaneNotImplementedError);
  });

  test("running every target fails when one has no lane, and names the way out", () => {
    expect(() => lanesFor(parse({ ...base, ios, macAppStore: store, linux: {} }))).toThrow(
      `linux: ${notImplemented}; pass ios or macAppStore to ship only that`,
    );
    expect(() => lanesFor(parse({ ...base, tauri: {}, npm: { package: "x" } }))).toThrow(
      `tauri, npm: ${notImplemented}`,
    );
    expect(lanesFor(parse({ ...base, ios, linux: {} }), "ios")).toEqual(["ios"]);
  });
});
