import { describe, expect, test } from "bun:test";
import { initials, sigilPath } from "../src/index.ts";

describe("sigilPath", () => {
  test("the same id always draws the same sigil", () => {
    expect(sigilPath("agt_01JD7Z3K9M")).toBe(sigilPath("agt_01JD7Z3K9M"));
  });

  test("every sigil has the stave and three or four branches", () => {
    for (let i = 0; i < 500; i++) {
      const path = sigilPath(`agt_${i}`);
      expect(path.startsWith("M12 5V19")).toBe(true);
      const branches = path.match(/L/g)?.length ?? 0;
      expect(branches).toBeGreaterThanOrEqual(3);
      expect(branches).toBeLessThanOrEqual(4);
    }
  });

  test("ids that differ by one character usually draw different sigils", () => {
    const paths = new Set<string>();
    for (let i = 0; i < 1000; i++) paths.add(sigilPath(`agt_01JD7Z${i.toString(36).padStart(4, "0")}`));
    expect(paths.size).toBeGreaterThan(850);
  });

  test("a workspace-sized set of agents gets distinct sigils", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `agt_01JD7Z${i.toString().padStart(4, "0")}`);
    expect(new Set(ids.map(sigilPath)).size).toBe(40);
  });

  test("an empty id still draws a sigil", () => {
    expect(sigilPath("")).toMatch(/^M12 5V19(M\d+ \d+L\d+ \d+){3,4}$/);
  });
});

describe("initials", () => {
  test.each([
    ["Ana Beatriz Souza", "AS"],
    ["jonas", "J"],
    ["  Íris   Valença ", "ÍV"],
    ["", "?"],
    ["李 小龙", "李小"],
  ])("%p -> %p", (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});
