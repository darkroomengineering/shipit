import { describe, expect, test } from "bun:test";
import { CREDIT, withCredit } from "./appstore.ts";

const count = (text: string) => text.split(CREDIT).length - 1;

describe("withCredit", () => {
  test("appends the credit line as the last paragraph", () => {
    expect(withCredit("Track the tides.\n")).toBe(`Track the tides.\n\n${CREDIT}`);
  });

  test("adds it exactly once, however many times it runs", () => {
    const once = withCredit("Track the tides.");
    expect(withCredit(once)).toBe(once);
    expect(count(withCredit(withCredit(once)))).toBe(1);
  });

  test("leaves a description that already carries it unchanged", () => {
    const written = `Track the tides.\n\n${CREDIT}\n\nMade in Buenos Aires.`;
    expect(withCredit(written)).toBe(written);
  });

  test("an empty description becomes the credit alone", () => {
    expect(withCredit("")).toBe(CREDIT);
  });
});
