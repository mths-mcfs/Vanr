// Server HTML hydrated in a DOM: generated ids must be the same on both sides, so labels keep
// pointing at their controls after hydration.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { facts, fieldCases } from "./fieldCases.tsx";

beforeAll(() => {
  GlobalRegistrator.register();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("hydration keeps the Field ids", () => {
  for (const c of fieldCases(expect)) {
    test(c.name, async () => {
      const { hydrateRoot } = await import("react-dom/client");
      const html = renderToString(c.element);
      const container = document.createElement("div");
      container.innerHTML = html;
      document.body.append(container);
      const errors: unknown[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      try {
        await act(async () => {
          hydrateRoot(container, c.element, { onRecoverableError: (error) => errors.push(error) });
        });
      } finally {
        console.error = original;
      }
      expect(errors).toEqual([]);
      // Same ids and the same label targets after hydration as in the server HTML.
      const server = facts(html);
      const client = facts(container.innerHTML);
      expect(client.ids).toEqual(server.ids);
      expect(client.fieldFor).toBe(server.fieldFor);
      expect(client.choiceFors).toEqual(server.choiceFors);
      container.remove();
    });
  }
});
