import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { builtPlatforms, git } from "../git.ts";
import { versionOfBuild } from "../notes.ts";
import { buildNumberFor, buildOf, runBuildNumber, versionCodeFor } from "../playlane.ts";
import { buildTags } from "./beta.ts";

const tmp = mkdtempSync(join(tmpdir(), "shipit-beta-"));
const saved = { ...process.env };

beforeAll(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "ship test",
    GIT_AUTHOR_EMAIL: "ship@example.com",
    GIT_COMMITTER_NAME: "ship test",
    GIT_COMMITTER_EMAIL: "ship@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
});

afterAll(() => {
  process.env = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const ios = { kind: "xcodegen", scheme: "D", bundleId: "a.b" };
const android = { package: "a.b", versionCodeProperty: "v" };
const at = new Date("2026-11-12T15:04:00Z");

describe("build tags", () => {
  test("a time-based run tags once, under the build Play's version code leads back to", () => {
    const build = buildNumberFor(at);
    const tags = buildTags({
      name: "Demo",
      version: "1.0.0",
      build,
      platforms: ["ios", "android"],
      versionCode: versionCodeFor(at),
    });
    expect(tags).toEqual([{ tag: `v1.0.0-${build}`, message: `Demo 1.0.0 build ${build} (ios + android)` }]);
    expect(buildOf(versionCodeFor(at))).toBe(build);
  });

  test("a githubRun run with Android also tags the bundle's time-based build, so releaseAndroid finds its notes", async () => {
    const config = parseConfig(
      JSON.stringify({ name: "Demo", version: { file: "VERSION" }, buildNumber: "githubRun", ios, android }),
      tmp,
    );
    const build = runBuildNumber(config, at, false, {
      GITHUB_RUN_ID: "43110817707",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_NAME: "push",
    });
    const code = versionCodeFor(at);
    expect(build).toBe("43110817707001001");
    const tags = buildTags({ name: "Demo", version: "1.0.0", build, platforms: ["ios", "android"], versionCode: code });
    expect(tags.map(({ tag }) => tag)).toEqual([`v1.0.0-${build}`, `v1.0.0-${buildOf(code)}`]);

    // The lookups releaseAndroid and ship release make, against a repository tagged the way ship beta tags it.
    const repo = join(tmp, "repo");
    await git(tmp, "init", "-q", "-b", "main", repo);
    await git(repo, "commit", "-q", "--allow-empty", "-m", "feat: a change");
    for (const { tag, message } of tags) await git(repo, "tag", "-a", tag, "HEAD", "-m", message);
    expect(await versionOfBuild(repo, buildOf(code))).toBe("1.0.0");
    expect(await versionOfBuild(repo, build)).toBe("1.0.0");
    expect([...(await builtPlatforms(repo, "HEAD"))].sort()).toEqual(["android", "ios"]);
  });

  test("no Android tag when the run built no Android bundle", () => {
    const tags = buildTags({ name: "Demo", version: "1.0.0", build: "43110817707001001", platforms: ["mac"] });
    expect(tags).toHaveLength(1);
    expect(
      buildTags({ name: "Demo", version: "1.0.0", build: "43110817707001001", platforms: ["mac"], versionCode: 1 }),
    ).toHaveLength(1);
  });
});
