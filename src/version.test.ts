import { describe, expect, test } from "bun:test";
import type { VersionSpec } from "./config.ts";
import { bump, isBump, readVersion, writeVersion } from "./version.ts";

const plain: VersionSpec = { file: "VERSION" };
const yaml: VersionSpec = { file: "project.yml", yaml: "settings.base.MARKETING_VERSION" };
const json: VersionSpec = { file: "apps/mobile/app.json", json: "expo.version" };

const projectYml = `name: Mareas
settings:
  base:
    SWIFT_VERSION: "6.0"
    MARKETING_VERSION: "1.1.1"
    CURRENT_PROJECT_VERSION: "1"
targets:
  Mareas:
    info:
      properties:
        CFBundleShortVersionString: $(MARKETING_VERSION)
`;

const appJson = `{
  "expo": {
    "name": "Pokefolio",
    "version": "1.0.0",
    "ios": { "bundleIdentifier": "com.arzafran.pokefolio" }
  }
}
`;

describe("plain version file", () => {
  test("reads the trimmed contents", () => expect(readVersion(plain, "1.0.7\n")).toBe("1.0.7"));
  test("stamps the new version with a trailing newline", () =>
    expect(writeVersion(plain, "1.0.7\n", "1.0.8")).toBe("1.0.8\n"));
});

describe("YAML version", () => {
  test("reads the quoted value", () => expect(readVersion(yaml, projectYml)).toBe("1.1.1"));

  test("stamps only that key and keeps quotes, comments and the rest of the file", () => {
    const next = writeVersion(yaml, projectYml, "1.2.0");
    expect(next).toBe(projectYml.replace('MARKETING_VERSION: "1.1.1"', 'MARKETING_VERSION: "1.2.0"'));
    expect(next).toContain("$(MARKETING_VERSION)");
  });

  test("keeps an unquoted value unquoted and a trailing comment", () => {
    const text = "settings:\n  base:\n    MARKETING_VERSION: 2.0 # store\n";
    expect(readVersion(yaml, text)).toBe("2.0");
    expect(writeVersion(yaml, text, "2.0.1")).toBe("settings:\n  base:\n    MARKETING_VERSION: 2.0.1 # store\n");
  });

  test("stamps every line that carries the key", () => {
    const text = 'base:\n  MARKETING_VERSION: "1.0.0"\ntargets:\n  Widget:\n    MARKETING_VERSION: "1.0.0"\n';
    expect(writeVersion(yaml, text, "1.0.1").match(/1\.0\.1/g)).toHaveLength(2);
  });
});

describe("JSON version", () => {
  test("reads a dotted path", () => expect(readVersion(json, appJson)).toBe("1.0.0"));

  test("stamps in place and keeps the formatting", () =>
    expect(writeVersion(json, appJson, "1.0.1")).toBe(appJson.replace('"version": "1.0.0"', '"version": "1.0.1"')));

  test("rewrites the document when the old value appears twice, keeping the indent", () => {
    const text = '{\n    "expo": { "version": "1.0.0", "runtime": { "version": "1.0.0" } }\n}\n';
    const next = JSON.parse(writeVersion(json, text, "1.1.0")) as {
      expo: { version: string; runtime: { version: string } };
    };
    expect(next.expo.version).toBe("1.1.0");
    expect(next.expo.runtime.version).toBe("1.0.0");
    expect(writeVersion(json, text, "1.1.0")).toStartWith('{\n    "expo"');
  });
});

describe("invalid versions", () => {
  test("throw with the file and path", () => {
    expect(() => readVersion(plain, "latest\n")).toThrow(
      'VERSION: expected a version such as 1.2.3 at the file, found "latest"',
    );
    expect(() => readVersion(json, '{"expo":{"version":3}}')).toThrow("at expo.version, found undefined");
    expect(() => readVersion(yaml, "name: x\n")).toThrow("at settings.base.MARKETING_VERSION");
  });
});

describe("bump", () => {
  test("patch, minor and major", () => {
    expect(bump("1.2.3", "patch")).toBe("1.2.4");
    expect(bump("1.2.3", "minor")).toBe("1.3.0");
    expect(bump("1.2.3", "major")).toBe("2.0.0");
    expect(bump("2.0", "patch")).toBe("2.0.1");
  });

  test("isBump accepts only the three kinds", () => {
    expect(["patch", "minor", "major", "build", ""].filter(isBump)).toEqual(["patch", "minor", "major"]);
  });
});
