import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Asc } from "../asc.ts";
import { loadCredentials, resolvePath, type ShipConfig } from "../config.ts";
import { git, mainRef } from "../git.ts";
import { errorMessage } from "../log.ts";
import { Play } from "../play.ts";

type Level = "ok" | "warn" | "fail";
const MARK: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };
let failures = 0;

function report(level: Level, label: string, detail = "") {
  if (level === "fail") failures++;
  console.log(`${MARK[level]}  ${label}${detail ? `: ${detail}` : ""}`);
}

async function check(label: string, probe: () => Promise<string | undefined>) {
  try {
    report("ok", label, await probe());
  } catch (error) {
    report("fail", label, errorMessage(error));
  }
}

function tool(name: string, level: Level = "fail") {
  const path = Bun.which(name);
  if (path) report("ok", `tool ${name}`, path);
  else report(level, `tool ${name}`, "not found on PATH");
}

/** ios/.xcode.env.local is written by pod install; a stale NODE_BINARY there breaks the Xcode build phase. */
function checkNodeBinary(config: ShipConfig) {
  const ios = config.ios;
  if (ios?.kind !== "expo") return;
  const file = join(resolvePath(config.root, ios.dir), ".xcode.env.local");
  if (!existsSync(file)) return report("ok", "ios/.xcode.env.local", "absent (pod install writes it)");
  const node = /^\s*(?:export\s+)?NODE_BINARY=["']?([^"'\s]+)/m.exec(readFileSync(file, "utf8"))?.[1];
  if (!node) return report("ok", "ios/.xcode.env.local", "sets no NODE_BINARY");
  if (existsSync(node)) report("ok", "ios/.xcode.env.local NODE_BINARY", node);
  else
    report("warn", "ios/.xcode.env.local NODE_BINARY", `${node} does not exist; delete the file and run pod install`);
}

async function checkIos(config: ShipConfig) {
  const ios = config.ios;
  if (!ios) return;
  tool("xcodebuild");
  tool("gh", "warn");
  tool(ios.kind === "xcodegen" ? "xcodegen" : "pod");
  if (ios.kind === "expo") tool("python3");
  checkNodeBinary(config);

  let asc: Asc | undefined;
  try {
    const credentials = loadCredentials(config);
    report("ok", "credentials", `key ${credentials.keyId}, team ${credentials.teamId}`);
    if (existsSync(credentials.keyPath)) report("ok", "key file", credentials.keyPath);
    else report("fail", "key file", `${credentials.keyPath} is missing`);
    asc = new Asc(credentials, true);
  } catch (error) {
    report("fail", "credentials", errorMessage(error));
  }
  if (!asc) return;
  const client = asc;
  await check(`App Store Connect app ${ios.bundleId}`, async () => {
    const app = await client.app(ios.bundleId);
    return `app ${app.id}`;
  });
  for (const group of ios.externalGroups) {
    await check(`TestFlight group "${group}"`, async () => {
      const app = await client.app(ios.bundleId);
      const groups = await client.list(`/apps/${app.id}/betaGroups?limit=200`);
      if (!groups.some((candidate) => candidate.attributes?.name === group)) throw new Error("no group with that name");
      return undefined;
    });
  }
}

async function checkAndroid(config: ShipConfig) {
  const android = config.android;
  if (!android) return;
  const java = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin", "java")
    : "/opt/homebrew/opt/openjdk@21/bin/java";
  if (existsSync(java)) report("ok", "tool java", java);
  else tool("java");
  if (!existsSync(join(resolvePath(config.root, android.dir), "gradlew")))
    report("fail", "gradlew", `${android.dir}/gradlew is missing`);
  if (!android.playKey)
    return report("warn", "play key", "android.playKey is not set; bundles are built but not uploaded");
  const key = resolvePath(config.root, android.playKey);
  if (!existsSync(key)) return report("fail", "play key", `${key} is missing`);
  await check("Google Play access", async () => {
    const play = Play.inspector(config.root, android);
    const edit = await play.newEdit();
    await play.deleteEdit(edit);
    return android.package;
  });
}

export async function doctor(config: ShipConfig) {
  console.log(`${config.name} (${config.root})`);
  tool("bun");
  tool("git");
  if (!existsSync(join(config.root, ".git")))
    report("warn", "git", "not a repository; beta, release and version need one");
  else {
    await check("git main", async () => {
      const ref = await mainRef(config.root);
      await git(config.root, "rev-parse", "--verify", "-q", ref);
      return ref === "main" ? "no origin remote: builds come from local main and nothing is pushed" : undefined;
    });
  }
  if (!existsSync(join(config.root, config.version.file)))
    report("fail", "version file", `${config.version.file} is missing`);
  for (const path of [...(config.ios?.copy ?? []), ...(config.android?.copy ?? [])]) {
    if (!existsSync(join(config.root, path))) report("fail", `copy ${path}`, "missing from the working copy");
  }
  const hook = config.ios?.preArchive;
  if (hook && !existsSync(join(config.root, hook))) report("fail", "preArchive hook", `${hook} is missing`);
  await checkIos(config);
  await checkAndroid(config);
  console.log(failures ? `\n${failures} problem${failures === 1 ? "" : "s"} found` : "\nready to ship");
  if (failures) process.exitCode = 1;
}
