import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjects } from "./nightly.ts";

const root = mkdtempSync(join(tmpdir(), "shipit-scan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function app(path: string) {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, "ship.json"), "{}");
}

test("finds apps one and two levels down, and nothing deeper or hidden", () => {
  app("nocam");
  app("@darkroom/lenis-app");
  app("@darkroom/other");
  app("nocam/packages/inner");
  app("@darkroom/deep/one/more");
  app("@darkroom/node_modules/dep");
  app("@darkroom/.worktrees/branch");
  app("node_modules/dep");
  app(".hidden/app");
  app("tools/.cache");
  mkdirSync(join(root, "empty"));
  writeFileSync(join(root, "notes.txt"), "");
  symlinkSync(join(root, "@darkroom/other"), join(root, "linked"));

  expect(findProjects(root)).toEqual(
    ["@darkroom/lenis-app", "@darkroom/other", "linked", "nocam"].map((path) => join(root, path)),
  );
});
