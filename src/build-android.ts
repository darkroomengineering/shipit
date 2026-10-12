import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShipConfig } from "./config.ts";
import { log, run } from "./log.ts";

export interface AndroidBuild {
  config: ShipConfig;
  worktree: string;
  version: string;
  build: string;
  versionCode: number;
}

/** Builds the signed release bundle with Gradle and copies it to ~/Desktop/<Name>-Android/. */
export async function buildAndroid(input: AndroidBuild): Promise<string> {
  const { config, worktree, version, build, versionCode } = input;
  const android = config.android;
  if (!android) throw new Error("ship.json has no android section");
  const gradleDir = join(worktree, android.dir);
  log(`== gradle bundleRelease (version code ${versionCode})`);
  await run([join(gradleDir, "gradlew"), "-q", "bundleRelease", `-P${android.versionCodeProperty}=${versionCode}`], {
    cwd: gradleDir,
    env: { JAVA_HOME: process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@21" },
  });
  const out = join(homedir(), "Desktop", `${config.name.replace(/\s+/g, "")}-Android`);
  mkdirSync(out, { recursive: true });
  const target = join(out, `${config.name.replace(/\s+/g, "")}-${version}-${build}.aab`);
  copyFileSync(join(gradleDir, "app", "build", "outputs", "bundle", "release", "app-release.aab"), target);
  log(`android: ${target}`);
  return target;
}
