import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { githubRunBuild } from "./playlane.ts";
import {
  appcastItems,
  appcastProblems,
  architectureProblem,
  changelogSection,
  enclosureName,
  entitlementProblems,
  newestArchives,
  preflightProblems,
  publicKeyFromPrivate,
  publishedBuild,
} from "./sparkle.ts";

const PREFIX = "https://github.com/darkroomengineering/programa/releases/download/rolling/";

const item = (build: string, version = "0.7.0", signature = "c2ln") => `
    <item>
      <title>${version}</title>
      <sparkle:version>${build}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <enclosure url="${PREFIX}programa-macos-${build}.dmg" length="1" type="application/octet-stream" sparkle:edSignature="${signature}"/>
    </item>`;
const appcast = (...builds: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${builds.map((build) => item(build)).join("")}</channel></rss>`;

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.7.0] - 2026-11-11

### Added
- A real toolbar.

## [0.6.0] - 2026-11-07

- Storage button.
`;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  return { seed, pub };
}

describe("appcast reading", () => {
  test("reads items, and the highest build as a BigInt past Number's safe range", () => {
    const xml = appcast("41883068665001001", "42875290831001002", "41317508079001001");
    expect(appcastItems(xml)[0]).toEqual({
      version: "41883068665001001",
      shortVersion: "0.7.0",
      url: `${PREFIX}programa-macos-41883068665001001.dmg`,
      edSignature: "c2ln",
    });
    expect(publishedBuild(xml)).toBe("42875290831001002");
    expect(newestArchives(xml, 2)).toEqual([
      `${PREFIX}programa-macos-42875290831001002.dmg`,
      `${PREFIX}programa-macos-41883068665001001.dmg`,
    ]);
    expect(newestArchives(xml, 0)).toEqual([]);
  });

  test("reads the older enclosure-attribute form", () => {
    const xml = '<item><enclosure url="https://u/a.dmg" sparkle:version="12" sparkle:shortVersionString="1.0"/></item>';
    expect(appcastItems(xml)[0]?.version).toBe("12");
    expect(publishedBuild("<rss></rss>")).toBeUndefined();
  });
});

describe("changelogSection", () => {
  test("takes Keep a Changelog and plain headings, up to the next version", () => {
    expect(changelogSection(CHANGELOG, "0.7.0")).toBe("### Added\n- A real toolbar.");
    expect(changelogSection("## 0.3.0\n\n- Tabs\n\n## 0.2.0\n- Old", "0.3.0")).toBe("- Tabs");
    expect(changelogSection("## v1.0.0\n- First", "1.0.0")).toBe("- First");
  });

  test("a missing or empty section, or a version that only prefixes another, is no section", () => {
    expect(changelogSection(CHANGELOG, "0.8.0")).toBeUndefined();
    expect(changelogSection("## 0.7.0\n\n## 0.6.0\n- x", "0.7.0")).toBeUndefined();
    expect(changelogSection("## 0.7.10\n- x", "0.7.1")).toBeUndefined();
  });
});

describe("publicKeyFromPrivate", () => {
  test("derives SUPublicEDKey from a 32-byte seed, with or without base64 padding", () => {
    const { seed, pub } = keyPair();
    expect(publicKeyFromPrivate(seed)).toBe(pub);
    expect(publicKeyFromPrivate(seed.replace(/=+$/, ""))).toBe(pub);
  });

  test("reads the older 96-byte form and rejects other lengths", () => {
    const { pub } = keyPair();
    const legacy = Buffer.concat([Buffer.alloc(64, 7), Buffer.from(pub, "base64")]).toString("base64");
    expect(publicKeyFromPrivate(legacy)).toBe(pub);
    expect(() => publicKeyFromPrivate(Buffer.alloc(16).toString("base64"))).toThrow("16 bytes; expected 32 or 96");
  });
});

describe("preflight refuses", () => {
  const { seed, pub } = keyPair();
  const ok = {
    version: "0.7.0",
    build: "42875290832001001",
    changelog: CHANGELOG,
    changelogFile: "CHANGELOG.md",
    published: appcast("42875290831001002"),
    signingKey: pub,
    publicKey: pub,
  };

  test("nothing when every gate passes, and a first release has no published build", () => {
    expect(preflightProblems(ok)).toEqual([]);
    expect(preflightProblems({ ...ok, published: undefined })).toEqual([]);
  });

  test("a build number that is not higher than the published one", () => {
    expect(preflightProblems({ ...ok, build: "42875290831001002" })).toEqual([
      "build 42875290831001002 is not newer than the published build 42875290831001002; installed copies would never update",
    ]);
    // A 12-digit time build sorts below Programa's 17-digit run builds, so it is refused too.
    expect(preflightProblems({ ...ok, build: "202611121500" })[0]).toContain("is not newer than the published build");
    expect(preflightProblems({ ...ok, build: "1.2" })[0]).toContain("is not a whole number");
  });

  test("a missing changelog section, or no changelog at all", () => {
    expect(preflightProblems({ ...ok, version: "0.8.0" })).toEqual([
      "CHANGELOG.md has no section for 0.8.0; write the release notes first",
    ]);
    expect(preflightProblems({ ...ok, changelog: undefined })).toEqual(["CHANGELOG.md is missing"]);
  });

  test("a signing key that does not match the app's SUPublicEDKey", () => {
    const other = publicKeyFromPrivate(keyPair().seed);
    expect(preflightProblems({ ...ok, signingKey: other })).toEqual([
      `the Sparkle private key's public key ${other} is not the app's SUPublicEDKey ${pub}; installed copies would reject the update`,
    ]);
    expect(publicKeyFromPrivate(seed)).toBe(pub);
  });
});

describe("appcastProblems", () => {
  const expected = { build: "5", version: "0.7.0", url: `${PREFIX}programa-macos-5.dmg`, signedFeed: true };
  const signed = `${appcast("4", "5")}\n<!-- sparkle-signatures:\nedSignature: x\n-->`;

  test("passes a signed item at the per-build URL in a signed feed", () => {
    expect(appcastProblems(signed, expected)).toEqual([]);
  });

  test("refuses a missing item, a wrong URL or version, no signature, or an unsigned feed", () => {
    expect(appcastProblems(signed, { ...expected, build: "6" })).toEqual(["the appcast has no item for build 6"]);
    expect(appcastProblems(signed, { ...expected, url: `${PREFIX}programa-macos.dmg`, version: "0.7.1" })).toEqual([
      "the item for build 5 is version 0.7.0, not 0.7.1",
      `the item for build 5 downloads ${PREFIX}programa-macos-5.dmg, not ${PREFIX}programa-macos.dmg`,
    ]);
    expect(appcastProblems(signed.replace(/sparkle:edSignature="c2ln"/g, ""), expected)).toEqual([
      "the item for build 5 has no sparkle:edSignature",
    ]);
    expect(appcastProblems(appcast("5"), expected)).toEqual([
      "the app requires a signed feed and the appcast carries no feed signature",
    ]);
    expect(appcastProblems(appcast("5"), { ...expected, signedFeed: false })).toEqual([]);
  });
});

describe("release gates", () => {
  const plist = (...keys: string[]) =>
    `<plist><dict>${keys.map((key) => `<key>${key}</key><true/>`).join("")}</dict></plist>`;
  const rules = {
    required: ["com.apple.security.cs.allow-jit", "com.apple.security.device.camera"],
    forbidden: ["com.apple.security.cs.disable-library-validation"],
  };
  const app = { path: "Programa.app", entitlements: plist(...rules.required), ownEntitlements: true };

  test("entitlements: required on the app, app-only off plain nested code, forbidden everywhere", () => {
    expect(
      entitlementProblems(app, [{ path: "bin/programa", entitlements: "", ownEntitlements: false }], rules),
    ).toEqual([]);
    expect(
      entitlementProblems(
        { ...app, entitlements: plist("com.apple.security.cs.allow-jit", ...rules.forbidden) },
        [
          { path: "bin/programa", entitlements: plist("com.apple.security.device.camera"), ownEntitlements: false },
          { path: "Helper (GPU).app", entitlements: plist("com.apple.security.cs.allow-jit"), ownEntitlements: true },
          { path: "Helper (Plugin).app", entitlements: plist(...rules.forbidden), ownEntitlements: true },
        ],
        rules,
      ),
    ).toEqual([
      "the app is missing the entitlement com.apple.security.device.camera",
      "the app must not carry the entitlement com.apple.security.cs.disable-library-validation",
      "bin/programa must not carry the entitlement com.apple.security.device.camera",
      "Helper (Plugin).app must not carry the entitlement com.apple.security.cs.disable-library-validation",
    ]);
  });

  test("architectures must match exactly", () => {
    expect(architectureProblem("Contents/MacOS/Programa", "arm64\n", ["arm64"])).toBeUndefined();
    expect(architectureProblem("x", "x86_64 arm64", ["arm64", "x86_64"])).toBeUndefined();
    expect(architectureProblem("x", "x86_64 arm64", ["arm64"])).toBe("x holds arm64 x86_64, expected arm64");
  });

  test("the per-build archive name keeps the stable name's base", () => {
    expect(enclosureName("programa-macos.dmg", "42")).toBe("programa-macos-42.dmg");
    expect(enclosureName("Browsee.dmg", "7")).toBe("Browsee-7.dmg");
  });
});

describe("githubRunBuild (Programa's release_build_identity.js)", () => {
  test("workflow_run builds bind to the upstream run, and each release attempt is distinct", () => {
    const base = { event: "workflow_run", upstreamRunId: "41883068665", upstreamRunAttempt: "17", runId: "9" };
    expect(githubRunBuild({ ...base, runAttempt: "1" })).toBe("41883068665017001");
    expect(githubRunBuild({ ...base, runAttempt: "2" })).toBe("41883068665017002");
  });

  test("push reruns reuse one build; manual runs use the attempt", () => {
    expect(githubRunBuild({ event: "push", runId: "42", runAttempt: "1" })).toBe("42001001");
    expect(githubRunBuild({ event: "push", runId: "42", runAttempt: "2" })).toBe("42001001");
    expect(githubRunBuild({ event: "workflow_dispatch", runId: "42", runAttempt: "9" })).toBe("42001009");
  });

  test("rejects malformed ids, attempts over 999 and other events", () => {
    expect(() => githubRunBuild({ event: "push", runId: "042", runAttempt: "1" })).toThrow("GITHUB_RUN_ID");
    expect(() => githubRunBuild({ event: "push", runId: "42", runAttempt: "1000" })).toThrow("between 1 and 999");
    expect(() => githubRunBuild({ event: "schedule", runId: "42", runAttempt: "1" })).toThrow("unsupported");
    expect(() => githubRunBuild({ event: "workflow_run", runId: "42", runAttempt: "1" })).toThrow("upstream run id");
  });
});
