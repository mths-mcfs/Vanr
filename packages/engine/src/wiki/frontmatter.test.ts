import { describe, expect, test } from "bun:test";
import { formatFrontmatter, splitFrontmatter, vaultMeta } from "./frontmatter";

describe("frontmatter", () => {
  test("splits data and body; without a block, everything is body", () => {
    expect(splitFrontmatter("---\nstatus: active\nn: 2\n---\n# Hi\n")).toEqual({
      data: { status: "active", n: 2 },
      body: "# Hi\n",
      error: null,
    });
    expect(splitFrontmatter("# None\n---\nx: 1\n---\n")).toEqual({
      data: {},
      body: "# None\n---\nx: 1\n---\n",
      error: null,
    });
    expect(splitFrontmatter("---\n---\nbody").body).toBe("body");
  });

  test("attack: a YAML alias bomb is rejected without hanging", () => {
    const lines = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
    for (let i = 0; i < 9; i++) {
      const prev = String.fromCharCode(97 + i);
      const next = String.fromCharCode(98 + i);
      lines.push(`${next}: &${next} [${Array(9).fill(`*${prev}`).join(",")}]`);
    }
    const started = performance.now();
    const out = splitFrontmatter(`---\n${lines.join("\n")}\n---\nbody`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.data).toEqual({});
    expect(out.error).toBe("alias_limit");
    expect(out.body).toBe("body");
  });

  test("attack: __proto__ and constructor in the YAML do not pollute the prototype", () => {
    const out = splitFrontmatter("---\n__proto__:\n  admin: true\nconstructor: x\nok: 1\n---\n");
    expect(out.data).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(Object.getPrototypeOf(out.data)).toBe(Object.prototype);
  });

  test("invalid YAML or YAML that is not a map becomes an error, body kept", () => {
    expect(splitFrontmatter("---\n- a\n- b\n---\nc")).toEqual({ data: {}, body: "c", error: "not_a_map" });
    expect(splitFrontmatter("---\na: [1, 2\n---\nc").error).not.toBeNull();
  });

  test("round trip: formatFrontmatter + splitFrontmatter", () => {
    const data = { title: "Page", tags: ["a", "b"], n: 3, ok: true, d: "2026-10-22" };
    const text = `${formatFrontmatter(data)}body`;
    expect(splitFrontmatter(text)).toEqual({ data, body: "body", error: null });
    expect(formatFrontmatter({})).toBe("");
  });

  test("an empty block closes at once: the --- after it belongs to the body", () => {
    expect(splitFrontmatter("---\n---\n---\n\nText\n\n---\n")).toEqual({
      data: {},
      body: "---\n\nText\n\n---\n",
      error: null,
    });
  });

  test("vaultMeta separates title, tags (with and without #) and aliases from the rest", () => {
    expect(
      vaultMeta({ Title: "T", tags: ["#a", "b"], tag: "c", aliases: "X, Y", alias: ["Z"], status: "ok" }),
    ).toEqual({ title: "T", tags: ["a", "b", "c"], aliases: ["X", "Y", "Z"], rest: { status: "ok" } });
  });
});
