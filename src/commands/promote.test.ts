import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRunner, type Runner } from "../build-mac.ts";
import { parseConfig } from "../config.ts";
import { NothingToPromoteError } from "../sparkle.ts";
import { promote, releaseMac, releaseWindows, runPromote, runPromoteWindows } from "./promote.ts";

const tmp = mkdtempSync(join(tmpdir(), "shipit-promote-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PREFIX = "https://github.com/acme/demo/releases/download/rolling/";
const FEED = "https://github.com/acme/demo/releases/latest/download/appcast.xml";
const mac = {
  scheme: "Demo",
  bundleId: "a.b.mac",
  feedUrl: FEED,
  publicKey: "K4pw6WgryZqN0NI9t/FaNdroYWdSSuy2gejC3utPCQQ=",
  dmg: "Demo.dmg",
  betaChannel: true,
  hosting: { type: "github", repo: "acme/demo", tag: "rolling" },
};
const config = (overrides: object = {}) =>
  parseConfig(
    JSON.stringify({ name: "PromoteDemo", version: { file: "VERSION" }, mac: { ...mac, ...overrides } }),
    "/apps/promote-demo",
  );

const entry = (build: string, channel?: string, prefix = PREFIX) => `
        <item>
            <sparkle:version>${build}</sparkle:version>
            <sparkle:shortVersionString>1.${build}</sparkle:shortVersionString>${channel ? `\n            <sparkle:channel>${channel}</sparkle:channel>` : ""}
            <enclosure url="${prefix}Demo-${build}.dmg" length="1" type="application/octet-stream" sparkle:edSignature="c2ln"/>
        </item>`;
const feed = (...entries: string[]) => `<rss><channel>${entries.join("")}\n</channel></rss>\n`;

function recorder(): Runner & { calls: string[] } {
  const calls: string[] = [];
  return {
    dry: false,
    calls,
    async run(argv) {
      calls.push(argv.join(" "));
    },
    async capture(argv) {
      calls.push(argv.join(" "));
      return "";
    },
    note() {},
  };
}

function setup(published: string | undefined, overrides: object = {}) {
  const dir = mkdtempSync(join(tmp, "run-"));
  const downloaded: string[] = [];
  return {
    dir,
    downloaded,
    config: config(overrides),
    options: {
      dir,
      env: {},
      fetchText: async (url: string) => (url === FEED ? published : undefined),
      download: async (url: string, file: string) => {
        downloaded.push(url);
        writeFileSync(file, `dmg of ${url}`);
      },
    },
  };
}

describe("ship promote mac", () => {
  test("moves the newest beta to everyone: its DMG under the stable name, then the edited appcast", async () => {
    const { dir, downloaded, config, options } = setup(feed(entry("7", "beta"), entry("6", "beta"), entry("5")));
    const runner = recorder();
    await runPromote(config, { ...options, dry: false, runner });
    expect(downloaded).toEqual([`${PREFIX}Demo-7.dmg`]);
    expect(readFileSync(join(dir, "appcast.xml"), "utf8")).toBe(feed(entry("7"), entry("6", "beta"), entry("5")));
    expect(readFileSync(join(dir, "alias", "Demo.dmg"), "utf8")).toBe(`dmg of ${PREFIX}Demo-7.dmg`);
    expect(runner.calls).toEqual([
      `gh release upload rolling ${dir}/alias/Demo.dmg --repo acme/demo --clobber`,
      `gh release upload rolling ${dir}/appcast.xml --repo acme/demo --clobber`,
    ]);
  });

  test("promote takes and releases the lock and runs the same steps for mac, the default platform", async () => {
    const { dir, downloaded, config, options } = setup(feed(entry("7", "beta"), entry("5")));
    const runner = recorder();
    await promote(config, { ...options, dry: false, runner });
    expect(downloaded).toEqual([`${PREFIX}Demo-7.dmg`]);
    expect(runner.calls).toEqual([
      `gh release upload rolling ${dir}/alias/Demo.dmg --repo acme/demo --clobber`,
      `gh release upload rolling ${dir}/appcast.xml --repo acme/demo --clobber`,
    ]);
    // The lock is released, so a second run can take it.
    await promote(config, { ...options, platform: "mac", dry: false, runner: recorder(), build: "7" });
  });

  test("--build promotes that build", async () => {
    const { dir, downloaded, config, options } = setup(feed(entry("7", "beta"), entry("6", "beta"), entry("5")));
    await runPromote(config, { ...options, dry: false, runner: recorder(), build: "6" });
    expect(downloaded).toEqual([`${PREFIX}Demo-6.dmg`]);
    expect(readFileSync(join(dir, "appcast.xml"), "utf8")).toBe(feed(entry("7", "beta"), entry("6"), entry("5")));
  });

  test("a dry run prints every command and downloads, writes and uploads nothing", async () => {
    const { dir, downloaded, config, options } = setup(feed(entry("7", "beta"), entry("5")));
    rmSync(dir, { recursive: true });
    const lines: string[] = [];
    await runPromote(config, { ...options, dry: true, runner: commandRunner(true, (line) => lines.push(line)) });
    expect(downloaded).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(lines).toEqual([
      `dry run: would write the appcast with 7 on the default channel to ${dir}/appcast.xml`,
      `dry run: would download ${PREFIX}Demo-7.dmg to ${dir}/Demo-7.dmg and copy it to ${dir}/alias/Demo.dmg`,
      `dry run: would run gh release upload rolling ${dir}/alias/Demo.dmg --repo acme/demo --clobber`,
      `dry run: would run gh release upload rolling ${dir}/appcast.xml --repo acme/demo --clobber`,
    ]);
  });

  test("refuses an archive outside the hosting, before downloading or uploading", async () => {
    const elsewhere = "https://example.com/files/";
    const { downloaded, config, options } = setup(feed(entry("7", "beta", elsewhere), entry("5")));
    const runner = recorder();
    await expect(runPromote(config, { ...options, dry: false, runner })).rejects.toThrow(
      `build 7 downloads ${elsewhere}Demo-7.dmg, which is outside ${PREFIX}`,
    );
    expect(downloaded).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  test("refuses an app without betaChannel, a feed that is not there, and other platforms", async () => {
    const off = setup(feed(entry("7", "beta")), { betaChannel: false });
    await expect(runPromote(off.config, { ...off.options, dry: false, runner: recorder() })).rejects.toThrow(
      "mac.betaChannel is off, so every build already goes straight to everyone",
    );
    const missing = setup(undefined);
    await expect(runPromote(missing.config, { ...missing.options, dry: false, runner: recorder() })).rejects.toThrow(
      `no appcast at ${FEED} yet`,
    );
    await expect(promote(config(), { platform: "ios", dry: true })).rejects.toThrow("no beta channel for ios");
  });

  test("refuses when nothing on the beta channel is newer than the default channel", async () => {
    const { config, options } = setup(feed(entry("7", "beta"), entry("8")));
    const runner = recorder();
    await expect(runPromote(config, { ...options, dry: false, runner })).rejects.toThrow(
      "nothing newer than the default channel to promote",
    );
    expect(runner.calls).toEqual([]);
  });
});

describe("ship release's mac step", () => {
  test("promotes the newest beta", async () => {
    const { dir, config, options } = setup(feed(entry("7", "beta"), entry("5")));
    const runner = recorder();
    await releaseMac(config, { ...options, dry: false, runner });
    expect(runner.calls).toHaveLength(2);
    expect(readFileSync(join(dir, "appcast.xml"), "utf8")).toBe(feed(entry("7"), entry("5")));
  });

  test("a second run with nothing new to promote succeeds and uploads nothing", async () => {
    const { config, options } = setup(feed(entry("7"), entry("5")));
    const runner = recorder();
    await releaseMac(config, { ...options, dry: false, runner });
    expect(runner.calls).toEqual([]);
  });

  test("other refusals still fail the release", async () => {
    const signed = `${feed(entry("7", "beta"), entry("5"))}<!-- sparkle-signatures:\nedSignature: x\n-->\n`;
    const { config, options } = setup(signed);
    await expect(releaseMac(config, { ...options, dry: false, runner: recorder() })).rejects.toThrow(
      "signed feeds can't be promoted yet",
    );
  });

  test("a dry run warns about a refusal instead of failing, and uploads nothing", async () => {
    const signed = `${feed(entry("7", "beta"), entry("5"))}<!-- sparkle-signatures:\nedSignature: x\n-->\n`;
    const { downloaded, config, options } = setup(signed);
    const runner = recorder();
    await releaseMac(config, { ...options, dry: true, runner });
    expect(downloaded).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  test("promotes nothing after --skip-upload, or for an app without betaChannel", async () => {
    const runner = recorder();
    const fetched: string[] = [];
    const fetchText = async (url: string) => {
      fetched.push(url);
      return feed(entry("7", "beta"));
    };
    await releaseMac(config(), { dry: false, runner, fetchText, skipUpload: true });
    await releaseMac(config({ betaChannel: false }), { dry: false, runner, fetchText });
    expect(fetched).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
});

const windows = {
  publish: "dotnet publish App.csproj -o publish",
  publishDir: "publish",
  packId: "Demo",
  mainExe: "Demo.exe",
  vpk: "1.2.161",
  betaChannel: true,
  release: { repo: "acme/demo-releases", tag: "rolling" },
};
const windowsConfig = (overrides: object = {}) =>
  parseConfig(
    JSON.stringify({ name: "PromoteDemo", version: { file: "VERSION" }, windows: { ...windows, ...overrides } }),
    "/apps/promote-demo",
  );
const GH = "--repo acme/demo-releases";
const staged = (build: string) => [
  `Demo-1.0.${build}-${build}-x64-setup.exe`,
  `Demo-1.0.${build}-build.${build}-full.nupkg`,
  `Demo-1.0.${build}-build.${build}-beta-full.nupkg`,
  `Demo-${build}-staged-RELEASES`,
  `Demo-${build}-staged-assets.win.json`,
  `Demo-${build}-staged-releases.win.json`,
];
const liveIndex = (...builds: string[]) =>
  JSON.stringify({
    Assets: builds.map((build) => ({
      PackageId: "Demo",
      Version: `1.0.${build}-build.${build}`,
      Type: "Full",
      FileName: `Demo-1.0.${build}-build.${build}-full.nupkg`,
    })),
  });

/** Records commands and, like gh, writes each asset a `gh release download --dir` names. */
function ghRecorder(): Runner & { calls: string[] } {
  const runner = recorder();
  return {
    ...runner,
    async run(argv) {
      runner.calls.push(argv.join(" "));
      if (argv[2] !== "download") return;
      const dir = argv[argv.indexOf("--dir") + 1] ?? "";
      argv.forEach((arg, i) => {
        if (arg === "--pattern") writeFileSync(join(dir, argv[i + 1] ?? ""), `asset ${argv[i + 1]}`);
      });
    },
  };
}

function windowsSetup(assets: string[], live: string | undefined, overrides: object = {}) {
  const dir = mkdtempSync(join(tmp, "windows-"));
  const reads: string[] = [];
  return {
    dir,
    reads,
    config: windowsConfig(overrides),
    options: {
      dir,
      ghOutput: async (argv: string[]) => {
        reads.push(argv.join(" "));
        if (argv[2] === "view") return JSON.stringify({ assets: assets.map((name) => ({ name, size: 1 })) });
        if (argv.includes("releases.win.json") && live !== undefined) return live;
        throw new Error(`unexpected read ${argv.join(" ")}`);
      },
    },
  };
}
const published = (build: string) => ["Demo-x64-setup.exe", "RELEASES", "releases.win.json", ...staged(build)];

describe("ship promote windows", () => {
  test("moves the newest staged build to everyone: installer name, then RELEASES, then releases.win.json", async () => {
    const { dir, reads, config, options } = windowsSetup(
      [...published("507"), ...staged("508"), ...staged("509")],
      liveIndex("507"),
    );
    const runner = ghRecorder();
    await runPromoteWindows(config, { ...options, dry: false, runner });
    expect(reads).toEqual([
      `gh release view rolling --json assets ${GH}`,
      `gh release download rolling --pattern releases.win.json --output - ${GH}`,
    ]);
    expect(runner.calls).toEqual([
      `gh release download rolling --pattern Demo-509-staged-RELEASES --pattern Demo-509-staged-assets.win.json --pattern Demo-509-staged-releases.win.json --pattern Demo-1.0.509-509-x64-setup.exe --dir ${dir}/download ${GH}`,
      `gh release upload rolling ${dir}/Demo-x64-setup.exe --clobber ${GH}`,
      `gh release upload rolling ${dir}/RELEASES ${dir}/assets.win.json --clobber ${GH}`,
      `gh release upload rolling ${dir}/releases.win.json --clobber ${GH}`,
    ]);
    expect(readFileSync(join(dir, "releases.win.json"), "utf8")).toBe("asset Demo-509-staged-releases.win.json");
    expect(readFileSync(join(dir, "RELEASES"), "utf8")).toBe("asset Demo-509-staged-RELEASES");
    expect(readFileSync(join(dir, "Demo-x64-setup.exe"), "utf8")).toBe("asset Demo-1.0.509-509-x64-setup.exe");
  });

  test("--build promotes that build, and promote takes the lock for windows", async () => {
    const { dir, config, options } = windowsSetup(
      [...published("507"), ...staged("508"), ...staged("509")],
      liveIndex("507"),
    );
    const runner = ghRecorder();
    await promote(config, { ...options, platform: "windows", dry: false, runner, build: "508" });
    expect(runner.calls[0]).toContain(
      "--pattern Demo-508-staged-releases.win.json --pattern Demo-1.0.508-508-x64-setup.exe",
    );
    expect(readFileSync(join(dir, "Demo-x64-setup.exe"), "utf8")).toBe("asset Demo-1.0.508-508-x64-setup.exe");
  });

  test("the first promote, with no stable feed on the release yet, goes ahead", async () => {
    const { reads, config, options } = windowsSetup(staged("508"), undefined);
    const runner = ghRecorder();
    await runPromoteWindows(config, { ...options, dry: false, runner });
    expect(reads).toEqual([
      `gh release view rolling --json assets ${GH}`,
      `gh release download rolling --pattern releases.win.json --output - ${GH}`,
    ]);
    expect(runner.calls.at(-1)).toEndWith(`/releases.win.json --clobber ${GH}`);
  });

  test("reads the stable feed even when the asset list leaves it out, and refuses an older staged build", async () => {
    const { config, options } = windowsSetup(staged("508"), liveIndex("509"));
    const runner = ghRecorder();
    await expect(runPromoteWindows(config, { ...options, dry: false, runner })).rejects.toThrow(
      "build 508 is not newer than 509 on the win channel",
    );
    expect(runner.calls).toEqual([]);
  });

  test("a dry run reads the release, prints every command and downloads, writes and uploads nothing", async () => {
    const { dir, config, options } = windowsSetup([...published("507"), ...staged("508")], liveIndex("507"));
    rmSync(dir, { recursive: true });
    const lines: string[] = [];
    await runPromoteWindows(config, { ...options, dry: true, runner: commandRunner(true, (line) => lines.push(line)) });
    expect(existsSync(dir)).toBe(false);
    expect(lines).toEqual([
      `dry run: would run gh release download rolling --pattern Demo-508-staged-RELEASES --pattern Demo-508-staged-assets.win.json --pattern Demo-508-staged-releases.win.json --pattern Demo-1.0.508-508-x64-setup.exe --dir ${dir}/download ${GH}`,
      `dry run: would rename Demo-508-staged-RELEASES to RELEASES, Demo-508-staged-assets.win.json to assets.win.json, Demo-508-staged-releases.win.json to releases.win.json and copy Demo-1.0.508-508-x64-setup.exe to Demo-x64-setup.exe, in ${dir}`,
      `dry run: would run gh release upload rolling ${dir}/Demo-x64-setup.exe --clobber ${GH}`,
      `dry run: would run gh release upload rolling ${dir}/RELEASES ${dir}/assets.win.json --clobber ${GH}`,
      `dry run: would run gh release upload rolling ${dir}/releases.win.json --clobber ${GH}`,
    ]);
  });

  test("refuses when no staged build is newer than the stable feed, and uploads nothing", async () => {
    for (const [assets, live, message] of [
      [published("509"), liveIndex("509"), "build 509 is not newer than 509 on the win channel"],
      [["releases.win.json", ...staged("508")], liveIndex("509"), "build 508 is not newer than 509 on the win channel"],
      [
        ["Demo-x64-setup.exe", "releases.win.json"],
        liveIndex("509"),
        "the rolling release has no staged build to promote",
      ],
    ] as const) {
      const { config, options } = windowsSetup([...assets], live);
      const runner = ghRecorder();
      const promoted = runPromoteWindows(config, { ...options, dry: false, runner });
      await expect(promoted).rejects.toThrow(message);
      await expect(promoted).rejects.toBeInstanceOf(NothingToPromoteError);
      expect(runner.calls).toEqual([]);
    }
  });

  test("refuses a build with a missing staged feed, installer or package, and a stable feed it can't read", async () => {
    const without = (name: string) => staged("508").filter((asset) => asset !== name);
    const cases: [string[], string | undefined, string, string?][] = [
      [without("Demo-508-staged-releases.win.json"), undefined, "build 508 has no Demo-508-staged-releases.win.json"],
      [without("Demo-1.0.508-508-x64-setup.exe"), undefined, "build 508 has no Demo-<version>-508-x64-setup.exe"],
      [without("Demo-1.0.508-build.508-full.nupkg"), undefined, "build 508 has no Demo-1.0.508-build.508-full.nupkg"],
      [staged("508"), undefined, "the rolling release has no staged files for build 7", "7"],
      [staged("508"), undefined, "--build 50x is not a build number", "50x"],
      [
        [...staged("508"), "releases.win.json"],
        JSON.stringify({ Assets: [{ Version: "1.0.0" }] }),
        "names no <version>-build.<build> version",
      ],
    ];
    for (const [assets, live, message, build] of cases) {
      const { config, options } = windowsSetup(assets, live);
      const runner = ghRecorder();
      await expect(runPromoteWindows(config, { ...options, dry: false, runner, build })).rejects.toThrow(message);
      expect(runner.calls).toEqual([]);
    }
  });

  test("refuses an app without windows.betaChannel", async () => {
    const { reads, config, options } = windowsSetup(staged("508"), undefined, { betaChannel: false });
    await expect(runPromoteWindows(config, { ...options, dry: false, runner: ghRecorder() })).rejects.toThrow(
      "windows.betaChannel is off, so every build already goes straight to everyone",
    );
    expect(reads).toEqual([]);
  });

  test("removes its own temporary folder", async () => {
    const { config, options } = windowsSetup(staged("508"), undefined);
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("shipit-promotedemo-promote-windows-"));
    await runPromoteWindows(config, { ...options, dir: undefined, dry: false, runner: ghRecorder() });
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("shipit-promotedemo-promote-windows-"));
    expect(after).toEqual(before);
  });
});

describe("ship release's windows step", () => {
  test("promotes the newest staged build", async () => {
    const { config, options } = windowsSetup([...published("507"), ...staged("508")], liveIndex("507"));
    const runner = ghRecorder();
    await releaseWindows(config, { ...options, dry: false, runner });
    expect(runner.calls).toHaveLength(4);
  });

  test("a quiet night with nothing new to promote succeeds and uploads nothing", async () => {
    const { config, options } = windowsSetup(published("508"), liveIndex("508"));
    const runner = ghRecorder();
    await releaseWindows(config, { ...options, dry: false, runner });
    expect(runner.calls).toEqual([]);
  });

  test("other refusals fail the release, and a dry run only warns about them", async () => {
    const assets = staged("508").filter((asset) => asset !== "Demo-508-staged-releases.win.json");
    const { config, options } = windowsSetup(assets, undefined);
    await expect(releaseWindows(config, { ...options, dry: false, runner: ghRecorder() })).rejects.toThrow(
      "build 508 has no Demo-508-staged-releases.win.json",
    );
    const runner = ghRecorder();
    await releaseWindows(config, { ...options, dry: true, runner });
    expect(runner.calls).toEqual([]);
  });

  test("reads nothing for an app without betaChannel", async () => {
    const { reads, config, options } = windowsSetup(staged("508"), undefined, { betaChannel: false });
    const runner = ghRecorder();
    await releaseWindows(config, { ...options, dry: false, runner });
    expect(reads).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
});
