import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { assertCurrentMain, git } from "../git.ts";
import { ci } from "./ci.ts";

const tmp = mkdtempSync(join(tmpdir(), "shipit-ci-"));
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

const shipJson = {
  name: "Demo",
  version: { file: "VERSION" },
  ios: { kind: "xcodegen", scheme: "D", bundleId: "a.b" },
};

/** A checkout of a temporary origin, at origin/main, plus a second clone to move main from. */
async function checkout(name: string, raw: object = shipJson) {
  const origin = join(tmp, `${name}.git`);
  const dir = join(tmp, name);
  await git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(dir);
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "ship.json"), JSON.stringify(raw));
  writeFileSync(join(dir, "VERSION"), "1.0.0\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "init");
  await git(dir, "remote", "add", "origin", origin);
  await git(dir, "push", "-q", "-u", "origin", "main");
  const other = join(tmp, `${name}-other`);
  await git(tmp, "clone", "-q", origin, other);
  const moveMain = async () => {
    await git(other, "commit", "-q", "--allow-empty", "-m", "newer");
    await git(other, "push", "-q", "origin", "main");
  };
  return { config: parseConfig(JSON.stringify(raw), dir), moveMain };
}

describe("ship ci refuses", () => {
  test("a checkout with uncommitted or untracked files", async () => {
    const { config } = await checkout("dirty");
    writeFileSync(join(config.root, "VERSION"), "1.0.1\n");
    await expect(ci(config, {})).rejects.toThrow("uncommitted or untracked files");
    await git(config.root, "checkout", "VERSION");
    writeFileSync(join(config.root, "scratch.txt"), "");
    await expect(ci(config, {})).rejects.toThrow("?? scratch.txt");
  });

  test("a HEAD that is not origin/main, after fetching", async () => {
    const { config, moveMain } = await checkout("behind");
    await moveMain();
    await expect(ci(config, {})).rejects.toThrow("ship ci releases only the current main");

    await git(config.root, "pull", "-q", "--ff-only");
    await git(config.root, "commit", "-q", "--allow-empty", "-m", "local only");
    await expect(ci(config, {})).rejects.toThrow("ship ci releases only the current main");
  });

  test("a repository with no origin", async () => {
    const { config } = await checkout("local");
    await git(config.root, "remote", "remove", "origin");
    await expect(ci(config, {})).rejects.toThrow("has no origin");
  });

  test("a target with no lane", async () => {
    const { config } = await checkout("mac", { ...shipJson, mac: { scheme: "D", bundleId: "a.b.mac" } });
    await expect(ci(config, {})).rejects.toThrow("mac: lane not implemented yet (INC-998/999/1000)");
    await expect(ci(config, { platform: "windows" })).rejects.toThrow("windows: lane not implemented yet");
  });
});

describe("on a clean origin/main", () => {
  test("runs the gates in order in the checkout, and a failing gate stops the run", async () => {
    const marker = join(tmp, "gates.log");
    const gates = [`pwd >> ${marker}`, "exit 3", `echo never >> ${marker}`];
    const { config } = await checkout("gates", { ...shipJson, gates });
    await expect(ci(config, {})).rejects.toThrow("bash -c exit 3 exited 3");
    expect(readFileSync(marker, "utf8")).toBe(`${realpathSync(config.root)}\n`);
  });
});

describe("the re-check before publishing", () => {
  test("passes while main is unchanged and fails once it moves", async () => {
    const { config, moveMain } = await checkout("moved");
    const sha = await git(config.root, "rev-parse", "HEAD");
    await assertCurrentMain(config.root, sha);
    await moveMain();
    await expect(assertCurrentMain(config.root, sha)).rejects.toThrow(
      `not ${sha.slice(0, 7)}; ship ci releases only the current main`,
    );
  });
});
