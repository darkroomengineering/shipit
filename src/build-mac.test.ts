import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { commandRunner, developerIdentity, type Runner, shellLine, shipMac } from "./build-mac.ts";
import { parseConfig, type ShipConfig } from "./config.ts";

const tmp = mkdtempSync(join(tmpdir(), "shipit-mac-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PUBLIC_KEY = "K4pw6WgryZqN0NI9t/FaNdroYWdSSuy2gejC3utPCQQ=";
const PREFIX = "https://github.com/darkroomengineering/programa/releases/download/rolling/";
const VERSION = "0.7.0";
const BUILD = "42875290832001001";

const appcast = (build: string) => `<rss><channel><item>
  <sparkle:version>${build}</sparkle:version>
  <sparkle:shortVersionString>0.6.0</sparkle:shortVersionString>
  <enclosure url="${PREFIX}programa-macos-${build}.dmg" sparkle:edSignature="c2ln"/>
</item></channel></rss>`;

/** The Programa fixture, with App Store Connect credentials from a test file so the plan does not depend on the Mac. */
function programa(changelog = `# Changelog\n\n## [${VERSION}] - 2026-11-11\n\n### Added\n- A real toolbar.\n`) {
  const worktree = mkdtempSync(join(tmp, "programa-"));
  writeFileSync(join(worktree, "CHANGELOG.md"), changelog);
  const credentials = join(worktree, "asc.env");
  writeFileSync(credentials, "ASC_KEY_ID=KEY123\nASC_ISSUER_ID=issuer-1\nKEY_PATH=/keys/AuthKey_KEY123.p8\n");
  const config = parseConfig(readFileSync(join(import.meta.dir, "fixtures", "programa.ship.json"), "utf8"), "/apps/x");
  return { worktree, config: { ...config, credentials } satisfies ShipConfig };
}

/** A real-run runner that records every command and answers the hosting checks as a ready release would. */
function recorder(
  answers: Record<string, string | Error> = {},
  effects: (argv: string[]) => void = () => undefined,
): Runner & { calls: string[] } {
  const calls: string[] = [];
  const table: Record<string, string | Error> = { isDraft: "false", "releases/latest": "rolling", ...answers };
  const answer = (argv: string[]) => {
    const found = Object.entries(table).find(([needle]) => argv.some((arg) => arg.includes(needle)))?.[1];
    if (found instanceof Error) throw found;
    return found ?? "";
  };
  return {
    dry: false,
    calls,
    async run(argv) {
      calls.push(argv.join(" "));
      effects(argv);
    },
    async capture(argv) {
      calls.push(argv.join(" "));
      return answer(argv);
    },
    note() {},
  };
}

describe("the dry-run plan for Programa", () => {
  test("prints every command in order and runs none", async () => {
    const { worktree, config } = programa();
    const lines: string[] = [];
    const result = await shipMac({
      config,
      worktree,
      version: VERSION,
      build: BUILD,
      dry: true,
      skipUpload: false,
      runner: commandRunner(true, (line) => lines.push(line)),
      dir: "/build",
      history: "/history",
      env: {},
      fetchText: async () => appcast("42875290831001002"),
      download: async () => {
        throw new Error("a dry run downloads nothing");
      },
    });
    expect(result.published).toBe(false);
    const app = "/build/Programa.app";
    const sign = `codesign --force --options runtime --timestamp --sign 'Developer ID Application (ZNHHMX2RP6)'`;
    const notary = "--key /keys/AuthKey_KEY123.p8 --key-id KEY123 --issuer issuer-1 --wait --output-format json";
    const upload = "gh release upload rolling";
    const repo = "--repo darkroomengineering/programa";
    const bin = "/build/DerivedData/SourcePackages/artifacts/sparkle/Sparkle/bin";
    const xcodebuild = `xcodebuild -scheme programa -configuration Release -derivedDataPath /build/DerivedData`;
    expect(lines.map((line) => line.replace(/^dry run: would (run )?/, ""))).toEqual([
      "gh release view rolling --repo darkroomengineering/programa --json isDraft --jq .isDraft",
      "gh api repos/darkroomengineering/programa/releases/latest --jq .tag_name",
      `(cd ${worktree} && ${xcodebuild} -resolvePackageDependencies > /build/resolve.log 2>&1)`,
      "security find-generic-password -s https://sparkle-project.org -a ed25519",
      `${bin}/generate_keys --account ed25519 -p`,
      `(cd ${worktree} && ${xcodebuild} -destination generic/platform=macOS -archivePath /build/programa-${VERSION}-${BUILD}.xcarchive archive MARKETING_VERSION=${VERSION} CURRENT_PROJECT_VERSION=${BUILD} ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO > /build/archive.log 2>&1)`,
      `ditto /build/programa-${VERSION}-${BUILD}.xcarchive/Products/Applications/Programa.app ${app}`,
      `/usr/libexec/PlistBuddy -c 'Set :SUFeedURL https://github.com/darkroomengineering/programa/releases/latest/download/appcast.xml' -c 'Set :SUPublicEDKey ${PUBLIC_KEY}' ${app}/Contents/Info.plist`,
      `plutil -convert json -o - ${app}/Contents/Info.plist`,
      "security find-identity -v -p codesigning",
      `${sign} --preserve-metadata=entitlements ${app}/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc`,
      `${sign} --preserve-metadata=entitlements ${app}/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc`,
      `${sign} ${app}/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate`,
      `${sign} ${app}/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app`,
      `${sign} ${app}/Contents/Frameworks/Sparkle.framework`,
      `${sign} ${app}/Contents/PlugIns/ProgramaDockTilePlugin.plugin`,
      `${sign} ${app}/Contents/Resources/bin/programa`,
      `${sign} ${app}/Contents/Resources/bin/programa-mcp`,
      `${sign} --entitlements ${worktree}/programa.entitlements ${app}`,
      `codesign --verify --deep --strict --verbose=2 ${app}`,
      `codesign -d --entitlements :- ${app}`,
      `codesign -d --entitlements :- ${app}/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc`,
      `codesign -d --entitlements :- ${app}/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc`,
      `codesign -d --entitlements :- ${app}/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate`,
      `codesign -d --entitlements :- ${app}/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app`,
      `codesign -d --entitlements :- ${app}/Contents/Frameworks/Sparkle.framework`,
      `codesign -d --entitlements :- ${app}/Contents/PlugIns/ProgramaDockTilePlugin.plugin`,
      `codesign -d --entitlements :- ${app}/Contents/Resources/bin/programa`,
      `codesign -d --entitlements :- ${app}/Contents/Resources/bin/programa-mcp`,
      `lipo -archs ${app}/Contents/MacOS/Programa`,
      `lipo -archs ${app}/Contents/Resources/bin/programa`,
      `ditto -c -k --sequesterRsrc --keepParent ${app} /build/Programa-notary.zip`,
      `xcrun notarytool submit /build/Programa-notary.zip ${notary}`,
      `xcrun stapler staple ${app}`,
      `xcrun stapler validate ${app}`,
      `spctl -a -vv --type execute ${app}`,
      "mkdir -p /build/dmg /build/updates",
      `ditto ${app} /build/dmg/Programa.app`,
      "ln -s /Applications /build/dmg/Applications",
      `hdiutil create -volname Programa -srcfolder /build/dmg -format UDZO -ov /build/updates/programa-macos-${BUILD}.dmg`,
      `codesign --force --timestamp --sign 'Developer ID Application (ZNHHMX2RP6)' /build/updates/programa-macos-${BUILD}.dmg`,
      `codesign --verify --strict /build/updates/programa-macos-${BUILD}.dmg`,
      `xcrun notarytool submit /build/updates/programa-macos-${BUILD}.dmg ${notary}`,
      `xcrun stapler staple /build/updates/programa-macos-${BUILD}.dmg`,
      `xcrun stapler validate /build/updates/programa-macos-${BUILD}.dmg`,
      `spctl --assess --type open --context context:primary-signature -vv /build/updates/programa-macos-${BUILD}.dmg`,
      "write the published appcast to /build/updates/appcast.xml",
      `download ${PREFIX}programa-macos-42875290831001002.dmg to /build/updates/programa-macos-42875290831001002.dmg for deltas`,
      `write /build/updates/programa-macos-${BUILD}.md from the ${VERSION} section of CHANGELOG.md`,
      `${bin}/generate_appcast --account ed25519 --download-url-prefix ${PREFIX} --maximum-deltas 1 --embed-release-notes /build/updates`,
      `keep the appcast as /build/appcast-${BUILD}.xml and /history/appcast-${BUILD}.xml`,
      `copy /build/updates/programa-macos-${BUILD}.dmg to /build/alias/programa-macos.dmg`,
      "upload, along with any .delta files generate_appcast made:",
      `${upload} /build/updates/programa-macos-${BUILD}.dmg ${repo}`,
      `${upload} /build/appcast-${BUILD}.xml ${repo}`,
      `${upload} /build/updates/appcast.xml ${repo} --clobber`,
      `${upload} /build/alias/programa-macos.dmg ${repo} --clobber`,
    ]);
  });

  test("a dry run reports what a real run would refuse, then keeps printing the plan", async () => {
    const { worktree, config } = programa();
    const lines: string[] = [];
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      await shipMac({
        config,
        worktree,
        version: VERSION,
        build: "202611121500",
        dry: true,
        skipUpload: false,
        runner: commandRunner(true, (line) => lines.push(line)),
        dir: "/build",
        history: "/history",
        env: {},
        fetchText: async () => appcast("42875290831001002"),
      });
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).toContain(
      "dry run: a real run stops here: build 202611121500 is not newer than the published build 42875290831001002",
    );
    expect(lines.at(-1)).toContain("gh release upload rolling /build/alias/programa-macos.dmg");
  });
});

describe("a real run refuses before building", () => {
  const run = (runner: Runner, options: { changelog?: string; env?: NodeJS.ProcessEnv; published?: string } = {}) => {
    const { worktree, config } = programa(options.changelog);
    return shipMac({
      config,
      worktree,
      version: VERSION,
      build: BUILD,
      dry: false,
      skipUpload: false,
      runner,
      dir: join(worktree, "build"),
      history: join(worktree, "history"),
      env: options.env ?? {},
      fetchText: async () => options.published ?? appcast("42875290831001002"),
    });
  };
  const built = (calls: string[]) => calls.some((call) => call.startsWith("xcodebuild"));

  test("when the build number is not higher than the published one", async () => {
    const runner = recorder();
    await expect(run(runner, { published: appcast(BUILD) })).rejects.toThrow(
      `build ${BUILD} is not newer than the published build ${BUILD}`,
    );
    expect(built(runner.calls)).toBe(false);
  });

  test("when CHANGELOG.md has no section for the version", async () => {
    const runner = recorder();
    await expect(run(runner, { changelog: "## [0.6.0]\n- older\n" })).rejects.toThrow(
      "CHANGELOG.md has no section for 0.7.0",
    );
    expect(built(runner.calls)).toBe(false);
  });

  test("when CI's SPARKLE_PRIVATE_KEY is not the app's key", async () => {
    const seed = generateKeyPairSync("ed25519")
      .privateKey.export({ format: "der", type: "pkcs8" })
      .subarray(-32)
      .toString("base64");
    const runner = recorder();
    await expect(run(runner, { env: { SPARKLE_PRIVATE_KEY: seed } })).rejects.toThrow(
      `is not the app's SUPublicEDKey ${PUBLIC_KEY}`,
    );
    expect(built(runner.calls)).toBe(false);
  });

  test("when the keychain's Sparkle key is not the app's key, before archiving", async () => {
    const runner = recorder({ generate_keys: "/v8xMtkp3VzK22CyAGfZTkbyW0u+5haIT+uEZ7nu970=\n" });
    await expect(run(runner)).rejects.toThrow(`is not the app's SUPublicEDKey ${PUBLIC_KEY}`);
    expect(runner.calls.some((call) => call.includes(" archive "))).toBe(false);
  });

  test("when the keychain has no Sparkle key, without ever calling generate_keys", async () => {
    const runner = recorder({ "find-generic-password": new Error("The specified item could not be found") });
    await expect(run(runner)).rejects.toThrow("no Sparkle private key for keychain account ed25519");
    expect(runner.calls.some((call) => call.includes("generate_keys"))).toBe(false);
  });

  test("when the hosting release is a draft", async () => {
    const runner = recorder({ isDraft: "true" });
    await expect(run(runner)).rejects.toThrow("the rolling release of darkroomengineering/programa is a draft");
    expect(built(runner.calls)).toBe(false);
  });
});

describe("a real run past preflight, with Apple's tools faked", () => {
  const OLD = "42875290831001002";
  const DELTA = `Programa${BUILD}-${OLD}.delta`;
  const REQUIRED = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.device.camera",
    "com.apple.security.device.audio-input",
    "com.apple.security.automation.apple-events",
  ];

  /** A runner whose tools leave the files the real ones would, and answer as a passing release would. */
  function apple(dir: string) {
    const app = join(dir, "Programa.app");
    const staging = join(dir, "updates");
    const info = {
      CFBundleIdentifier: "com.darkroom.programa",
      CFBundleShortVersionString: VERSION,
      CFBundleVersion: BUILD,
      CFBundleExecutable: "Programa",
      SUFeedURL: "https://github.com/darkroomengineering/programa/releases/latest/download/appcast.xml",
      SUPublicEDKey: PUBLIC_KEY,
      SURequireSignedFeed: true,
    };
    const generated = `<rss><channel>
<item><sparkle:version>${BUILD}</sparkle:version><sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
<enclosure url="${PREFIX}programa-macos-${BUILD}.dmg" sparkle:edSignature="bmV3"/></item>
</channel></rss>
<!-- sparkle-signatures:
edSignature: c2ln
-->`;
    return recorder(
      {
        generate_keys: `${PUBLIC_KEY}\n`,
        plutil: JSON.stringify(info),
        "find-identity": '  1) ABCD "Developer ID Application: Darkroom Engineering (ZNHHMX2RP6)"\n',
        notarytool: JSON.stringify({ id: "sub-1", status: "Accepted" }),
        lipo: "arm64\n",
      },
      (argv) => {
        const [tool] = argv;
        if (tool === "mkdir") for (const path of argv.slice(2)) mkdirSync(path, { recursive: true });
        if (tool === "ditto" && argv[2] === app) {
          for (const part of [
            "Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc",
            "Contents/PlugIns/ProgramaDockTilePlugin.plugin",
            "Contents/Resources/bin",
          ])
            mkdirSync(join(app, part), { recursive: true });
          for (const tool of ["programa", "programa-mcp"]) writeFileSync(join(app, "Contents/Resources/bin", tool), "");
        }
        if (tool === "hdiutil") writeFileSync(argv.at(-1) ?? "", "dmg");
        if (tool?.endsWith("generate_appcast")) {
          const channel = argv.includes("--channel")
            ? `<sparkle:channel>${argv[argv.indexOf("--channel") + 1]}</sparkle:channel>`
            : "";
          writeFileSync(join(staging, "appcast.xml"), generated.replace("<enclosure", `${channel}<enclosure`));
          writeFileSync(join(staging, DELTA), "delta");
        }
      },
    );
  }

  const plist = (keys: string[]) =>
    `<plist><dict>${keys.map((key) => `<key>${key}</key><true/>`).join("")}</dict></plist>`;
  const DOWNLOADER = "Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc";

  const ship = (
    skipUpload: boolean,
    downloaderEntitlements: string[] = ["com.apple.security.network.client"],
    betaChannel = false,
  ) => {
    const programaApp = programa();
    const { worktree } = programaApp;
    const config =
      betaChannel && programaApp.config.mac
        ? { ...programaApp.config, mac: { ...programaApp.config.mac, betaChannel } }
        : programaApp.config;
    const dir = join(worktree, "build");
    const runner = apple(dir);
    const capture = runner.capture.bind(runner);
    runner.capture = async (argv, options) => {
      if (argv[0] !== "codesign" || argv[1] !== "-d") return capture(argv, options);
      runner.calls.push(argv.join(" "));
      if (argv.at(-1) === join(dir, "Programa.app")) return plist(REQUIRED);
      if (argv.at(-1) === join(dir, "Programa.app", DOWNLOADER)) return plist(downloaderEntitlements);
      return "";
    };
    const downloaded: string[] = [];
    const result = shipMac({
      config,
      worktree,
      version: VERSION,
      build: BUILD,
      dry: false,
      skipUpload,
      runner,
      dir,
      history: join(worktree, "history"),
      env: {},
      fetchText: async () => appcast(OLD),
      download: async (url, file) => {
        downloaded.push(url);
        writeFileSync(file, "old dmg");
      },
    });
    return { result, runner, dir, worktree, downloaded };
  };

  test("--skip-upload notarizes and writes the appcast, keeps a copy, and uploads nothing", async () => {
    const { result, runner, dir, worktree, downloaded } = ship(true);
    expect((await result).published).toBe(false);
    expect(runner.calls.filter((call) => call.startsWith("xcrun notarytool submit"))).toHaveLength(2);
    expect(runner.calls.some((call) => call.startsWith("gh release upload"))).toBe(false);
    expect(downloaded).toEqual([`${PREFIX}programa-macos-${OLD}.dmg`]);
    expect(readFileSync(join(worktree, "history", `appcast-${BUILD}.xml`), "utf8")).toContain(BUILD);
    expect(readFileSync(join(dir, "alias", "programa-macos.dmg"), "utf8")).toBe("dmg");
    expect(readFileSync(join(dir, "updates", `programa-macos-${BUILD}.md`), "utf8")).toBe(
      "### Added\n- A real toolbar.\n",
    );
  });

  test("a full run uploads the new archives first and the appcast last, and never the downloaded archive", async () => {
    const { result, runner, dir } = ship(false);
    expect((await result).published).toBe(true);
    const repo = "--repo darkroomengineering/programa";
    expect(runner.calls.filter((call) => call.startsWith("gh release upload"))).toEqual([
      `gh release upload rolling ${dir}/updates/programa-macos-${BUILD}.dmg ${dir}/updates/${DELTA} ${repo}`,
      `gh release upload rolling ${dir}/appcast-${BUILD}.xml ${repo}`,
      `gh release upload rolling ${dir}/updates/appcast.xml ${repo} --clobber`,
      `gh release upload rolling ${dir}/alias/programa-macos.dmg ${repo} --clobber`,
    ]);
    expect(runner.calls.some((call) => call.includes("ABCD"))).toBe(true);
  });

  test("with betaChannel, the build goes to the beta channel and the stable download name stays put", async () => {
    const { result, runner, dir } = ship(false, undefined, true);
    expect((await result).published).toBe(true);
    expect(runner.calls.find((call) => call.includes("generate_appcast"))).toContain(" --channel beta ");
    const repo = "--repo darkroomengineering/programa";
    expect(runner.calls.filter((call) => call.startsWith("gh release upload"))).toEqual([
      `gh release upload rolling ${dir}/updates/programa-macos-${BUILD}.dmg ${dir}/updates/${DELTA} ${repo}`,
      `gh release upload rolling ${dir}/appcast-${BUILD}.xml ${repo}`,
      `gh release upload rolling ${dir}/updates/appcast.xml ${repo} --clobber`,
    ]);
    expect(existsSync(join(dir, "alias"))).toBe(false);
  });

  test("Sparkle's XPC services may keep their own entitlements, app-only ones included", async () => {
    const { result, runner } = ship(true, ["com.apple.security.network.client", "com.apple.security.cs.allow-jit"]);
    expect((await result).published).toBe(false);
    expect(runner.calls.some((call) => call.startsWith("codesign -d") && call.endsWith(DOWNLOADER))).toBe(true);
    expect(runner.calls.filter((call) => call.startsWith("xcrun notarytool submit"))).toHaveLength(2);
  });

  test("a Sparkle XPC service with a forbidden entitlement stops before notarization", async () => {
    const { result, runner } = ship(true, ["com.apple.security.cs.disable-library-validation"]);
    await expect(result).rejects.toThrow(
      `${DOWNLOADER} must not carry the entitlement com.apple.security.cs.disable-library-validation`,
    );
    expect(runner.calls.some((call) => call.startsWith("codesign -d") && call.endsWith(DOWNLOADER))).toBe(true);
    expect(runner.calls.some((call) => call.includes("notarytool"))).toBe(false);
  });

  test("an app missing a required entitlement stops before notarization", async () => {
    const { worktree, config } = programa();
    const dir = join(worktree, "build");
    const runner = apple(dir);
    await expect(
      shipMac({
        config,
        worktree,
        version: VERSION,
        build: BUILD,
        dry: false,
        skipUpload: true,
        runner,
        dir,
        history: join(worktree, "history"),
        env: {},
        fetchText: async () => undefined,
      }),
    ).rejects.toThrow("the app is missing the entitlement com.apple.security.cs.allow-jit");
    expect(runner.calls.some((call) => call.includes("notarytool"))).toBe(false);
  });
});

describe("a command build", () => {
  /** Programa built by a script instead of Xcode, the shape codigo's cargo build uses. */
  function scripted(sparkleBin?: string) {
    const { worktree, config } = programa();
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "programa.ship.json"), "utf8"));
    const { scheme: _, ...mac } = raw.mac;
    const parsed = parseConfig(
      JSON.stringify({
        ...raw,
        mac: { ...mac, kind: "command", build: "scripts/bundle.sh", app: "out/Programa.app", sparkleBin },
      }),
      "/apps/x",
    );
    return { worktree, config: { ...parsed, credentials: config.credentials } satisfies ShipConfig };
  }
  const plan = async (config: ShipConfig, worktree: string, env: NodeJS.ProcessEnv = {}) => {
    const lines: string[] = [];
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (line: string) => warnings.push(line);
    try {
      await shipMac({
        config,
        worktree,
        version: VERSION,
        build: BUILD,
        dry: true,
        skipUpload: false,
        runner: commandRunner(true, (line) => lines.push(line)),
        dir: "/build",
        history: "/history",
        env,
        fetchText: async () => appcast("42875290831001002"),
      });
    } finally {
      console.warn = original;
    }
    return { lines: lines.map((line) => line.replace(/^dry run: would (run )?/, "")), warnings };
  };

  test("runs the command from the repository root, then stamps the version and build itself", async () => {
    const { worktree, config } = scripted("~/Sparkle/bin");
    const { lines } = await plan(config, worktree);
    const app = "/build/Programa.app";
    const bin = join(homedir(), "Sparkle", "bin");
    expect(lines.slice(2, 8)).toEqual([
      "security find-generic-password -s https://sparkle-project.org -a ed25519",
      `${bin}/generate_keys --account ed25519 -p`,
      `(cd ${worktree} && SHIP_VERSION=${VERSION} SHIP_BUILD_NUMBER=${BUILD} bash -c scripts/bundle.sh > /build/build.log 2>&1)`,
      `ditto ${worktree}/out/Programa.app ${app}`,
      `/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString ${VERSION}' -c 'Set :CFBundleVersion ${BUILD}' -c 'Set :SUFeedURL https://github.com/darkroomengineering/programa/releases/latest/download/appcast.xml' -c 'Set :SUPublicEDKey ${PUBLIC_KEY}' ${app}/Contents/Info.plist`,
      `plutil -convert json -o - ${app}/Contents/Info.plist`,
    ]);
    expect(lines.some((line) => line.includes("xcodebuild"))).toBe(false);
    expect(lines.some((line) => line.startsWith(`${bin}/generate_appcast`))).toBe(true);
  });

  test("SPARKLE_BIN wins over mac.sparkleBin", async () => {
    const { worktree, config } = scripted("~/Sparkle/bin");
    const { lines } = await plan(config, worktree, { SPARKLE_BIN: "/opt/sparkle/bin" });
    expect(lines).toContain("/opt/sparkle/bin/generate_keys --account ed25519 -p");
  });

  test("without SPARKLE_BIN or mac.sparkleBin a real run refuses before building", async () => {
    const { worktree, config } = scripted();
    const runner = recorder();
    await expect(
      shipMac({
        config,
        worktree,
        version: VERSION,
        build: BUILD,
        dry: false,
        skipUpload: false,
        runner,
        dir: join(worktree, "build"),
        history: join(worktree, "history"),
        env: {},
        fetchText: async () => appcast("42875290831001002"),
      }),
    ).rejects.toThrow(
      "mac: a command build needs Sparkle's tools (generate_keys, generate_appcast); set SPARKLE_BIN or mac.sparkleBin",
    );
    expect(runner.calls.some((call) => call.startsWith("bash"))).toBe(false);
    const { warnings } = await plan(config, worktree);
    expect(warnings.join("\n")).toContain("a command build needs Sparkle's tools");
  });
});

describe("helpers", () => {
  test("developerIdentity finds the team's Developer ID", () => {
    const out = [
      '  1) AAAA "Apple Development: Someone (XXXXXXXXXX)"',
      '  2) BBBB "Developer ID Application: Darkroom Engineering (ZNHHMX2RP6)"',
      "     2 valid identities found",
    ].join("\n");
    expect(developerIdentity(out, "ZNHHMX2RP6")).toBe("BBBB");
    expect(developerIdentity(out, "OTHERTEAM1")).toBeUndefined();
  });

  test("shellLine quotes what the shell would split", () => {
    expect(
      shellLine(["codesign", "--sign", "Developer ID", "a b.app"], { env: { AWS_PROFILE: "p" }, cwd: "/x y" }),
    ).toBe("(cd '/x y' && AWS_PROFILE=p codesign --sign 'Developer ID' 'a b.app')");
  });
});
