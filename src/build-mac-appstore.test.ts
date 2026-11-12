import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRunner, type Runner, type StepOptions } from "./build-mac.ts";
import { shipMacAppStore, uploadProblem } from "./build-mac-appstore.ts";
import { parseConfig, type ShipConfig } from "./config.ts";

const tmp = mkdtempSync(join(tmpdir(), "shipit-appstore-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const VERSION = "0.1.0";
const BUILD = "202611121730";
const IDENTITIES = `  1) AAAA "Developer ID Application: Darkroom Engineering LLC (ZNHHMX2RP6)"
  2) BBBB "Apple Distribution: Darkroom Engineering LLC (ZNHHMX2RP6)"
  3) CCCC "3rd Party Mac Developer Installer: Darkroom Engineering LLC (ZNHHMX2RP6)"
     3 valid identities found`;

/** The codigo example, with its profile and App Store Connect key in a temporary folder. */
function codigo() {
  const worktree = mkdtempSync(join(tmp, "codigo-"));
  const credentials = join(worktree, "asc.env");
  writeFileSync(credentials, "KEY_ID=KEY123\nISSUER_ID=issuer-1\nKEY_PATH=/keys/AuthKey_KEY123.p8\n");
  const profile = join(worktree, "codigo.provisionprofile");
  writeFileSync(profile, "profile");
  const config = parseConfig(readFileSync(join(import.meta.dir, "fixtures", "codigo.ship.json"), "utf8"), worktree);
  const store = config.macAppStore;
  if (!store) throw new Error("the codigo fixture has no macAppStore section");
  return {
    worktree,
    profile,
    config: {
      ...config,
      credentials,
      macAppStore: { ...store, provisioningProfile: profile },
    } satisfies ShipConfig,
  };
}

const ENV = { APPLE_TEAM_ID: "ZNHHMX2RP6" };

describe("the dry-run plan for codigo", () => {
  test("prints every command in order and runs none", async () => {
    const { worktree, profile, config } = codigo();
    const lines: string[] = [];
    const result = await shipMacAppStore({
      config,
      worktree,
      version: VERSION,
      build: BUILD,
      dry: true,
      skipUpload: false,
      runner: commandRunner(true, (line) => lines.push(line)),
      dir: "/build",
      env: ENV,
    });
    expect(result.uploaded).toBe(false);
    const app = "/build/codigo.app";
    const plist = `${app}/Contents/Info.plist`;
    const pkg = `/build/codigo-${VERSION}-${BUILD}.pkg`;
    const auth = "-t macos --api-key KEY123 --api-issuer issuer-1 --p8-file-path /keys/AuthKey_KEY123.p8";
    expect(lines.map((line) => line.replace(/^dry run: would (run )?/, ""))).toEqual([
      "security find-identity -v",
      `(cd ${worktree} && SHIP_VERSION=${VERSION} SHIP_BUILD_NUMBER=${BUILD} bash -c scripts/bundle.sh > /build/build.log 2>&1)`,
      `ditto ${worktree}/target/release/codigo.app ${app}`,
      `cp ${profile} ${app}/Contents/embedded.provisionprofile`,
      `cp ${worktree}/assets/appstore/PrivacyInfo.xcprivacy ${app}/Contents/Resources/PrivacyInfo.xcprivacy`,
      `plutil -replace CFBundleDisplayName -string codigo ${plist}`,
      `plutil -replace CFBundleInfoDictionaryVersion -string 6.0 ${plist}`,
      `plutil -replace CFBundleSupportedPlatforms -json '["MacOSX"]' ${plist}`,
      `plutil -replace LSMinimumSystemVersion -string 13.0 ${plist}`,
      `plutil -replace ITSAppUsesNonExemptEncryption -bool false ${plist}`,
      `plutil -replace NSHumanReadableCopyright -string 'Copyright 2026 Darkroom Engineering LLC' ${plist}`,
      `plutil -replace CFBundleShortVersionString -string ${VERSION} ${plist}`,
      `plutil -replace CFBundleVersion -string ${BUILD} ${plist}`,
      `plutil -lint ${plist}`,
      `plutil -convert json -o - ${plist}`,
      `codesign --force --options runtime --timestamp --sign 'Apple Distribution (ZNHHMX2RP6)' --entitlements ${worktree}/assets/appstore/codigo.entitlements ${app}`,
      `xattr -r -d com.apple.quarantine ${app}`,
      `codesign --verify --strict --verbose=2 ${app}`,
      `lipo -archs ${app}/Contents/MacOS/codigo`,
      `productbuild --component ${app} /Applications --sign '3rd Party Mac Developer Installer (ZNHHMX2RP6)' ${pkg}`,
      `xattr -d com.apple.quarantine ${pkg}`,
      `pkgutil --check-signature ${pkg}`,
      `xcrun altool --validate-app ${pkg} ${auth} > /build/validate.log 2>&1`,
      `xcrun altool --upload-package ${pkg} --wait ${auth} > /build/upload.log 2>&1`,
    ]);
  });

  test("an Xcode build archives unsigned, as the mac lane does", async () => {
    const { worktree, config } = codigo();
    const store = config.macAppStore;
    const xcode = {
      ...store,
      kind: "xcodegen" as const,
      scheme: "codigo",
      dir: "mac",
    };
    const lines: string[] = [];
    await shipMacAppStore({
      config: { ...config, macAppStore: xcode },
      worktree,
      version: VERSION,
      build: BUILD,
      dry: true,
      skipUpload: false,
      runner: commandRunner(true, (line) => lines.push(line)),
      dir: "/build",
      env: ENV,
    });
    const plan = lines.map((line) => line.replace(/^dry run: would (run )?/, ""));
    expect(plan.slice(1, 4)).toEqual([
      `(cd ${worktree}/mac && xcodegen generate)`,
      `(cd ${worktree}/mac && xcodebuild -scheme codigo -configuration Release -derivedDataPath /build/DerivedData -destination generic/platform=macOS -archivePath /build/codigo-${VERSION}-${BUILD}.xcarchive archive MARKETING_VERSION=${VERSION} CURRENT_PROJECT_VERSION=${BUILD} ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO > /build/archive.log 2>&1)`,
      `ditto /build/codigo-${VERSION}-${BUILD}.xcarchive/Products/Applications/codigo.app /build/codigo.app`,
    ]);
  });
});

describe("altool's output", () => {
  test("names the lines that say App Store Connect refused the package", () => {
    expect(uploadProblem("No errors uploading 'codigo.pkg'\nBUILD-STATUS: COMPLETE")).toBeUndefined();
    for (const line of [
      "*** Error: UPLOAD FAILED with 1 error",
      "BUILD-STATUS: FAILED",
      "IMPORT-STATUS: FAILED",
      "ERROR ITMS-90296: App sandbox not enabled.",
    ])
      expect(uploadProblem(`Uploading...\n${line}\n`)).toContain(line);
  });
});

describe("a real run with Apple's tools faked", () => {
  interface Fakes {
    /** What altool writes to its log for each step; it always exits 0. */
    validate?: string;
    upload?: string;
    /** The built app's Info.plist as plutil prints it. */
    info?: Record<string, string>;
    /** The build command leaves the app behind. */
    builds?: boolean;
    skipUpload?: boolean;
  }

  /** Ships the codigo example with a runner whose tools succeed and leave what the real ones would. */
  function ship(fakes: Fakes = {}) {
    const { worktree, profile, config } = codigo();
    const calls: string[] = [];
    const runner: Runner = {
      dry: false,
      async run(argv: string[], options: StepOptions = {}) {
        calls.push(argv.join(" "));
        if (argv[0] === "bash" && fakes.builds !== false)
          mkdirSync(join(worktree, "target", "release", "codigo.app"), { recursive: true });
        if (argv[1] === "altool" && options.logFile)
          writeFileSync(options.logFile, (argv.includes("--validate-app") ? fakes.validate : fakes.upload) ?? "");
      },
      async capture(argv: string[]) {
        calls.push(argv.join(" "));
        if (argv[0] === "security") return IDENTITIES;
        if (argv[0] === "lipo") return "arm64\n";
        if (argv.includes("json"))
          return JSON.stringify(
            fakes.info ?? { CFBundleIdentifier: "dev.darkroom.codigo", CFBundleExecutable: "codigo" },
          );
        return "";
      },
      note() {},
    };
    const result = () =>
      shipMacAppStore({
        config,
        worktree,
        version: VERSION,
        build: BUILD,
        dry: false,
        skipUpload: fakes.skipUpload ?? false,
        runner,
        dir: join(worktree, "build"),
        env: ENV,
      });
    return { worktree, profile, calls, result };
  }

  test("fails when altool exits 0 but its output says the upload failed", async () => {
    const { result } = ship({
      validate: "No errors validating archive at 'codigo.pkg'",
      upload: "UPLOAD SUCCEEDED\nBUILD-STATUS: FAILED\nERROR ITMS-90296: App sandbox not enabled.",
    });
    await expect(result()).rejects.toThrow(
      "App Store Connect refused the package:\nBUILD-STATUS: FAILED\nERROR ITMS-90296: App sandbox not enabled.",
    );
  });

  test("fails when validation passes with exit 0 but reports an upload error", async () => {
    const { calls, result } = ship({ validate: "*** Error: UPLOAD FAILED with 1 error" });
    await expect(result()).rejects.toThrow("UPLOAD FAILED");
    expect(calls.some((call) => call.includes("--upload-package"))).toBe(false);
  });

  test("signs with the keychain's store identities by name and uploads", async () => {
    const { worktree, calls, result } = ship({ upload: "UPLOAD SUCCEEDED\nBUILD-STATUS: COMPLETE" });
    expect((await result()).uploaded).toBe(true);
    expect(calls).toContain(
      `codesign --force --options runtime --timestamp --sign Apple Distribution: Darkroom Engineering LLC (ZNHHMX2RP6) --entitlements ${worktree}/assets/appstore/codigo.entitlements ${worktree}/build/codigo.app`,
    );
    expect(calls.some((call) => call.includes("--sign 3rd Party Mac Developer Installer: Darkroom"))).toBe(true);
    expect(calls.at(-1)).toContain("xcrun altool --upload-package");
  });

  test("--skip-upload stops after validation", async () => {
    const { calls, result } = ship({ skipUpload: true });
    expect((await result()).uploaded).toBe(false);
    expect(calls.at(-1)).toContain("xcrun altool --validate-app");
    expect(calls.some((call) => call.includes("--upload-package"))).toBe(false);
  });

  test("refuses an app with another bundle id before signing", async () => {
    const { calls, result } = ship({ info: { CFBundleIdentifier: "dev.darkroom.other" } });
    await expect(result()).rejects.toThrow(
      'codigo.app has CFBundleIdentifier "dev.darkroom.other", expected dev.darkroom.codigo',
    );
    expect(calls.some((call) => call.startsWith("codesign"))).toBe(false);
  });

  test("refuses a missing provisioning profile before building", async () => {
    const { profile, calls, result } = ship();
    rmSync(profile);
    await expect(result()).rejects.toThrow(`macAppStore.provisioningProfile: ${profile} does not exist`);
    expect(calls).toEqual([]);
  });

  test("a build that leaves no app fails and names its log", async () => {
    const { result } = ship({ builds: false });
    await expect(result()).rejects.toThrow("macAppStore.app: the build left no target/release/codigo.app");
  });
});
