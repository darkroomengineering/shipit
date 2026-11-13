import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRunner, type Runner } from "../build-mac.ts";
import { parseConfig } from "../config.ts";
import { promote, releaseMac, runPromote } from "./promote.ts";

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
  test("moves the newest beta to everyone: the edited appcast, then its DMG under the stable name", async () => {
    const { dir, downloaded, config, options } = setup(feed(entry("7", "beta"), entry("6", "beta"), entry("5")));
    const runner = recorder();
    await runPromote(config, { ...options, dry: false, runner });
    expect(downloaded).toEqual([`${PREFIX}Demo-7.dmg`]);
    expect(readFileSync(join(dir, "appcast.xml"), "utf8")).toBe(feed(entry("7"), entry("6", "beta"), entry("5")));
    expect(readFileSync(join(dir, "alias", "Demo.dmg"), "utf8")).toBe(`dmg of ${PREFIX}Demo-7.dmg`);
    expect(runner.calls).toEqual([
      `gh release upload rolling ${dir}/appcast.xml --repo acme/demo --clobber`,
      `gh release upload rolling ${dir}/alias/Demo.dmg --repo acme/demo --clobber`,
    ]);
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
      `dry run: would run gh release upload rolling ${dir}/appcast.xml --repo acme/demo --clobber`,
      `dry run: would run gh release upload rolling ${dir}/alias/Demo.dmg --repo acme/demo --clobber`,
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
    await expect(promote(config(), { platform: "windows", dry: true })).rejects.toThrow(
      "no beta channel for windows yet; INC-1003 tracks it",
    );
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
