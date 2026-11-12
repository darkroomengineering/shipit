import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type IosConfig, readEnvFile, type UpdateConfig } from "./config.ts";
import { git, hasRemote } from "./git.ts";

/** One guard's result: `refusal` is null when it passed. */
export interface Verdict {
  guard: string;
  refusal: string | null;
}

export interface OtaCheck {
  verdicts: Verdict[];
  head: string;
  runtime: string | null;
  /** Native inputs that changed since the runtimeVersion commit; non-empty only under the override. */
  overridden: string[];
}

/** The expo project folder, repo-relative: the parent of the native `ios` folder. */
export const expoDir = (ios: IosConfig) => dirname(ios.dir);

const verdict = (guard: string, refusal: string | null = null): Verdict => ({ guard, refusal });

async function cleanTree(root: string): Promise<Verdict[]> {
  const dirty = await git(root, "status", "--porcelain");
  // Files marked assume-unchanged or skip-worktree hide their edits from `git status`.
  const hidden = (await git(root, "ls-files", "-v"))
    .split("\n")
    .filter((line) => /^[a-zS]/.test(line))
    .map((line) => line.slice(2));
  return [
    verdict("clean working tree", dirty ? `the working tree has uncommitted changes:\n${dirty}` : null),
    verdict(
      "no hidden changes",
      hidden.length ? `these tracked files are marked assume-unchanged or skip-worktree:\n${hidden.join("\n")}` : null,
    ),
  ];
}

async function atMain(root: string, head: string): Promise<Verdict> {
  const guard = "HEAD is origin/main";
  if (!(await hasRemote(root)))
    return verdict(guard, "there is no origin remote; updates ship only from GitHub's main");
  await git(root, "fetch", "-q", "origin", "main");
  const main = await git(root, "rev-parse", "origin/main");
  return verdict(
    guard,
    head === main ? null : `HEAD is ${head.slice(0, 7)}, not origin/main ${main.slice(0, 7)}; push or pull first`,
  );
}

/** `expo.runtimeVersion` in app.json at `rev`; undefined when the file is absent there. Unparseable JSON throws. */
async function runtimeAt(root: string, appJson: string, rev: string): Promise<unknown> {
  let text: string;
  try {
    text = await git(root, "show", `${rev}:${appJson}`);
  } catch {
    return undefined;
  }
  try {
    return (JSON.parse(text) as { expo?: { runtimeVersion?: unknown } } | null)?.expo?.runtimeVersion;
  } catch {
    throw new Error(`${appJson} at ${rev.slice(0, 7)} is not valid JSON, so the runtimeVersion history is unknown`);
  }
}

async function readRuntime(root: string, appJson: string): Promise<string> {
  const runtime = await runtimeAt(root, appJson, "HEAD");
  if (typeof runtime !== "string" || !runtime)
    throw new Error(`${appJson} has no literal expo.runtimeVersion string at HEAD; ship update needs one`);
  return runtime;
}

/**
 * The commit that set the current runtimeVersion: the oldest commit of the newest unbroken run of app.json
 * revisions whose parsed value is `runtime`. Comparing parsed values keeps a reformat of app.json from moving the
 * baseline past earlier native changes. Fails closed when history cannot establish it.
 */
async function runtimeCommit(root: string, appJson: string, runtime: string): Promise<string> {
  const commits = (await git(root, "log", "--format=%H", "--", appJson)).split("\n").filter(Boolean);
  let since: string | undefined;
  for (const commit of commits) {
    if ((await runtimeAt(root, appJson, commit)) !== runtime) return requireFound(since, runtime);
    since = commit;
  }
  // The run reaches the first commit in reach; in a shallow clone that is a cut, not where the value was set.
  if ((await git(root, "rev-parse", "--is-shallow-repository")) === "true")
    throw new Error(
      `the clone is shallow, so the commit that set runtimeVersion ${runtime} is out of reach; fetch the full history`,
    );
  return requireFound(since, runtime);
}

function requireFound(since: string | undefined, runtime: string): string {
  if (!since) throw new Error(`cannot find the commit that set runtimeVersion ${runtime}`);
  return since;
}

function envFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(".env") && !name.endsWith(".example"))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Gitignored env files are invisible to the clean-tree check but are inlined into the bundle, so each one must
 * leave the variable unset or point it at the expected value. An empty value is a value, not unset.
 */
export function checkEnv(dir: string, check: { key: string; value: string }): Verdict {
  const wrong = envFiles(dir).flatMap((file) => {
    const value = readEnvFile(file)[check.key];
    return value !== undefined && value !== check.value
      ? [`${file} sets ${check.key} to "${value}", not ${check.value}`]
      : [];
  });
  return verdict(`env files set ${check.key} to ${check.value}`, wrong.length ? wrong.join("\n") : null);
}

/**
 * Runs every guard `ship update` needs before publishing. OTA updates are unsigned, so these are what tie a
 * published bundle to a reviewed commit and keep native changes on the store-build path. Every guard runs, so a
 * dry run reports all of them; any refusal stops the publish.
 */
export async function checkOta(
  root: string,
  ios: IosConfig,
  update: UpdateConfig,
  allowNativeDiff: boolean,
): Promise<OtaCheck> {
  const head = await git(root, "rev-parse", "HEAD");
  const verdicts = [...(await cleanTree(root)), await atMain(root, head)];
  const appJson = join(expoDir(ios), "app.json");
  let runtime: string | null = null;
  let overridden: string[] = [];
  try {
    runtime = await readRuntime(root, appJson);
    const since = await runtimeCommit(root, appJson, runtime);
    verdicts.push(verdict(`runtimeVersion ${runtime} set in ${since.slice(0, 7)}`));
    const changed = (await git(root, "diff", "--name-only", since, "HEAD", "--", ...update.nativeInputs))
      .split("\n")
      .filter(Boolean);
    const guard = "no native inputs changed since then";
    if (!changed.length) verdicts.push(verdict(guard));
    else if (allowNativeDiff) {
      overridden = changed;
      verdicts.push(verdict(`${guard} (overridden by SHIP_ALLOW_NATIVE_DIFF=1: ${changed.join(", ")})`));
    } else
      verdicts.push(
        verdict(
          guard,
          `native inputs changed since runtimeVersion ${runtime} was set:\n${changed.join("\n")}\nbump runtimeVersion and ship a store build, or set SHIP_ALLOW_NATIVE_DIFF=1 once you have confirmed none of these change the binary`,
        ),
      );
  } catch (error) {
    verdicts.push(verdict("runtimeVersion commit found", error instanceof Error ? error.message : String(error)));
  }
  if (update.envCheck) verdicts.push(checkEnv(join(root, expoDir(ios)), update.envCheck));
  return { verdicts, head, runtime, overridden };
}

/** The publish command, run in the expo project folder. */
export function easUpdateCommand(update: UpdateConfig, message: string): string[] {
  return [
    "bunx",
    update.easCli,
    "update",
    "--channel",
    update.channel,
    ...(update.environment ? ["--environment", update.environment] : []),
    "--non-interactive",
    "--message",
    message,
  ];
}
