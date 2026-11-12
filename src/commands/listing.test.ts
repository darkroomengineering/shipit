import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { git } from "../git.ts";
import { listing } from "./listing.ts";

const tmp = mkdtempSync(join(tmpdir(), "shipit-listing-command-"));
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

test("a listing over the limits is refused before credentials are read or a store is called", async () => {
  const dir = join(tmp, "app");
  mkdirSync(dir);
  const shipJson = {
    name: "Demo",
    version: { file: "VERSION" },
    // Reading this missing file would fail with "does not exist", so the error below proves it was never read.
    credentials: join(tmp, "missing.env"),
    ios: { kind: "xcodegen", scheme: "D", bundleId: "a.b", listing: "listing.json" },
    android: { package: "a.b", versionCodeProperty: "v", playKey: join(tmp, "missing.json") },
  };
  writeFileSync(join(dir, "ship.json"), JSON.stringify(shipJson));
  writeFileSync(join(dir, "VERSION"), "1.0.0\n");
  writeFileSync(
    join(dir, "listing.json"),
    JSON.stringify({ name: "x".repeat(31), play: { shortDescription: "y".repeat(81) } }),
  );
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "init");

  const config = parseConfig(JSON.stringify(shipJson), dir);
  const run = listing(config, { dry: false });
  await expect(run).rejects.toThrow("listing.json would be refused");
  await expect(run).rejects.toThrow("ios: name is 31 characters; App Store Connect allows 30");
  await expect(run).rejects.toThrow("android: shortDescription is 81 characters; Google Play allows 80");
});
