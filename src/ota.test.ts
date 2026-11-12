import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { update } from "./commands/update.ts";
import { parseConfig, type ShipConfig } from "./config.ts";
import { git } from "./git.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "shipit-ota-")));
const calls = join(tmp, "calls.log");
const saved = { ...process.env };
const PRODUCTION = "https://prod.example.com";

// Each test runs a dozen git processes and a fetch; on a loaded machine that passes the 5 s default.
setDefaultTimeout(30_000);

const updateConfig = {
  channel: "production",
  environment: "production",
  easCli: "eas-cli@23.1.0",
  nativeInputs: ["apps/mobile/modules/*/ios/**", "apps/mobile/app.json", "package.json"],
  envCheck: { key: "EXPO_PUBLIC_API_URL", value: PRODUCTION },
};
const shipJson = (extra: Record<string, unknown> = {}) => ({
  name: "Demo",
  version: { file: "apps/mobile/app.json", json: "expo.version" },
  ios: { kind: "expo", dir: "apps/mobile/ios", scheme: "Demo", bundleId: "a.b", update: updateConfig, ...extra },
});

beforeAll(async () => {
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  // Stand in for bunx (eas-cli) and bun (install): each records its folder and arguments.
  for (const name of ["bunx", "bun"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $(pwd -P) $*" >> "${calls}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: "ship test",
    GIT_AUTHOR_EMAIL: "ship@example.com",
    GIT_COMMITTER_NAME: "ship test",
    GIT_COMMITTER_EMAIL: "ship@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  await makeTemplate();
});

afterAll(() => {
  process.env = saved;
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => rmSync(calls, { force: true }));

const recorded = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);

function put(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

const appJson = (runtime: string, version = "1.0.0") =>
  `${JSON.stringify({ expo: { name: "Demo", version, runtimeVersion: runtime } }, null, 2)}\n`;

async function commit(root: string, files: Record<string, string>, message: string, push = true) {
  for (const [file, text] of Object.entries(files)) put(root, file, text);
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", message);
  if (push) await git(root, "push", "-q", "origin", "main");
}

const template = join(tmp, "template");

/** An expo app whose runtimeVersion was set after its native module, pushed to a bare origin beside it. */
async function makeTemplate() {
  const root = join(template, "repo");
  mkdirSync(root, { recursive: true });
  await git(root, "init", "-q", "-b", "main");
  await git(template, "init", "-q", "--bare", "-b", "main", "origin.git");
  // Relative, so a copy of the folder pushes to its own copy of the remote.
  await git(root, "remote", "add", "origin", "../origin.git");
  put(root, ".gitignore", "apps/mobile/.env.local\n");
  put(root, "apps/mobile/modules/cam/ios/Cam.swift", "// v1\n");
  put(root, "src/index.ts", "export const a = 1;\n");
  await commit(root, { "apps/mobile/app.json": appJson("1.0.0") }, "init");
  await commit(root, { "apps/mobile/app.json": appJson("1.0.1") }, "chore: bump runtimeVersion");
  await commit(root, { "src/index.ts": "export const a = 2;\n" }, "feat: js change");
}

let count = 0;
/** A fresh copy of the template app. */
function app(): ShipConfig {
  const dir = join(tmp, `app-${++count}`);
  cpSync(template, dir, { recursive: true });
  return parseConfig(JSON.stringify(shipJson()), join(dir, "repo"));
}

const publish = (config: ShipConfig, options: { dry?: boolean; allowNativeDiff?: boolean } = {}) =>
  update(config, {
    message: "what changed",
    dry: options.dry ?? false,
    allowNativeDiff: options.allowNativeDiff ?? false,
  });

describe("ios.update config", () => {
  const parse = (raw: unknown) => parseConfig(JSON.stringify(raw), "/apps/demo");

  test("parses the section and fills optional fields", () => {
    expect(parse(shipJson()).ios?.update).toEqual(updateConfig);
    const minimal = { channel: "production", easCli: "eas-cli@23.1.0", nativeInputs: ["app.json"] };
    expect(parse(shipJson({ update: minimal })).ios?.update).toEqual({ ...minimal, environment: null, envCheck: null });
    const { update: _omit, ...withoutUpdate } = shipJson().ios;
    expect(parse({ ...shipJson(), ios: withoutUpdate }).ios?.update).toBeNull();
  });

  test("pokefolio's real config", () => {
    const text = readFileSync(join(import.meta.dir, "fixtures", "pokefolio.ship.json"), "utf8");
    const update = parseConfig(text, "/apps/pokefolio").ios?.update;
    expect(update?.channel).toBe("production");
    expect(update?.easCli).toBe("eas-cli@23.1.0");
    expect(update?.nativeInputs).toHaveLength(10);
    expect(update?.envCheck?.key).toBe("EXPO_PUBLIC_SUPABASE_URL");
  });

  test("rejects unknown keys, missing fields, an unpinned eas-cli and a non-expo app", () => {
    const rejects = (extra: Record<string, unknown>, message: string) =>
      expect(() => parse(shipJson(extra))).toThrow(message);
    rejects({ update: { ...updateConfig, chanel: "x" } }, "ios.update.chanel: unknown key");
    rejects(
      { update: { ...updateConfig, envCheck: { key: "K", value: "v", file: "x" } } },
      "ios.update.envCheck.file: unknown key",
    );
    rejects(
      { update: { ...updateConfig, envCheck: { key: "K" } } },
      "ios.update.envCheck.value: expected a non-empty string",
    );
    rejects({ update: { ...updateConfig, channel: undefined } }, "ios.update.channel: expected a non-empty string");
    rejects({ update: { ...updateConfig, easCli: "eas-cli" } }, "ios.update.easCli: expected a pinned version");
    rejects({ update: { ...updateConfig, easCli: "eas-cli@latest" } }, "ios.update.easCli: expected a pinned version");
    rejects(
      { update: { ...updateConfig, nativeInputs: [] } },
      "ios.update.nativeInputs: expected at least one pathspec",
    );
    rejects({ update: "production" }, "ios.update: expected an object");
    rejects({ kind: "xcodegen", dir: "." }, "ios.update: over-the-air updates need an expo app");
  });
});

describe("ship update", () => {
  test("publishes main with the pinned eas-cli after installing from the lockfile", async () => {
    const config = app();
    await publish(config);
    const sha = (await git(config.root, "rev-parse", "HEAD")).slice(0, 7);
    expect(recorded()).toEqual([
      `bun ${config.root} install --frozen-lockfile`,
      `bunx ${join(config.root, "apps/mobile")} eas-cli@23.1.0 update --channel production --environment production --non-interactive --message what changed (${sha})`,
    ]);
  });

  test("a dry run passes every guard and runs nothing", async () => {
    const config = app();
    await publish(config, { dry: true });
    expect(recorded()).toEqual([]);
  });

  test("a native change before the runtimeVersion bump is fine", async () => {
    const config = app();
    await commit(config.root, { "apps/mobile/modules/cam/ios/Cam.swift": "// v2\n" }, "feat: native");
    await commit(config.root, { "apps/mobile/app.json": appJson("1.0.2") }, "chore: bump runtimeVersion");
    await publish(config);
    expect(recorded()).toHaveLength(2);
  });

  const refuses = async (config: ShipConfig, message: string | RegExp, dry = false) => {
    await expect(publish(config, { dry })).rejects.toThrow(message);
    expect(recorded()).toEqual([]);
  };

  test("refuses an untracked file", async () => {
    const config = app();
    put(config.root, "notes.md", "draft\n");
    await refuses(config, "refusing to publish: clean working tree");
  });

  test("refuses a modified tracked file, in a dry run too", async () => {
    const config = app();
    put(config.root, "src/index.ts", "export const a = 3;\n");
    await refuses(config, "clean working tree", true);
  });

  test("refuses edits hidden by skip-worktree", async () => {
    const config = app();
    await git(config.root, "update-index", "--skip-worktree", "src/index.ts");
    put(config.root, "src/index.ts", "export const a = 3;\n");
    await refuses(config, "refusing to publish: no hidden changes");
  });

  test("refuses a local commit that is not on origin/main", async () => {
    const config = app();
    await commit(config.root, { "src/index.ts": "export const a = 3;\n" }, "feat: unpushed", false);
    await refuses(config, "refusing to publish: HEAD is origin/main");
  });

  test("refuses a repository with no origin", async () => {
    const config = app();
    await git(config.root, "remote", "remove", "origin");
    await refuses(config, "HEAD is origin/main");
  });

  test("refuses native changes since the runtimeVersion commit, unless overridden", async () => {
    const config = app();
    await commit(config.root, { "apps/mobile/modules/cam/ios/Cam.swift": "// v2\n" }, "feat: native");
    await refuses(config, "refusing to publish: no native inputs changed since then");
    await refuses(config, "no native inputs changed since then", true);

    await publish(config, { allowNativeDiff: true });
    expect(recorded()[1]).toEndWith("[native-diff-override]");
  });

  test("a version bump in app.json counts as a native change", async () => {
    const config = app();
    await commit(config.root, { "apps/mobile/app.json": appJson("1.0.1", "1.1.0") }, "chore: start version 1.1.0");
    await refuses(config, "no native inputs changed since then");
  });

  test("refuses when no commit set the runtimeVersion as written", async () => {
    const config = app();
    const compact = `${JSON.stringify({ expo: { name: "Demo", version: "1.0.0", runtimeVersion: "1.0.3" } })}\n`;
    await commit(config.root, { "apps/mobile/app.json": compact }, "chore: compact app.json");
    await refuses(config, "refusing to publish: runtimeVersion commit found");
  });

  test("refuses a runtimeVersion policy object", async () => {
    const config = app();
    const policy = `${JSON.stringify({ expo: { version: "1.0.0", runtimeVersion: { policy: "appVersion" } } }, null, 2)}\n`;
    await commit(config.root, { "apps/mobile/app.json": policy }, "chore: policy");
    await expect(publish(config, { dry: true })).rejects.toThrow("runtimeVersion commit found");
  });

  test("refuses an env file that points away from production, skipping .env.example", async () => {
    const config = app();
    await commit(
      config.root,
      { "apps/mobile/.env.example": "EXPO_PUBLIC_API_URL=https://staging.example.com\n" },
      "docs: env example",
    );
    put(config.root, "apps/mobile/.env.local", `EXPO_PUBLIC_API_URL="${PRODUCTION}"\n`);
    await publish(config, { dry: true });

    put(config.root, "apps/mobile/.env.local", "EXPO_PUBLIC_API_URL='https://staging.example.com'\n");
    await refuses(config, `refusing to publish: env files set EXPO_PUBLIC_API_URL to ${PRODUCTION}`);
  });

  test("reports every refusal at once", async () => {
    const config = app();
    await commit(config.root, { "apps/mobile/modules/cam/ios/Cam.swift": "// v2\n" }, "feat: native", false);
    put(config.root, "notes.md", "draft\n");
    await refuses(config, /clean working tree; HEAD is origin\/main; no native inputs changed since then/, true);
  });

  test("needs a message and an ios.update section", async () => {
    const config = app();
    await expect(update(config, { message: " ", dry: true, allowNativeDiff: false })).rejects.toThrow("usage");
    const { update: _omit, ...withoutUpdate } = shipJson().ios;
    const bare = parseConfig(JSON.stringify({ ...shipJson(), ios: withoutUpdate }), config.root);
    await expect(update(bare, { message: "x", dry: true, allowNativeDiff: false })).rejects.toThrow(
      "no ios.update section",
    );
  });
});
