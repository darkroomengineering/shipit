import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Platform, ShipConfig, WindowsConfig, WindowsRelease } from "./config.ts";
import { git, mainRef } from "./git.ts";
import { log, run, warn } from "./log.ts";

/** The `sign` CLI version Programa's release workflow installs. */
const SIGN_VERSION = "1.1.5";
const TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";

export interface WindowsRun {
  config: ShipConfig;
  windows: WindowsConfig;
  worktree: string;
  version: string;
  build: string;
  commit: string;
  notes: string;
  dry: boolean;
}

/** Velopack builds only on Windows; everywhere else the lane runs on a GitHub Actions Windows runner. */
export const buildsHere = (platform: NodeJS.Platform = process.platform) => platform === "win32";

/** Velopack offers an update only to a higher SemVer 2 version, and ship's version stays put between betas. */
export const packVersion = (version: string, build: string) => `${version}-build.${build}`;

export function installerNames(windows: WindowsConfig, version: string, build: string) {
  const arch = windows.runtime.slice("win-".length);
  return {
    alias: `${windows.packId}-${arch}-setup.exe`,
    versioned: `${windows.packId}-${version}-${build}-${arch}-setup.exe`,
  };
}

/** Where a run's packages land; on a runner, under RUNNER_TEMP so the workflow can keep them as an artifact. */
export const outputDir = (build: string, env = process.env) =>
  join(env.RUNNER_TEMP ?? tmpdir(), `shipit-windows-${build}`);

const toolDir = (name: string, version: string) => join(homedir(), ".shipit", "tools", `${name}-${version}`);
const toolExe = (name: string, version: string) => join(toolDir(name, version), `${name}.exe`);
const toolInstall = (name: string, version: string) => [
  "dotnet",
  "tool",
  "install",
  name,
  "--version",
  version,
  "--tool-path",
  toolDir(name, version),
];

const pwsh = (script: string) => ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script];
const psQuote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const authenticode = (file: string) => pwsh(`(Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}).Status`);
const AZ_ACCOUNT = ["az", "account", "show", "--output", "none"];
/** vpk signs a temporary copy of the pack folder, so the signed main exe is the one inside the full package. */
const extractMainExe = (nupkg: string, mainExe: string, into: string) => [
  "tar",
  "-xf",
  nupkg,
  "-C",
  into,
  `lib/app/${mainExe}`,
];

/** vpk runs this through cmd.exe once per file it signs: the app's binaries, Update.exe and Setup.exe. */
export function signTemplate(windows: WindowsConfig): string | undefined {
  const { signing } = windows;
  if (!signing) return undefined;
  return [
    `"${toolExe("sign", SIGN_VERSION)}"`,
    "code",
    "artifact-signing",
    "--artifact-signing-endpoint",
    signing.endpoint,
    "--artifact-signing-account",
    signing.account,
    "--artifact-signing-certificate-profile",
    signing.profile,
    "--azure-credential-type",
    "azure-cli",
    "--file-digest",
    "sha256",
    "--timestamp-url",
    TIMESTAMP_URL,
    "--timestamp-digest",
    "sha256",
    "--publisher-name",
    `"${signing.publisher}"`,
    "--description",
    `"${windows.packTitle}"`,
    "{{file}}",
  ].join(" ");
}

export function packCommand(r: WindowsRun, feedDir: string, sign: boolean): string[] {
  const { windows } = r;
  const template = sign ? signTemplate(windows) : undefined;
  return [
    toolExe("vpk", windows.vpk),
    "pack",
    "--packId",
    windows.packId,
    "--packTitle",
    windows.packTitle,
    "--packVersion",
    packVersion(r.version, r.build),
    "--packDir",
    join(r.worktree, windows.dir, windows.publishDir),
    "--mainExe",
    windows.mainExe,
    "--runtime",
    windows.runtime,
    "--channel",
    windows.channel,
    "--noPortable",
    "--outputDir",
    feedDir,
    ...(template ? ["--signTemplate", template] : []),
  ];
}

const gh = (release: WindowsRelease, ...args: string[]) => ["gh", "release", ...args, "--repo", release.repo];
export const releaseView = (release: WindowsRelease) => gh(release, "view", release.tag, "--json", "isDraft");
export const releaseUpload = (release: WindowsRelease, files: string[]) =>
  gh(release, "upload", release.tag, ...files, "--clobber");
export const releasePublish = (release: WindowsRelease) => gh(release, "edit", release.tag, "--draft=false");
function releaseCreate(r: WindowsRun, sameRepo: boolean) {
  const { release } = r.windows;
  return gh(
    release,
    "create",
    release.tag,
    "--draft",
    "--title",
    `${r.config.name} ${r.version} (${r.build})`,
    "--notes",
    r.notes,
    ...(sameRepo ? ["--target", r.commit] : []),
  );
}

export const dispatchCommand = (r: WindowsRun, repo: string) => [
  "gh",
  "workflow",
  "run",
  r.windows.workflow,
  "--repo",
  repo,
  "--ref",
  "main",
  "-f",
  `version=${r.version}`,
  "-f",
  `build=${r.build}`,
  "-f",
  `commit=${r.commit}`,
];
const watchCommand = (repo: string, id: string) => [
  "gh",
  "run",
  "watch",
  id,
  "--repo",
  repo,
  "--exit-status",
  "--interval",
  "30",
];

const show = (command: string[]) =>
  command.map((arg) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");

const UNSIGNED =
  "windows: UNSIGNED build. ship.json has no windows.signing, so SmartScreen warns everyone who runs the installer";

/** `owner/name` of the repository's GitHub origin, read from the remote URL without calling GitHub. */
export async function githubRepo(root: string): Promise<string> {
  // The configured URL, not `remote get-url`, which applies insteadOf rewrites.
  const url = await git(root, "config", "--get", "remote.origin.url").catch(() => "");
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`the windows lane runs on GitHub Actions, and origin is not a GitHub repository: ${url}`);
  return `${match[1]}/${match[2]}`;
}

/** The commands a run executes, in order, for `--dry-run` away from Windows and for tests. */
export function windowsPlan(r: WindowsRun, repo: string, platform: NodeJS.Platform = process.platform): string[] {
  const { windows } = r;
  const sign = Boolean(windows.signing);
  const out = outputDir(r.build);
  const feed = join(out, "feed");
  const { alias, versioned } = installerNames(windows, r.version, r.build);
  const setup = join(feed, `${windows.packId}-${windows.channel}-Setup.exe`);
  const nupkg = join(
    feed,
    `${windows.packId}-${packVersion(r.version, r.build)}${windows.channel === "win" ? "" : `-${windows.channel}`}-full.nupkg`,
  );
  const verify = join(out, "verify");
  const here = [
    `${show(pwsh(windows.publish))}   (in ${join(r.worktree, windows.dir)})`,
    show(toolInstall("vpk", windows.vpk)),
    ...(sign ? [show(toolInstall("sign", SIGN_VERSION)), show(AZ_ACCOUNT)] : [UNSIGNED]),
    show(packCommand(r, feed, sign)),
    ...(sign
      ? [
          show(extractMainExe(nupkg, windows.mainExe, verify)),
          ...[setup, join(verify, "lib", "app", windows.mainExe)].map(
            (file) => `${show(authenticode(file))}   must print Valid`,
          ),
        ]
      : []),
    `copy ${setup} to ${join(out, "installers", alias)} and ${join(out, "installers", versioned)}; their SHA-256 must match${sign ? " and both must be Valid" : ""}`,
    `${show(releaseView(windows.release))}   then, when the release does not exist yet: ${show(releaseCreate(r, repo === windows.release.repo))}`,
    show(releaseUpload(windows.release, [join(out, "installers", versioned), join(feed, "*.nupkg")])),
    `${show(releaseUpload(windows.release, [join(out, "installers", alias), join(feed, `releases.${windows.channel}.json`)]))}   plus the other files vpk wrote besides packages and Setup.exe`,
  ];
  if (buildsHere(platform)) return here;
  return [
    `windows builds on a GitHub Actions Windows runner through ${repo}'s ${windows.workflow}:`,
    show(dispatchCommand(r, repo)),
    show(watchCommand(repo, "<run id>")),
    "the runner's ship beta windows then runs:",
    ...here.map((line) => `  ${line}`),
    `and this run, once every lane passed and the build is tagged: ${show(releasePublish(windows.release))}`,
  ];
}

/** Identity a ship run on another machine passes to the Windows runner, so every lane shares one build and release. */
export interface PinnedRun {
  version: string;
  build: string;
  commit: string;
}

/**
 * Reads SHIP_RUN_VERSION, SHIP_RUN_BUILD and SHIP_RUN_COMMIT, set by windows-lane.yml from the dispatch inputs.
 * A pinned run builds only that commit, which must be on main, and leaves tagging and publishing to the run that
 * dispatched it.
 */
export async function pinnedRun(
  config: ShipConfig,
  platforms: Platform[],
  env: Record<string, string | undefined> = process.env,
): Promise<PinnedRun | undefined> {
  const { SHIP_RUN_VERSION: version, SHIP_RUN_BUILD: build, SHIP_RUN_COMMIT: commit } = env;
  if (!version && !build && !commit) return undefined;
  if (!version || !build || !commit)
    throw new Error("SHIP_RUN_VERSION, SHIP_RUN_BUILD and SHIP_RUN_COMMIT are set together or not at all");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`SHIP_RUN_VERSION ${version} is not a version such as 1.2.3`);
  if (!/^\d+$/.test(build)) throw new Error(`SHIP_RUN_BUILD ${build} is not a build number`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`SHIP_RUN_COMMIT ${commit} is not a full commit hash`);
  if (platforms.join() !== "windows") throw new Error("a pinned run (SHIP_RUN_*) builds windows only");
  const main = await mainRef(config.root);
  await git(config.root, "merge-base", "--is-ancestor", commit, main).catch(() => {
    throw new Error(`SHIP_RUN_COMMIT ${commit.slice(0, 7)} is not on ${main}`);
  });
  return { version, build, commit };
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function installTool(name: string, version: string) {
  if (existsSync(toolExe(name, version))) return;
  log(`== ${show(toolInstall(name, version))}`);
  await run(toolInstall(name, version));
}

async function assertValid(files: string[]) {
  for (const file of files) {
    const status = (await run(authenticode(file), { capture: true })).trim();
    if (status !== "Valid") throw new Error(`Get-AuthenticodeSignature reports ${status || "nothing"} for ${file}`);
  }
}

interface Packaged {
  /** Upload before the mutable files, so the feed never names a package that is not there yet. */
  immutable: string[];
  /** The stable installer name and the feed files installed copies read. */
  mutable: string[];
}

async function buildHere(r: WindowsRun): Promise<Packaged> {
  const { windows } = r;
  const sign = Boolean(windows.signing) && !r.dry;
  if (windows.signing && r.dry) log("dry run: skipped signing with Azure Artifact Signing; the packages are unsigned");
  const appDir = join(r.worktree, windows.dir);
  log(`== ${windows.publish}`);
  await run(pwsh(windows.publish), {
    cwd: appDir,
    env: { SHIP_VERSION: r.version, SHIP_BUILD_NUMBER: r.build, SHIP_COMMIT: r.commit },
  });

  await installTool("vpk", windows.vpk);
  if (sign) {
    await installTool("sign", SIGN_VERSION);
    await run(AZ_ACCOUNT).catch(() => {
      throw new Error(
        "windows.signing is set but the Azure CLI is not signed in; the workflow's azure/login step signs in",
      );
    });
  }

  const out = outputDir(r.build);
  const feed = join(out, "feed");
  const installers = join(out, "installers");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(feed, { recursive: true });
  mkdirSync(installers);
  const pack = packCommand(r, feed, sign);
  log(`== ${show(pack)}`);
  await run(pack);

  const setups = readdirSync(feed).filter((name) => name.endsWith("-Setup.exe"));
  if (setups.length !== 1 || !setups[0]) throw new Error(`expected one *-Setup.exe in ${feed}, found ${setups.length}`);
  const setup = join(feed, setups[0]);
  if (sign) {
    const nupkgs = readdirSync(feed).filter((name) => name.endsWith("-full.nupkg"));
    if (nupkgs.length !== 1 || !nupkgs[0])
      throw new Error(`expected one *-full.nupkg in ${feed}, found ${nupkgs.length}`);
    const verify = join(out, "verify");
    mkdirSync(verify);
    await run(extractMainExe(join(feed, nupkgs[0]), windows.mainExe, verify), { capture: true });
    await assertValid([setup, join(verify, "lib", "app", windows.mainExe)]);
  }

  // Copies of the signed file: each signing call gets a fresh certificate and timestamp, so two signed copies would differ.
  const names = installerNames(windows, r.version, r.build);
  const alias = join(installers, names.alias);
  const versioned = join(installers, names.versioned);
  copyFileSync(setup, alias);
  copyFileSync(setup, versioned);
  const hash = sha256(setup);
  if (sha256(alias) !== hash || sha256(versioned) !== hash)
    throw new Error(`${names.alias} and ${names.versioned} are not byte-identical to ${setups[0]}`);
  if (sign) await assertValid([alias, versioned]);
  log(`windows: ${names.versioned} sha256 ${hash}${sign ? ", Authenticode Valid" : " (UNSIGNED)"}`);

  const feedFiles = readdirSync(feed)
    .filter((name) => name !== setups[0])
    .map((name) => join(feed, name));
  return {
    immutable: [versioned, ...feedFiles.filter((file) => file.endsWith(".nupkg"))],
    mutable: [alias, ...feedFiles.filter((file) => !file.endsWith(".nupkg"))],
  };
}

async function upload(r: WindowsRun, packaged: Packaged) {
  const { release } = r.windows;
  const create = releaseCreate(r, (await githubRepo(r.config.root)) === release.repo);
  const uploads = [releaseUpload(release, packaged.immutable), releaseUpload(release, packaged.mutable)];
  if (r.dry) {
    for (const command of [releaseView(release), create, ...uploads]) log(`dry run: skipped ${show(command)}`);
    return;
  }
  const exists = await run(releaseView(release), { capture: true }).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && /not found/i.test(error.message)) return false;
      throw error;
    },
  );
  for (const command of exists ? uploads : [create, ...uploads]) await run(command, { capture: true });
  log(`windows: uploaded to ${release.repo} release ${release.tag}`);
}

async function findRun(repo: string, workflow: string, since: number): Promise<string> {
  const list = ["gh", "run", "list", "--repo", repo, "--workflow", workflow, "--event", "workflow_dispatch"];
  for (let attempt = 0; attempt < 20; attempt++) {
    const out = await run([...list, "--limit", "5", "--json", "databaseId,createdAt"], { capture: true });
    const runs: unknown = JSON.parse(out);
    if (Array.isArray(runs)) {
      for (const item of runs) {
        const { databaseId, createdAt } = item as { databaseId?: unknown; createdAt?: unknown };
        // Allows for clock skew between this machine and GitHub.
        if (typeof databaseId === "number" && typeof createdAt === "string" && Date.parse(createdAt) >= since - 30_000)
          return String(databaseId);
      }
    }
    await Bun.sleep(3000);
  }
  throw new Error(`dispatched ${workflow} in ${repo}, but no run of it showed up within a minute`);
}

async function dispatch(r: WindowsRun) {
  const repo = await githubRepo(r.config.root);
  if (r.dry) {
    for (const line of windowsPlan(r, repo)) log(`dry run: ${line}`);
    return;
  }
  const since = Date.now();
  const out = await run(dispatchCommand(r, repo), { capture: true });
  const id = /\/actions\/runs\/(\d+)/.exec(out)?.[1] ?? (await findRun(repo, r.windows.workflow, since));
  log(`windows: building on https://github.com/${repo}/actions/runs/${id}`);
  await run(watchCommand(repo, id));
}

/**
 * Builds, signs, verifies and uploads the installer and update feed on Windows; elsewhere dispatches the app's
 * workflow to a Windows runner and waits for it. Either way the files land in the release, which stays a draft
 * when this run created it until `publishRelease`.
 */
export async function shipWindows(r: WindowsRun): Promise<WindowsRelease> {
  if (!r.windows.signing) warn(UNSIGNED);
  if (buildsHere()) await upload(r, await buildHere(r));
  else await dispatch(r);
  return r.windows.release;
}

/** Publishes the release once every lane passed. A release that is already public stays public. */
export async function publishRelease(release: WindowsRelease, dry: boolean) {
  const command = releasePublish(release);
  if (dry) log(`dry run: skipped ${show(command)}`);
  else {
    await run(command, { capture: true });
    log(`published ${release.repo} release ${release.tag}`);
  }
}
