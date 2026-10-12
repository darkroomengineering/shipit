import type { VersionSpec } from "./config.ts";

const VERSION = /^\d+\.\d+(\.\d+)?$/;

function jsonPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
      value,
    );
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lastKey = (path: string) => path.split(".").at(-1) ?? path;

function yamlLine(key: string) {
  return new RegExp(`^(\\s*${escapeRegExp(key)}:\\s*)(["']?)([0-9][0-9.]*)\\2(\\s*(?:#.*)?)$`, "gm");
}

export function readVersion(spec: VersionSpec, text: string): string {
  let version: string | undefined;
  if (spec.json) {
    const value = jsonPath(JSON.parse(text), spec.json);
    version = typeof value === "string" ? value : undefined;
  } else if (spec.yaml) {
    version = yamlLine(lastKey(spec.yaml)).exec(text)?.[3];
  } else {
    version = text.trim();
  }
  if (!version || !VERSION.test(version)) {
    throw new Error(
      `${spec.file}: expected a version such as 1.2.3 at ${spec.json ?? spec.yaml ?? "the file"}, found ${JSON.stringify(version)}`,
    );
  }
  return version;
}

/** Returns the file text with the version replaced; formatting, quotes and comments around it stay as they were. */
export function writeVersion(spec: VersionSpec, text: string, next: string): string {
  const current = readVersion(spec, text);
  if (spec.yaml)
    return text.replace(
      yamlLine(lastKey(spec.yaml)),
      (_line, head: string, quote: string, _old: string, tail: string) => `${head}${quote}${next}${quote}${tail}`,
    );
  if (spec.json) {
    const key = lastKey(spec.json);
    const pattern = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*")${escapeRegExp(current)}(")`, "g");
    if ((text.match(pattern) ?? []).length === 1) return text.replace(pattern, `$1${next}$2`);
    // The old value appears more than once, so rewrite the document and keep its indent.
    const indent = /^( +|\t)"/m.exec(text)?.[1] ?? 2;
    const document = JSON.parse(text) as Record<string, unknown>;
    const path = spec.json.split(".");
    const parent = path
      .slice(0, -1)
      .reduce<Record<string, unknown>>((node, step) => node[step] as Record<string, unknown>, document);
    parent[key] = next;
    return `${JSON.stringify(document, null, indent)}\n`;
  }
  return `${next}\n`;
}

export type Bump = "patch" | "minor" | "major";

export function bump(version: string, kind: Bump): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export const isBump = (value: string): value is Bump => value === "patch" || value === "minor" || value === "major";
