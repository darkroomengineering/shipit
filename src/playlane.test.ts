import { describe, expect, test } from "bun:test";
import { buildNumberFor, buildOf, versionCodeFor } from "./playlane.ts";

const at = new Date(Date.UTC(2026, 10, 12, 9, 5, 42));

describe("build numbers", () => {
  test("iOS build number is the UTC minute as yyyyMMddHHmm", () => {
    expect(buildNumberFor(at)).toBe("202611120905");
    expect(buildNumberFor(new Date(Date.UTC(2027, 0, 1, 0, 0)))).toBe("202701010000");
  });

  test("Android version code is whole minutes since the epoch minus nocam's offset", () => {
    expect(versionCodeFor(at)).toBe(Math.floor(at.getTime() / 60_000) - 29_000_000);
    expect(versionCodeFor(new Date(at.getTime() + 60_000))).toBe(versionCodeFor(at) + 1);
    expect(versionCodeFor(at)).toBeLessThan(2_100_000_000);
  });

  test("a version code maps back to the build number of the same run", () => {
    expect(buildOf(versionCodeFor(at))).toBe(buildNumberFor(at));
  });

  test("later runs get larger numbers on both platforms", () => {
    const later = new Date(at.getTime() + 24 * 60 * 60 * 1000);
    expect(Number(buildNumberFor(later))).toBeGreaterThan(Number(buildNumberFor(at)));
    expect(versionCodeFor(later)).toBeGreaterThan(versionCodeFor(at));
  });
});
