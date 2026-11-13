import { describe, expect, test } from "bun:test";
import { githubHost, hostFor, r2Host } from "./mac-host.ts";

const files = {
  build: "42",
  archives: ["/b/updates/programa-macos-42.dmg", "/b/updates/Programa42-41.delta"],
  history: "/b/appcast-42.xml",
  appcast: "/b/updates/appcast.xml",
  alias: "/b/alias/programa-macos.dmg",
};
const github = { type: "github" as const, repo: "darkroomengineering/programa", tag: "rolling" };
const latest = "https://github.com/darkroomengineering/programa/releases/latest/download/appcast.xml";

describe("the GitHub release host", () => {
  test("archives download from the release's tag", () => {
    expect(githubHost(github, latest).downloadPrefix).toBe(
      "https://github.com/darkroomengineering/programa/releases/download/rolling/",
    );
  });

  test("uploads archives, then the history copy, then the appcast, then the stable alias", () => {
    expect(
      githubHost(github, latest)
        .uploads(files)
        .map((command) => command.argv),
    ).toEqual([
      [
        "gh",
        "release",
        "upload",
        "rolling",
        "/b/updates/programa-macos-42.dmg",
        "/b/updates/Programa42-41.delta",
        "--repo",
        "darkroomengineering/programa",
      ],
      ["gh", "release", "upload", "rolling", "/b/appcast-42.xml", "--repo", "darkroomengineering/programa"],
      [
        "gh",
        "release",
        "upload",
        "rolling",
        "/b/updates/appcast.xml",
        "--repo",
        "darkroomengineering/programa",
        "--clobber",
      ],
      [
        "gh",
        "release",
        "upload",
        "rolling",
        "/b/alias/programa-macos.dmg",
        "--repo",
        "darkroomengineering/programa",
        "--clobber",
      ],
    ]);
  });

  test("never overwrites an archive: only the appcast and the alias clobber", () => {
    const uploads = githubHost(github, latest).uploads(files);
    expect(uploads.map((command) => command.argv.includes("--clobber"))).toEqual([false, false, true, true]);
  });

  test("a beta-channel build uploads no alias; promote uploads the alias, then the appcast", () => {
    const host = githubHost(github, latest);
    const { alias, ...beta } = files;
    expect(host.uploads(beta)).toEqual(host.uploads(files).slice(0, -1));
    expect(host.promoteUploads({ appcast: files.appcast, alias })).toEqual(host.uploads(files).slice(-2).reverse());
  });

  test("checks the release is public, and that it is the latest when the feed reads the latest release", () => {
    const [view, newest] = githubHost(github, latest).checks();
    expect(view?.argv).toEqual([
      "gh",
      "release",
      "view",
      "rolling",
      "--repo",
      "darkroomengineering/programa",
      "--json",
      "isDraft",
      "--jq",
      ".isDraft",
    ]);
    expect(view?.problem("false\n")).toBeUndefined();
    expect(view?.problem("true")).toContain("is a draft");
    expect(newest?.argv).toEqual([
      "gh",
      "api",
      "repos/darkroomengineering/programa/releases/latest",
      "--jq",
      ".tag_name",
    ]);
    expect(newest?.problem("rolling\n")).toBeUndefined();
    expect(newest?.problem("v0.6.0")).toBe(
      "the feed reads the latest release of darkroomengineering/programa, which is v0.6.0, not rolling",
    );
    const pinned = "https://github.com/darkroomengineering/programa/releases/download/rolling/appcast.xml";
    expect(githubHost(github, pinned).checks()).toHaveLength(1);
  });
});

describe("the R2 host", () => {
  const r2 = { type: "r2" as const, bucket: "browsee-updates", accountId: "acct", profile: "browsee-r2" };
  const feed = "https://updates.browsee.app/appcast.xml";

  test("serves archives from the feed's folder and uploads in the same order through aws", () => {
    const host = r2Host(r2, feed, {});
    expect(host.downloadPrefix).toBe("https://updates.browsee.app/");
    const uploads = host.uploads(files);
    expect(uploads.map((command) => command.argv.find((arg) => arg.startsWith("s3://")))).toEqual([
      "s3://browsee-updates/programa-macos-42.dmg",
      "s3://browsee-updates/Programa42-41.delta",
      "s3://browsee-updates/appcasts/appcast-42.xml",
      "s3://browsee-updates/appcast.xml",
      "s3://browsee-updates/programa-macos.dmg",
    ]);
    expect(uploads[0]?.argv.slice(0, 3)).toEqual(["aws", "--endpoint-url", "https://acct.r2.cloudflarestorage.com"]);
    expect(uploads[3]?.argv.slice(-2)).toEqual(["--cache-control", "no-cache"]);
    expect(uploads[0]?.env).toEqual({ AWS_DEFAULT_REGION: "auto", AWS_PROFILE: "browsee-r2" });
    expect(r2Host(r2, feed, { AWS_ACCESS_KEY_ID: "k" }).uploads(files)[0]?.env).toEqual({ AWS_DEFAULT_REGION: "auto" });
  });

  test("a beta-channel build uploads no alias; promote uploads the alias, then the appcast with no-cache", () => {
    const host = r2Host(r2, feed, {});
    const { alias, ...beta } = files;
    expect(host.uploads(beta)).toEqual(host.uploads(files).slice(0, -1));
    const promote = host.promoteUploads({ appcast: files.appcast, alias });
    expect(promote).toEqual(host.uploads(files).slice(-2).reverse());
    expect(promote.map((command) => command.argv.find((arg) => arg.startsWith("s3://")))).toEqual([
      "s3://browsee-updates/programa-macos.dmg",
      "s3://browsee-updates/appcast.xml",
    ]);
    expect(promote[1]?.argv.slice(-2)).toEqual(["--cache-control", "no-cache"]);
  });

  test("hostFor picks the adapter from the config", () => {
    const mac = { hosting: r2, feedUrl: feed } as Parameters<typeof hostFor>[0];
    expect(hostFor(mac, {}).downloadPrefix).toBe("https://updates.browsee.app/");
  });
});
