// The validators: they accept exactly what the contract describes, strip what it doesn't, say where a value
// went wrong, and the generated file is what the generator makes from today's contract.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CONTRACT_DIR, generate, OUTPUT } from "../scripts/gen-schemas.ts";
import * as C from "../src/contract-schemas.ts";
import * as s from "../src/schema.ts";

describe("combinators", () => {
  test("object keeps declared keys only and leaves absent optional keys out", () => {
    const schema = s.object({ a: s.string, b: s.optional(s.number) });
    expect(s.parse(schema, { a: "x", extra: 1 })).toEqual({ a: "x" });
    expect(Object.keys(s.parse(schema, { a: "x" }))).toEqual(["a"]);
  });

  test("an index signature keeps the other keys, checked by the rest schema", () => {
    const schema = s.object({ a: s.number }, s.number);
    expect(s.parse(schema, { a: 0, n: 1 })).toEqual({ a: 0, n: 1 });
    expect(schema.check({ a: 0, n: "1" }, "$")).toEqual({
      ok: false,
      issue: { path: "$.n", expected: "number" },
    });
  });

  test("the failure names the deepest path", () => {
    const schema = s.object({ list: s.array(s.object({ id: s.string })) });
    const r = schema.check({ list: [{ id: "1" }, { id: 2 }] }, "$");
    expect(r).toEqual({ ok: false, issue: { path: "$.list[1].id", expected: "string" } });
  });

  test("numbers must be finite; literals must be in the set", () => {
    expect(s.number.check(Number.NaN, "$").ok).toBe(false);
    expect(s.number.check(Number.POSITIVE_INFINITY, "$").ok).toBe(false);
    expect(s.literal("a", "b").check("c", "$").ok).toBe(false);
  });

  test("a closed-key map drops keys it doesn't know instead of failing", () => {
    const schema = s.partialRecord(s.literal("a", "b"), s.boolean);
    expect(s.parse(schema, { a: true, z: false })).toEqual({ a: true });
  });

  test("a union tells which member got furthest", () => {
    const schema = s.union(
      s.object({ kind: s.literal("x"), n: s.number }),
      s.object({ kind: s.literal("y") }),
    );
    expect(schema.check({ kind: "x", n: "1" }, "$")).toEqual({
      ok: false,
      issue: { path: "$.n", expected: "number" },
    });
  });

  test("tuples check length and each slot", () => {
    const schema = s.tuple(s.number, s.number);
    expect(s.parse(schema, [1, 2])).toEqual([1, 2]);
    expect(schema.check([1], "$").ok).toBe(false);
  });
});

describe("contract schemas", () => {
  test("the generated file matches the contract today", () => {
    expect(readFileSync(OUTPUT, "utf8")).toBe(generate(CONTRACT_DIR));
  });

  test("a recursive or forward reference resolves", () => {
    const pin = {
      channelId: "ch_1",
      pinnedAt: "2026-11-02T09:00:00.000Z",
      pinnedBy: { id: "user_ada", type: "person" },
    };
    // MessagePin refers to Message, which refers to types the generated file declares after it.
    expect(C.MessagePin.check(pin, "$")).toEqual({
      ok: false,
      issue: { path: "$.message", expected: "object" },
    });
  });

  test("a file's content is a union discriminated by kind", () => {
    expect(s.parse(C.FileContent, { kind: "diagram", mermaid: "graph TD" })).toEqual({
      kind: "diagram",
      mermaid: "graph TD",
    });
    expect(C.FileContent.check({ kind: "diagram" }, "$").ok).toBe(false);
  });
});
