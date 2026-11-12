import { createPrivateKey, createPublicKey } from "node:crypto";

/** One `<item>` of a Sparkle appcast. */
export interface AppcastItem {
  /** sparkle:version, the CFBundleVersion Sparkle compares. */
  version: string;
  shortVersion: string | undefined;
  url: string | undefined;
  edSignature: string | undefined;
}

const tag = (block: string, name: string) =>
  block.match(new RegExp(`<sparkle:${name}>\\s*([^<]*?)\\s*</sparkle:${name}>`))?.[1];
const attribute = (element: string, name: string) => element.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

/** The items of an appcast, in document order. Reads both `<sparkle:version>` and the older enclosure attribute. */
export function appcastItems(xml: string): AppcastItem[] {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map(([, block = ""]) => {
    const enclosure = block.match(/<enclosure\b[^>]*>/)?.[0] ?? "";
    return {
      version: tag(block, "version") ?? attribute(enclosure, "sparkle:version") ?? "",
      shortVersion: tag(block, "shortVersionString") ?? attribute(enclosure, "sparkle:shortVersionString"),
      url: attribute(enclosure, "url"),
      edSignature: attribute(enclosure, "sparkle:edSignature"),
    };
  });
}

const DIGITS = /^\d+$/;

/**
 * The highest build in a published appcast. Compared as BigInt: Programa's run-derived builds have 17 digits, past
 * the integers a JavaScript number holds exactly.
 */
export function publishedBuild(xml: string): string | undefined {
  let highest: bigint | undefined;
  for (const { version } of appcastItems(xml)) {
    if (!DIGITS.test(version)) continue;
    const value = BigInt(version);
    if (highest === undefined || value > highest) highest = value;
  }
  return highest === undefined ? undefined : String(highest);
}

/** The archive URLs of the newest `count` builds in an appcast, newest first: generate_appcast's delta sources. */
export function newestArchives(xml: string, count: number): string[] {
  return appcastItems(xml)
    .filter((item) => DIGITS.test(item.version) && item.url)
    .sort((a, b) => (BigInt(b.version) > BigInt(a.version) ? 1 : BigInt(b.version) < BigInt(a.version) ? -1 : 0))
    .slice(0, count)
    .map((item) => item.url as string);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A version's CHANGELOG.md section, without its heading. Takes `## 1.2.3` (browsee) and Keep a Changelog's
 * `## [1.2.3] - 2026-11-11` (Programa). Subsections stay; the next `## ` heading ends it. Undefined when the section
 * is missing or has no text.
 */
export function changelogSection(text: string, version: string): string | undefined {
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?(\\s|$)`);
  const lines = text.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || undefined;
}

/** Base64 with its `=` padding restored; Sparkle keys are often stored without it. */
export const padBase64 = (text: string) => text.trim().padEnd(Math.ceil(text.trim().length / 4) * 4, "=");

/**
 * The SUPublicEDKey that verifies a Sparkle private key: a base64 32-byte Ed25519 seed (what generate_keys exports),
 * or the older 96-byte form that ends with the public key. Ported from Programa's derive_sparkle_public_key.swift.
 */
export function publicKeyFromPrivate(privateKey: string): string {
  const bytes = Buffer.from(padBase64(privateKey), "base64");
  if (bytes.length === 96) return bytes.subarray(64).toString("base64");
  if (bytes.length !== 32) throw new Error(`the Sparkle private key is ${bytes.length} bytes; expected 32 or 96`);
  // PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), bytes]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" });
  return Buffer.from(jwk.x ?? "", "base64url").toString("base64");
}

export interface PreflightInput {
  version: string;
  build: string;
  /** The changelog file's text, or undefined when the repository has none. */
  changelog: string | undefined;
  changelogFile: string;
  /** The published appcast, or undefined before the first release. */
  published: string | undefined;
  /** The public key of the private key this run signs with, when it is known. */
  signingKey: string | undefined;
  /** The app's SUPublicEDKey from ship.json. */
  publicKey: string;
}

/** Every reason the Mac release must not run; empty when it may. */
export function preflightProblems(input: PreflightInput): string[] {
  const problems: string[] = [];
  if (!DIGITS.test(input.build)) problems.push(`build ${input.build} is not a whole number; Sparkle compares builds`);
  const latest = input.published === undefined ? undefined : publishedBuild(input.published);
  if (latest !== undefined && DIGITS.test(input.build) && BigInt(input.build) <= BigInt(latest))
    problems.push(
      `build ${input.build} is not newer than the published build ${latest}; installed copies would never update`,
    );
  if (input.changelog === undefined) problems.push(`${input.changelogFile} is missing`);
  else if (!changelogSection(input.changelog, input.version))
    problems.push(`${input.changelogFile} has no section for ${input.version}; write the release notes first`);
  const key = input.signingKey === undefined ? undefined : keyProblem(input.signingKey, input.publicKey);
  if (key) problems.push(key);
  return problems;
}

/** Why the signing key cannot sign this app's updates, if it cannot. */
export const keyProblem = (signingKey: string, publicKey: string) =>
  signingKey === publicKey
    ? undefined
    : `the Sparkle private key's public key ${signingKey} is not the app's SUPublicEDKey ${publicKey}; installed copies would reject the update`;

/** Every reason a freshly generated appcast must not be published; empty when it may. */
export function appcastProblems(
  xml: string,
  expected: { build: string; version: string; url: string; signedFeed: boolean },
): string[] {
  const item = appcastItems(xml).find((candidate) => candidate.version === expected.build);
  if (!item) return [`the appcast has no item for build ${expected.build}`];
  const problems: string[] = [];
  if (item.shortVersion !== expected.version)
    problems.push(`the item for build ${expected.build} is version ${item.shortVersion}, not ${expected.version}`);
  if (item.url !== expected.url)
    problems.push(`the item for build ${expected.build} downloads ${item.url}, not ${expected.url}`);
  if (!item.edSignature) problems.push(`the item for build ${expected.build} has no sparkle:edSignature`);
  // generate_appcast signs the whole feed when the app sets SURequireSignedFeed; such an app rejects an unsigned one.
  if (expected.signedFeed && !xml.includes("<!-- sparkle-signatures:"))
    problems.push("the app requires a signed feed and the appcast carries no feed signature");
  return problems;
}

/** Whether an entitlements plist (`codesign -d --entitlements :-`) grants a key. */
const grants = (plist: string, key: string) => plist.includes(`<key>${key}</key>`);

export interface SignedCode {
  path: string;
  entitlements: string;
  /** Signed with an entitlements file from helperEntitlements, so the app-only rule does not apply. */
  ownEntitlements: boolean;
}

/**
 * Programa's verify-release-entitlements.sh: the app carries every required entitlement and no forbidden one, and
 * nested code signed without its own entitlements carries neither kind.
 */
export function entitlementProblems(
  app: SignedCode,
  nested: SignedCode[],
  rules: { required: string[]; forbidden: string[] },
): string[] {
  const problems: string[] = [];
  for (const key of rules.required)
    if (!grants(app.entitlements, key)) problems.push(`the app is missing the entitlement ${key}`);
  for (const key of rules.forbidden)
    if (grants(app.entitlements, key)) problems.push(`the app must not carry the entitlement ${key}`);
  for (const code of nested) {
    const banned = code.ownEntitlements ? rules.forbidden : [...rules.required, ...rules.forbidden];
    for (const key of banned)
      if (grants(code.entitlements, key)) problems.push(`${code.path} must not carry the entitlement ${key}`);
  }
  return problems;
}

/** Programa's verify-release-architectures.sh: `lipo -archs` output must name exactly the expected architectures. */
export function architectureProblem(path: string, lipo: string, expected: string[]): string | undefined {
  const found = lipo.trim().split(/\s+/).filter(Boolean).sort();
  const want = [...expected].sort();
  return found.join(" ") === want.join(" ")
    ? undefined
    : `${path} holds ${found.join(" ") || "no architectures"}, expected ${want.join(" ")}`;
}

/** The immutable per-build archive name: `Programa-mac.dmg` becomes `Programa-mac-<build>.dmg`. */
export const enclosureName = (dmg: string, build: string) => `${dmg.replace(/\.dmg$/, "")}-${build}.dmg`;
