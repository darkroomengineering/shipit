import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config.ts";
import { git, proposeVersion } from "./git.ts";

const tmp = mkdtempSync(join(tmpdir(), "shipit-git-"));
const ghLog = join(tmp, "gh.log");
const ghOpen = join(tmp, "gh-open-pr");
const saved = { ...process.env };

beforeAll(() => {
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  // Stands in for gh: records each call; `pr list` prints the open PR's URL, `pr create` opens one.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "${ghLog}"
case "$1 $2" in
  "pr list") cat "${ghOpen}" 2>/dev/null || true ;;
  "pr create") echo https://github.com/example/app/pull/7 | tee "${ghOpen}" ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
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

async function repo(name: string, remote: boolean) {
  const dir = join(tmp, name);
  mkdirSync(dir);
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "VERSION"), "1.0.0\n");
  await git(dir, "add", "VERSION");
  await git(dir, "commit", "-qm", "init");
  if (remote) {
    const origin = join(tmp, `${name}.git`);
    await git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    await git(dir, "remote", "add", "origin", origin);
    await git(dir, "push", "-q", "origin", "main");
  }
  const config = { name, version: { file: "VERSION" }, ios: { kind: "xcodegen", scheme: "A", bundleId: "a.b" } };
  return parseConfig(JSON.stringify(config), dir);
}

describe("proposeVersion", () => {
  test("pushes a branch and opens one pull request, leaving main alone", async () => {
    const config = await repo("remote-app", true);
    const ghCalls = () => readFileSync(ghLog, "utf8").trim().split("\n");

    expect(await proposeVersion(config, "1.0.1")).toBe(true);
    expect(await git(config.root, "show", "origin/main:VERSION")).toBe("1.0.0");
    await git(config.root, "fetch", "-q", "origin", "ship/version-1.0.1");
    expect(await git(config.root, "show", "FETCH_HEAD:VERSION")).toBe("1.0.1");
    expect(await git(config.root, "log", "-1", "--format=%s", "FETCH_HEAD")).toBe("chore: start version 1.0.1");
    expect(ghCalls().filter((call) => call.startsWith("pr create"))).toHaveLength(1);

    // A later beta, with the pull request still open, opens nothing new and did not start the version.
    expect(await proposeVersion(config, "1.0.1")).toBe(false);
    expect(ghCalls().filter((call) => call.startsWith("pr create"))).toHaveLength(1);

    // The pull request was closed, or creating it failed after the push: the existing branch gets a new one.
    rmSync(ghOpen);
    expect(await proposeVersion(config, "1.0.1")).toBe(false);
    expect(ghCalls().filter((call) => call.startsWith("pr create"))).toHaveLength(2);
    expect(await git(config.root, "show", "origin/main:VERSION")).toBe("1.0.0");
  });

  test("a repository with no remote commits to its local main", async () => {
    const config = await repo("local-app", false);
    expect(await proposeVersion(config, "1.0.1")).toBe(true);
    expect(await git(config.root, "show", "main:VERSION")).toBe("1.0.1");
    expect(readFileSync(join(config.root, "VERSION"), "utf8")).toBe("1.0.1\n");
  });
});
