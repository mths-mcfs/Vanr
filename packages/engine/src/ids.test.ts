import { describe, expect, test } from "bun:test";
import { newId, newToken, sha256Hex } from "./ids";

describe("ids", () => {
  test("newId uses the prefix and 16 random characters", () => {
    const id = newId("workspace");
    expect(id).toMatch(/^workspace_[0-9a-z]{16}$/);
    expect(newId("workspace")).not.toBe(id);
  });

  test("newToken is base64url without padding", () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("sha256Hex", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
