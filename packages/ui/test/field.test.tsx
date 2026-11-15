import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { facts, fieldCases } from "./fieldCases.tsx";

describe("Field wiring, case by case", () => {
  for (const c of fieldCases(expect)) {
    test(c.name, () => {
      const f = facts(renderToString(c.element));
      // Invariants for every case: ids are unique, and every `for` lands on a form control.
      expect(new Set(f.ids).size).toBe(f.ids.length);
      for (const target of [...f.html.matchAll(/ for="([^"]+)"/g)].map((m) => m[1])) {
        expect(f.controls).toContain(target ?? "");
      }
      c.expect(f);
    });
  }
});
