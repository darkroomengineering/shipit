import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BETA_CHANNEL,
  findRun,
  githubRepo,
  installerNames,
  matchRun,
  packVersion,
  pinnedRun,
  signTemplate,
  stagedName,
  uploadSets,
  type WindowsRun,
  windowsPlan,
} from "./build-windows.ts";
import { beta } from "./commands/beta.ts";
import { release } from "./commands/release.ts";
import { lanesFor, parseConfig, type ShipConfig } from "./config.ts";
import { git } from "./git.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "mesinyer.ship.json"), "utf8");
const mesinyer = parseConfig(fixture, "/apps/mesinyer");
const parse = (windows: object) =>
  parseConfig(JSON.stringify({ name: "Demo", version: { file: "VERSION" }, windows }), "/apps/demo");
const minimal = {
  publish: "dotnet publish App.csproj -o publish",
  publishDir: "publish",
  packId: "Demo",
  mainExe: "Demo.exe",
  vpk: "1.2.161",
  release: { repo: "darkroomengineering/demo-releases", tag: "rolling" },
};
const signing = {
  endpoint: "https://eus.codesigning.azure.net/",
  account: "darkroom",
  profile: "darkroom-public",
};

const tmp = mkdtempSync(join(tmpdir(), "shipit-windows-"));
const saved = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "ship test",
    GIT_AUTHOR_EMAIL: "ship@example.com",
    GIT_COMMITTER_NAME: "ship test",
    GIT_COMMITTER_EMAIL: "ship@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    RUNNER_TEMP: "/runner-temp",
  });
  for (const key of ["SHIP_RUN_VERSION", "SHIP_RUN_BUILD", "SHIP_RUN_COMMIT"]) delete process.env[key];
});
afterAll(() => {
  process.env = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("windows in ship.json", () => {
  test("Mesinyer's config parses with its real values", () => {
    expect(mesinyer.windows).toEqual({
      dir: "windows",
      copy: [],
      checks: [],
      publish:
        "dotnet publish Mesinyer.Windows/Mesinyer.Windows.csproj -c Release -r win-x64 -p:Platform=x64 --self-contained true -o publish",
      publishDir: "publish",
      packId: "Mesinyer",
      packTitle: "Mesinyer",
      mainExe: "Mesinyer.Windows.exe",
      runtime: "win-x64",
      channel: "win",
      betaChannel: false,
      vpk: "1.2.161",
      workflow: "ship-windows.yml",
      release: { repo: "darkroomengineering/mesinyer-releases", tag: "rolling" },
      signing: null,
    });
  });

  test("fills defaults and reads signing", () => {
    const { windows } = parse({ ...minimal, signing });
    expect(windows?.runtime).toBe("win-x64");
    expect(windows?.channel).toBe("win");
    expect(windows?.packTitle).toBe("Demo");
    expect(windows?.workflow).toBe("ship-windows.yml");
    expect(windows?.signing).toEqual({ ...signing, publisher: "Darkroom Engineering" });
    expect(parse(minimal).windows?.signing).toBeNull();
  });

  test("rejects missing and malformed fields", () => {
    const rejects = (windows: object, message: string) => expect(() => parse(windows)).toThrow(message);
    rejects({}, "windows.publish: expected a non-empty string");
    rejects({ ...minimal, release: undefined }, 'windows.release: expected { "repo": "owner/name", "tag": "..." }');
    rejects({ ...minimal, release: { repo: "mesinyer", tag: "rolling" } }, "windows.release.repo: expected owner/name");
    rejects({ ...minimal, release: { ...minimal.release, draft: true } }, "windows.release.draft: unknown key");
    rejects({ ...minimal, runtime: "linux-x64" }, "windows.runtime: expected win-x64, win-arm64, win-x86");
    rejects({ ...minimal, vpk: "latest" }, 'windows.vpk: expected a version such as "1.2.161"');
    rejects({ ...minimal, packId: "My App" }, "windows.packId: expected letters, digits");
    rejects({ ...minimal, packTitle: 'A "B"' }, "windows.packTitle: must not contain quotes");
    rejects({ ...minimal, signing: { endpoint: signing.endpoint } }, "windows.signing.account: expected");
    rejects(
      { ...minimal, signing: { ...signing, endpoint: "eus" } },
      "windows.signing.endpoint: expected an https URL",
    );
    rejects({ ...minimal, signing: { ...signing, profile: "a b" } }, "windows.signing.profile: expected letters");
    rejects({ ...minimal, signing: { ...signing, publisher: 'x" & calc' } }, "windows.signing.publisher: must not");
    rejects({ ...minimal, signing: { ...signing, password: "x" } }, "windows.signing.password: unknown key");
    rejects({ ...minimal, installer: "msi" }, "windows.installer: unknown key");
    rejects({ ...minimal, betaChannel: "yes" }, "windows.betaChannel: expected true or false");
    rejects({ ...minimal, betaChannel: true, channel: "beta" }, 'windows.channel: "beta" is the beta channel');
  });

  test("betaChannel opts the app into Velopack's beta channel and keeps channel as the stable one", () => {
    expect(parse({ ...minimal, betaChannel: true }).windows).toMatchObject({ betaChannel: true, channel: "win" });
    expect(parse({ ...minimal, channel: "beta" }).windows?.channel).toBe("beta");
  });

  test("windows has a lane", () => {
    expect(lanesFor(mesinyer)).toEqual(["windows"]);
    expect(lanesFor(mesinyer, "windows")).toEqual(["windows"]);
    const both = parseConfig(
      JSON.stringify({ ...JSON.parse(fixture), ios: { kind: "xcodegen", scheme: "M", bundleId: "a.b" } }),
      "/a",
    );
    expect(lanesFor(both)).toEqual(["ios", "windows"]);
  });
});

const windowsOf = (config: ShipConfig) => {
  if (!config.windows) throw new Error("the config has no windows section");
  return config.windows;
};
const run = (config: ShipConfig, overrides: Partial<WindowsRun> = {}): WindowsRun => {
  return {
    config,
    windows: windowsOf(config),
    worktree: "/w",
    version: "0.1.0",
    build: "202611121530",
    commit: "a".repeat(40),
    notes: "fix: notes",
    dry: true,
    ...overrides,
  };
};
const tools = join(homedir(), ".shipit", "tools");

describe("names", () => {
  test("Velopack's version rises with every build, and installers get a stable and a versioned name", () => {
    expect(packVersion("0.1.0", "202611121530")).toBe("0.1.0-build.202611121530");
    expect(installerNames(windowsOf(parse({ ...minimal, runtime: "win-arm64" })), "1.2.3", "7")).toEqual({
      alias: "Demo-arm64-setup.exe",
      versioned: "Demo-1.2.3-7-arm64-setup.exe",
    });
  });
});

describe("the dry-run plan", () => {
  test("for Mesinyer away from Windows: dispatch, watch, the runner's steps, then publish", () => {
    expect(windowsPlan(run(mesinyer), "darkroomengineering/mesinyer", "darwin")).toEqual([
      "windows builds on a GitHub Actions Windows runner through darkroomengineering/mesinyer's ship-windows.yml:",
      `gh workflow run ship-windows.yml --repo darkroomengineering/mesinyer --ref main -f version=0.1.0 -f build=202611121530 -f commit=${"a".repeat(40)} -f "dispatch_id=<dispatch id>"`,
      'gh run watch "<run id>" --repo darkroomengineering/mesinyer --exit-status --interval 30',
      "the runner's ship beta windows then runs:",
      '  pwsh -NoProfile -NonInteractive -Command "dotnet publish Mesinyer.Windows/Mesinyer.Windows.csproj -c Release -r win-x64 -p:Platform=x64 --self-contained true -o publish"   (in /w/windows)',
      `  dotnet tool install vpk --version 1.2.161 --tool-path ${tools}/vpk-1.2.161`,
      "  windows: UNSIGNED build. ship.json has no windows.signing, so SmartScreen warns everyone who runs the installer",
      `  ${tools}/vpk-1.2.161/vpk.exe pack --packId Mesinyer --packTitle Mesinyer --packVersion 0.1.0-build.202611121530 --packDir /w/windows/publish --mainExe Mesinyer.Windows.exe --runtime win-x64 --channel win --noPortable --outputDir /runner-temp/shipit-windows-202611121530/feed`,
      "  copy /runner-temp/shipit-windows-202611121530/feed/Mesinyer-win-Setup.exe to /runner-temp/shipit-windows-202611121530/installers/Mesinyer-x64-setup.exe and /runner-temp/shipit-windows-202611121530/installers/Mesinyer-0.1.0-202611121530-x64-setup.exe; their SHA-256 must match",
      '  gh release view rolling --json isDraft --repo darkroomengineering/mesinyer-releases   then, when the release does not exist yet: gh release create rolling --draft --title "Mesinyer 0.1.0 (202611121530)" --notes "fix: notes" --repo darkroomengineering/mesinyer-releases',
      '  gh release upload rolling /runner-temp/shipit-windows-202611121530/installers/Mesinyer-0.1.0-202611121530-x64-setup.exe "/runner-temp/shipit-windows-202611121530/feed/*.nupkg" --clobber --repo darkroomengineering/mesinyer-releases',
      "  gh release upload rolling /runner-temp/shipit-windows-202611121530/installers/Mesinyer-x64-setup.exe /runner-temp/shipit-windows-202611121530/feed/releases.win.json --clobber --repo darkroomengineering/mesinyer-releases   plus the other files vpk wrote besides packages and Setup.exe",
      "and this run, once every lane passed and the build is tagged: gh release edit rolling --draft=false --repo darkroomengineering/mesinyer-releases",
    ]);
  });

  test("with signing: vpk signs every file it packs through the sign CLI, and each result must be Valid", () => {
    const signed = parse({ ...minimal, signing: { ...signing, publisher: "Darkroom Engineering" } });
    const template = signTemplate(windowsOf(signed));
    expect(template).toBe(
      `"${tools}/sign-1.1.5/sign.exe" code artifact-signing --artifact-signing-endpoint https://eus.codesigning.azure.net/ --artifact-signing-account darkroom --artifact-signing-certificate-profile darkroom-public --azure-credential-type azure-cli --file-digest sha256 --timestamp-url http://timestamp.acs.microsoft.com --timestamp-digest sha256 --publisher-name "Darkroom Engineering" --description "Demo" {{file}}`,
    );
    const plan = windowsPlan(run(signed), "darkroomengineering/demo", "win32");
    expect(plan.some((line) => line.includes("UNSIGNED"))).toBe(false);
    expect(plan).toContain(`dotnet tool install sign --version 1.1.5 --tool-path ${tools}/sign-1.1.5`);
    expect(plan).toContain("az account show --output none");
    expect(plan.find((line) => line.includes(" pack "))).toEndWith(`--signTemplate ${JSON.stringify(template)}`);
    expect(plan.filter((line) => line.includes("Get-AuthenticodeSignature"))).toEqual([
      `pwsh -NoProfile -NonInteractive -Command "(Get-AuthenticodeSignature -LiteralPath '/runner-temp/shipit-windows-202611121530/feed/Demo-win-Setup.exe').Status"   must print Valid`,
      `pwsh -NoProfile -NonInteractive -Command "(Get-AuthenticodeSignature -LiteralPath '/runner-temp/shipit-windows-202611121530/verify/lib/app/Demo.exe').Status"   must print Valid`,
    ]);
    expect(plan).toContain(
      "tar -xf /runner-temp/shipit-windows-202611121530/feed/Demo-0.1.0-build.202611121530-full.nupkg -C /runner-temp/shipit-windows-202611121530/verify lib/app/Demo.exe",
    );
    expect(plan.find((line) => line.startsWith("copy "))).toEndWith("their SHA-256 must match and both must be Valid");
  });

  test("on Windows the plan is the build itself, with no dispatch", () => {
    const plan = windowsPlan(run(mesinyer), "darkroomengineering/mesinyer", "win32");
    expect(plan[0]).toStartWith("pwsh -NoProfile");
    expect(plan.some((line) => line.includes("gh workflow run") || line.includes("gh release edit"))).toBe(false);
  });

  test("a release in the app's own repository is created at the commit", () => {
    const own = parse({ ...minimal, release: { repo: "darkroomengineering/demo", tag: "rolling" } });
    const plan = windowsPlan(run(own), "darkroomengineering/demo", "darwin");
    expect(plan.find((line) => line.includes("gh release create"))).toContain(`--target ${"a".repeat(40)}`);
  });
});

describe("a beta-channel build", () => {
  const beta = parse({ ...minimal, betaChannel: true, signing });
  const out = "/runner-temp/shipit-windows-202611121530";
  const plan = () => windowsPlan(run(beta), "darkroomengineering/demo", "win32");

  test("packs twice into fresh folders, the stable channel and beta, and verifies both when signing", () => {
    const packs = plan().filter((line) => line.includes(" pack "));
    expect(packs).toHaveLength(2);
    expect(packs[0]).toContain(`--channel win --noPortable --outputDir ${out}/feed --signTemplate`);
    expect(packs[1]).toContain(`--channel beta --noPortable --outputDir ${out}/feed-beta --signTemplate`);
    expect(plan().filter((line) => line.includes("Get-AuthenticodeSignature"))).toEqual(
      [
        `${out}/feed/Demo-win-Setup.exe`,
        `${out}/verify/lib/app/Demo.exe`,
        `${out}/feed-beta/Demo-beta-Setup.exe`,
        `${out}/verify-beta/lib/app/Demo.exe`,
      ].map(
        (file) =>
          `pwsh -NoProfile -NonInteractive -Command "(Get-AuthenticodeSignature -LiteralPath '${file}').Status"   must print Valid`,
      ),
    );
    expect(plan()).toContain(
      `tar -xf ${out}/feed-beta/Demo-0.1.0-build.202611121530-beta-full.nupkg -C ${out}/verify-beta lib/app/Demo.exe`,
    );
  });

  test("uploads packages and the staged stable feed without clobbering, then only the beta feed", () => {
    const uploads = plan().filter((line) => line.startsWith("gh release upload"));
    expect(uploads).toEqual([
      `gh release upload rolling ${out}/installers/Demo-0.1.0-202611121530-x64-setup.exe "${out}/feed/*.nupkg" "${out}/feed-beta/*.nupkg" "${out}/staged/*" --repo darkroomengineering/demo-releases`,
      `gh release upload rolling ${out}/feed-beta/releases.beta.json --clobber --repo darkroomengineering/demo-releases   plus the other files vpk wrote in ${out}/feed-beta besides packages and Setup.exe; the stable installer name and feed wait for ship promote windows`,
    ]);
    expect(plan()).toContain(
      `copy every file in ${out}/feed besides packages and Setup.exe to ${out}/staged/Demo-202611121530-staged-<name>, for ship promote windows`,
    );
  });
});

describe("the upload sets", () => {
  const version = "0.1.0";
  const build = "508";
  const folder = (name: string, files: string[]) => {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    for (const file of files) writeFileSync(join(dir, file), `${name}/${file}`);
    return dir;
  };
  const stableFiles = [
    "Mesinyer-0.1.0-build.508-full.nupkg",
    "Mesinyer-win-Setup.exe",
    "releases.win.json",
    "RELEASES",
    "assets.win.json",
  ];
  const betaFiles = [
    "Mesinyer-0.1.0-build.508-beta-full.nupkg",
    `Mesinyer-${BETA_CHANNEL}-Setup.exe`,
    "releases.beta.json",
    "RELEASES-beta",
    "assets.beta.json",
  ];
  const names = installerNames(windowsOf(mesinyer), version, build);
  const sorted = (files: string[]) => files.map((file) => file.slice(tmp.length + 1)).sort();

  test("without betaChannel: the stable installer name and stable feed, as before", () => {
    const sets = uploadSets(windowsOf(mesinyer), build, {
      feed: folder("plain/feed", stableFiles),
      alias: join(tmp, "plain/installers", names.alias),
      versioned: join(tmp, "plain/installers", names.versioned),
      staged: join(tmp, "plain/staged"),
    });
    expect(sorted(sets.immutable)).toEqual([
      "plain/feed/Mesinyer-0.1.0-build.508-full.nupkg",
      "plain/installers/Mesinyer-0.1.0-508-x64-setup.exe",
    ]);
    expect(sorted(sets.mutable)).toEqual([
      "plain/feed/RELEASES",
      "plain/feed/assets.win.json",
      "plain/feed/releases.win.json",
      "plain/installers/Mesinyer-x64-setup.exe",
    ]);
    expect(existsSync(join(tmp, "plain/staged"))).toBe(false);
  });

  test("with betaChannel: both channels' packages and the staged stable feed, then the beta feed alone", () => {
    const windows = windowsOf(
      parseConfig(fixture.replace('"channel": "win",', '"channel": "win", "betaChannel": true,'), "/a"),
    );
    expect(windows.betaChannel).toBe(true);
    const staged = join(tmp, "beta/staged");
    const sets = uploadSets(windows, build, {
      feed: folder("beta/feed", stableFiles),
      betaFeed: folder("beta/feed-beta", betaFiles),
      alias: join(tmp, "beta/installers", names.alias),
      versioned: join(tmp, "beta/installers", names.versioned),
      staged,
    });
    expect(sorted(sets.immutable)).toEqual([
      "beta/feed-beta/Mesinyer-0.1.0-build.508-beta-full.nupkg",
      "beta/feed/Mesinyer-0.1.0-build.508-full.nupkg",
      "beta/installers/Mesinyer-0.1.0-508-x64-setup.exe",
      "beta/staged/Mesinyer-508-staged-RELEASES",
      "beta/staged/Mesinyer-508-staged-assets.win.json",
      "beta/staged/Mesinyer-508-staged-releases.win.json",
    ]);
    expect(sorted(sets.mutable)).toEqual([
      "beta/feed-beta/RELEASES-beta",
      "beta/feed-beta/assets.beta.json",
      "beta/feed-beta/releases.beta.json",
    ]);
    const all = [...sets.immutable, ...sets.mutable].map((file) => file.slice(file.lastIndexOf("/") + 1));
    expect(all).not.toContain(names.alias);
    expect(all).not.toContain("releases.win.json");
    expect(all.filter((name) => name.endsWith("-Setup.exe"))).toEqual([]);
    expect(readFileSync(join(staged, stagedName(windows, build, "releases.win.json")), "utf8")).toBe(
      "beta/feed/releases.win.json",
    );
  });
});

/** A repository whose origin claims to be GitHub's Mesinyer but fetches from a local bare repository. */
async function repo(name: string) {
  const bare = join(tmp, `${name}.git`);
  const dir = join(tmp, name);
  await git(tmp, "init", "-q", "--bare", "-b", "main", bare);
  mkdirSync(join(dir, "windows"), { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "ship.json"), fixture);
  writeFileSync(join(dir, "project.yml"), 'settings:\n  base:\n    MARKETING_VERSION: "0.1.0"\n');
  writeFileSync(join(dir, "windows", "README.md"), "");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "init");
  const url = "https://github.com/darkroomengineering/mesinyer.git";
  await git(dir, "remote", "add", "origin", url);
  await git(dir, "config", `url.${bare}.insteadOf`, url);
  await git(dir, "push", "-q", "-u", "origin", "main");
  return { dir, config: parseConfig(fixture, dir) };
}

describe("a dispatched (pinned) runner run", () => {
  test("is off unless all three values are set, and validates them", async () => {
    const { config } = await repo("pinned");
    const head = await git(config.root, "rev-parse", "HEAD");
    const env = { SHIP_RUN_VERSION: "0.1.0", SHIP_RUN_BUILD: "202611121530", SHIP_RUN_COMMIT: head };
    expect(await pinnedRun(config, ["windows"], {})).toBeUndefined();
    expect(await pinnedRun(config, ["windows"], env)).toEqual({
      version: "0.1.0",
      build: "202611121530",
      commit: head,
    });
    const rejects = (overrides: object, message: string, platforms: ("ios" | "windows")[] = ["windows"]) =>
      expect(pinnedRun(config, platforms, { ...env, ...overrides })).rejects.toThrow(message);
    await rejects({ SHIP_RUN_BUILD: undefined }, "are set together or not at all");
    await rejects({ SHIP_RUN_VERSION: "v1" }, "is not a version");
    await rejects({ SHIP_RUN_BUILD: "12a" }, "is not a build number");
    await rejects({ SHIP_RUN_COMMIT: "abc" }, "is not a full commit hash");
    await rejects({}, "builds windows only", ["ios", "windows"]);
    await rejects({ SHIP_RUN_COMMIT: "b".repeat(40) }, `SHIP_RUN_COMMIT bbbbbbb is not on origin/main`);
  });
});

describe("githubRepo", () => {
  test("reads owner/name from ssh and https origins", async () => {
    const { dir } = await repo("remote");
    expect(await githubRepo(dir)).toBe("darkroomengineering/mesinyer");
    await git(dir, "remote", "set-url", "origin", "git@github.com:darkroomengineering/mesinyer-releases.git");
    expect(await githubRepo(dir)).toBe("darkroomengineering/mesinyer-releases");
    await git(dir, "remote", "set-url", "origin", "https://gitlab.com/a/b.git");
    await expect(githubRepo(dir)).rejects.toThrow("origin is not a GitHub repository");
  });
});

describe("ship beta windows --dry-run away from Windows", () => {
  test("prints the plan for main's commit and touches nothing remote", async () => {
    const { config } = await repo("dry");
    const head = await git(config.root, "rev-parse", "HEAD");
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
    const warnSpy = spyOn(console, "warn").mockImplementation((line: string) => lines.push(line));
    try {
      await beta(config, { platform: "windows", dry: true, skipChecks: false });
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
    const text = lines.map((line) => line.replace(/^\S+ /, "")).join("\n");
    expect(text).toContain(`from ${head.slice(0, 7)} [dry run]`);
    expect(text).toContain("warning: windows: UNSIGNED build.");
    expect(text).toMatch(
      /dry run: gh workflow run ship-windows\.yml --repo darkroomengineering\/mesinyer --ref main -f version=0\.1\.0 -f build=\d{12} -f commit=[0-9a-f]{40}/,
    );
    expect(text).toContain("dry run: skipped tagging");
    expect(text).toContain(
      "dry run: skipped gh release edit rolling --draft=false --repo darkroomengineering/mesinyer-releases",
    );
    expect(text).toContain("dry run done: 0.1.0 build");
    expect(await git(config.root, "tag", "-l")).toBe("");
  });
});

describe("windows-lane.yml and the README's caller workflow", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "..", ".github", "workflows", "windows-lane.yml"), "utf8"),
  ) as {
    on: { workflow_call: { inputs: Record<string, unknown> } };
    jobs: { windows: { steps: { uses?: string; name?: string; env?: Record<string, string> }[] } };
  };
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
  const callerYaml = /```yaml\n(name: ship-windows\n[\s\S]*?)```/.exec(readme)?.[1] ?? "";
  const caller = Bun.YAML.parse(callerYaml) as {
    "run-name": string;
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    jobs: { windows: { uses: string; with: Record<string, string> } };
  };

  test("the caller takes every input ship dispatches and names its run with the dispatch id", () => {
    const dispatched = windowsPlan(run(mesinyer), "darkroomengineering/mesinyer", "darwin")[1] ?? "";
    const fields = [...dispatched.matchAll(/-f "?(\w+)=/g)].map((match) => match[1] ?? "");
    expect(fields).toEqual(["version", "build", "commit", "dispatch_id"]);
    for (const field of fields) expect(caller.on.workflow_dispatch.inputs).toHaveProperty(field);
    expect(caller["run-name"]).toContain("${{ inputs.dispatch_id");
    expect(caller.jobs.windows.uses).toStartWith("darkroomengineering/shipit/.github/workflows/windows-lane.yml@");
  });

  test("version, build and commit reach ship as SHIP_RUN_*", () => {
    const { inputs } = workflow.on.workflow_call;
    const env = workflow.jobs.windows.steps.find((step) => step.name === "ship")?.env ?? {};
    for (const field of ["version", "build", "commit"]) {
      expect(caller.jobs.windows.with[field]).toBe(`\${{ inputs.${field} }}`);
      expect(inputs).toHaveProperty(field);
      expect(env[`SHIP_RUN_${field.toUpperCase()}`]).toBe(`\${{ inputs.${field} }}`);
    }
    for (const field of Object.keys(caller.jobs.windows.with)) expect(inputs).toHaveProperty(field);
  });

  test("pins every action to a commit", () => {
    const uses = workflow.jobs.windows.steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe("finding the dispatched run", () => {
  const id = "3f1c2b9e-0000-4000-8000-000000000001";
  const listed = (...runs: [number, string][]) =>
    JSON.stringify(runs.map(([databaseId, displayTitle]) => ({ databaseId, displayTitle })));

  test("matches only the run named with this dispatch id, ignoring newer and concurrent runs", async () => {
    const pages = [
      listed([12, "ship windows 3f1c2b9e-0000-4000-8000-000000000002"], [11, "ship windows abc123"]),
      listed([13, "ship windows 3f1c2b9e-0000-4000-8000-000000000003"], [14, `ship windows ${id}`], [12, "x"]),
    ];
    let calls = 0;
    const list = async () => pages[Math.min(calls++, pages.length - 1)] ?? "[]";
    expect(await findRun(list, id, { attempts: 5, delayMs: 0 })).toBe("14");
    expect(calls).toBe(2);
  });

  test("fails after a bounded wait when no run carries the id", async () => {
    let calls = 0;
    const list = async () => {
      calls++;
      return listed([20, "ship windows someone-else"]);
    };
    await expect(findRun(list, id, { attempts: 3, delayMs: 0 })).rejects.toThrow(
      `no run named with dispatch id ${id} showed up after 3 checks`,
    );
    expect(calls).toBe(3);
  });

  test("ignores malformed listings", () => {
    expect(matchRun({}, id)).toBeUndefined();
    expect(matchRun([{ databaseId: "14", displayTitle: id }, null], id)).toBeUndefined();
  });
});

describe("ship release windows", () => {
  test("publishes the release even when main's head already has a windows build and the build is skipped", async () => {
    const { config } = await repo("release");
    const head = await git(config.root, "rev-parse", "HEAD");
    await git(
      config.root,
      "-c",
      "tag.gpgsign=false",
      "tag",
      "-a",
      "v0.1.0-1",
      head,
      "-m",
      "Mesinyer 0.1.0 build 1 (windows)",
    );
    await git(config.root, "push", "-q", "origin", "v0.1.0-1");
    const bin = join(tmp, "release-bin");
    const ghLog = join(tmp, "release-gh.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${ghLog}"\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await release(config, { platform: "windows", dry: false });
    } finally {
      process.env.PATH = path;
    }
    expect(readFileSync(ghLog, "utf8")).toBe(
      "release edit rolling --draft=false --repo darkroomengineering/mesinyer-releases\n",
    );
  });
});
