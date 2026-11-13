import { basename } from "node:path";
import type { GithubHosting, MacDirectConfig, R2Hosting } from "./config.ts";

export interface Command {
  argv: string[];
  env?: Record<string, string | undefined>;
}

/** A read-only command and what its output must be for the release to go ahead. */
export interface HostCheck extends Command {
  /** Why the hosting cannot take the release, given the command's output; undefined when it can. */
  problem: (output: string) => string | undefined;
}

/** The files one Mac release publishes. */
export interface Publication {
  build: string;
  /** The per-build DMG and the deltas generate_appcast made: immutable, uploaded first. */
  archives: string[];
  /** The new appcast's copy kept for rollback, named `appcast-<build>.xml`. */
  history: string;
  /** The new appcast, named `appcast.xml`. */
  appcast: string;
  /** The newest DMG under the stable download name; left out when the build goes to the beta channel. */
  alias?: string;
}

/**
 * What `ship promote` replaces: the appcast with the build moved to the default channel, and that build's DMG under
 * the stable download name.
 */
export interface Promotion {
  appcast: string;
  alias: string;
}

/**
 * Where a Mac app's Sparkle archives and appcast live. Uploads come in publish order: archives, the appcast's
 * history copy, the appcast, then the stable alias, so the feed never names an archive that is not there yet.
 */
export interface MacHost {
  /** The URL prefix of every enclosure in the appcast. */
  readonly downloadPrefix: string;
  checks(): HostCheck[];
  uploads(files: Publication): Command[];
  /** The stable download first, the feed last: a failed upload leaves the build on beta, so promote can retry. */
  promoteUploads(files: Promotion): Command[];
}

/** Archives on one GitHub release, served at github.com/<repo>/releases/download/<tag>/. */
export function githubHost(hosting: GithubHosting, feedUrl: string): MacHost {
  const { repo, tag } = hosting;
  const upload = (files: string[], clobber: boolean) => ({
    argv: ["gh", "release", "upload", tag, ...files, "--repo", repo, ...(clobber ? ["--clobber"] : [])],
  });
  const checks: HostCheck[] = [
    {
      argv: ["gh", "release", "view", tag, "--repo", repo, "--json", "isDraft", "--jq", ".isDraft"],
      problem: (out) =>
        out.trim() === "false" ? undefined : `the ${tag} release of ${repo} is a draft, so GitHub serves none of it`,
    },
  ];
  if (feedUrl.includes("/releases/latest/"))
    checks.push({
      argv: ["gh", "api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"],
      problem: (out) =>
        out.trim() === tag
          ? undefined
          : `the feed reads the latest release of ${repo}, which is ${out.trim() || "none"}, not ${tag}`,
    });
  return {
    downloadPrefix: `https://github.com/${repo}/releases/download/${tag}/`,
    checks: () => checks,
    // Archives never clobber: a URL whose bytes change fails Sparkle's signature check (error 4005).
    uploads: (files) => [
      upload(files.archives, false),
      upload([files.history], false),
      upload([files.appcast], true),
      ...(files.alias ? [upload([files.alias], true)] : []),
    ],
    promoteUploads: (files) => [upload([files.alias], true), upload([files.appcast], true)],
  };
}

/** Archives in an R2 bucket through the aws CLI, served at the feed URL's folder, as browsee's release.sh does. */
export function r2Host(hosting: R2Hosting, feedUrl: string, env: NodeJS.ProcessEnv = process.env): MacHost {
  const endpoint = `https://${hosting.accountId}.r2.cloudflarestorage.com`;
  // R2 ignores the region but the aws CLI wants one; "auto" is R2's documented value.
  const awsEnv = {
    AWS_DEFAULT_REGION: env.AWS_DEFAULT_REGION ?? "auto",
    ...(hosting.profile && !env.AWS_ACCESS_KEY_ID ? { AWS_PROFILE: hosting.profile } : {}),
  };
  const aws = (...args: string[]): Command => ({ argv: ["aws", "--endpoint-url", endpoint, ...args], env: awsEnv });
  const put = (file: string, key: string, type: string, cache?: string) =>
    aws(
      "s3",
      "cp",
      "--only-show-errors",
      file,
      `s3://${hosting.bucket}/${key}`,
      "--content-type",
      type,
      ...(cache ? ["--cache-control", cache] : []),
    );
  const appcast = (file: string) => put(file, "appcast.xml", "application/xml", "no-cache");
  const alias = (file: string) => put(file, basename(file), "application/x-apple-diskimage", "public, max-age=300");
  return {
    downloadPrefix: feedUrl.slice(0, feedUrl.length - "appcast.xml".length),
    checks: () => [{ ...aws("s3api", "head-bucket", "--bucket", hosting.bucket), problem: () => undefined }],
    uploads: (files) => [
      ...files.archives.map((file) =>
        put(file, basename(file), file.endsWith(".dmg") ? "application/x-apple-diskimage" : "application/octet-stream"),
      ),
      put(files.history, `appcasts/appcast-${files.build}.xml`, "application/xml"),
      appcast(files.appcast),
      ...(files.alias ? [alias(files.alias)] : []),
    ],
    promoteUploads: (files) => [alias(files.alias), appcast(files.appcast)],
  };
}

export const hostFor = (mac: MacDirectConfig, env: NodeJS.ProcessEnv = process.env): MacHost =>
  mac.hosting.type === "github" ? githubHost(mac.hosting, mac.feedUrl) : r2Host(mac.hosting, mac.feedUrl, env);
