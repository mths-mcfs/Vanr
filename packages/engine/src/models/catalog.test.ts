import { expect, test } from "bun:test";
import { ADVISOR_PAIRS, advisorPairOk } from "./catalog";

test("advisor pairs only see their own keys", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    expect(advisorPairOk(name, "claude-opus-5-5")).toBe(false);
    expect(ADVISOR_PAIRS[name]).toBeUndefined();
  }
  expect(advisorPairOk("claude-haiku-5-5", "claude-opus-5-5")).toBe(true);
});
