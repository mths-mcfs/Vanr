import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { memoryStore, STORAGE_KEYS } from "../platform/storage.ts";
import { ROUTE_IDS, ROUTES, SETTINGS_SECTIONS } from "../routes.ts";
import { loadCatalog, NAMESPACES } from "./catalogs.ts";
import { formatMessage, placeholdersOf } from "./format.ts";
import { DEFAULT_LOCALE, detectLocale, LOCALES, matchLocale, rememberLocale } from "./locales.ts";

const MESSAGES = join(import.meta.dir, "..", "messages");

describe("message parity", () => {
  test("the folders on disk are exactly the namespaces, each with one file per language", () => {
    expect(readdirSync(MESSAGES).sort()).toEqual([...NAMESPACES].sort());
    for (const namespace of NAMESPACES) {
      expect(readdirSync(join(MESSAGES, namespace)).sort(), namespace).toEqual(
        LOCALES.map((locale) => `${locale}.ts`).sort(),
      );
    }
  });

  for (const namespace of NAMESPACES) {
    test(`${namespace}: every language has the same keys, kinds and placeholders`, async () => {
      const source = await loadCatalog(namespace, DEFAULT_LOCALE);
      expect(Object.keys(source).length).toBeGreaterThan(0);
      for (const locale of LOCALES) {
        const catalog = await loadCatalog(namespace, locale);
        expect(Object.keys(catalog).sort(), `${namespace}/${locale} keys`).toEqual(
          Object.keys(source).sort(),
        );
        for (const [key, message] of Object.entries(source)) {
          const other = catalog[key];
          if (other === undefined) continue;
          expect(typeof other, `${namespace}/${locale} ${key} kind`).toBe(typeof message);
          expect(placeholdersOf(other), `${namespace}/${locale} ${key} placeholders`).toEqual(
            placeholdersOf(message),
          );
        }
      }
    });

    test(`${namespace}: no message is empty`, async () => {
      for (const locale of LOCALES) {
        for (const [key, message] of Object.entries(await loadCatalog(namespace, locale))) {
          const texts = typeof message === "string" ? [message] : [message.one, message.other];
          for (const text of texts) expect(text.trim(), `${namespace}/${locale} ${key}`).not.toBe("");
        }
      }
    });
  }

  test("a missing key or a changed placeholder is reported (the check itself works)", () => {
    expect(placeholdersOf("Hello {name}")).not.toEqual(placeholdersOf("Olá"));
    expect(placeholdersOf({ one: "{count} agent", other: "{count} agents" })).toEqual(["count"]);
  });

  test("the shell names every workspace route and every settings section", async () => {
    const shell = await loadCatalog("shell", "en");
    for (const id of ROUTE_IDS) {
      if (ROUTES[id].access === "member") expect(shell[`route.${id}`], id).toBeDefined();
    }
    for (const section of Object.keys(SETTINGS_SECTIONS)) {
      expect(shell[`settings.${section}`], section).toBeDefined();
    }
  });

  test("every area says what it is for", async () => {
    for (const area of ["chat", "agents", "wiki", "files", "work", "debates", "control"] as const) {
      expect((await loadCatalog(area, "en"))["area.purpose"], area).toBeDefined();
    }
  });
});

describe("formatMessage", () => {
  test("fills placeholders and leaves unknown ones visible", () => {
    expect(formatMessage("Sent to {email}", { email: "a@b.co" }, "en")).toBe("Sent to a@b.co");
    expect(formatMessage("Sent to {email}", {}, "en")).toBe("Sent to {email}");
  });

  test("picks the plural form with the language's rule", () => {
    const message = { one: "{count} agent", other: "{count} agents" };
    expect(formatMessage(message, { count: 1 }, "en")).toBe("1 agent");
    expect(formatMessage(message, { count: 0 }, "en")).toBe("0 agents");
    // Portuguese counts zero as singular.
    expect(formatMessage({ one: "{count} pessoa", other: "{count} pessoas" }, { count: 0 }, "pt-BR")).toBe(
      "0 pessoa",
    );
  });

  test("numbers are written in the language's format", () => {
    expect(formatMessage("{count} runs", { count: 12500 }, "en")).toBe("12,500 runs");
    expect(formatMessage("{count} execuções", { count: 12500 }, "pt-BR")).toBe("12.500 execuções");
  });
});

describe("picking the language", () => {
  test("the stored choice wins over the browser", () => {
    const store = memoryStore();
    rememberLocale(store, "pt-BR");
    expect(detectLocale({ store, languages: ["en-US"] })).toBe("pt-BR");
  });

  test("otherwise the first browser language the web speaks", () => {
    expect(detectLocale({ store: memoryStore(), languages: ["fr-FR", "pt-PT", "en"] })).toBe("pt-BR");
    expect(detectLocale({ store: memoryStore(), languages: ["en-GB"] })).toBe("en");
  });

  test("otherwise English", () => {
    expect(detectLocale({ store: memoryStore(), languages: ["ja", "de-DE"] })).toBe("en");
    expect(detectLocale({ store: memoryStore(), languages: [] })).toBe("en");
  });

  test("a stored value that is not a language is ignored", () => {
    for (const junk of ['"klingon"', "not json", "42", '{"locale":"en"}']) {
      const store = memoryStore();
      store.setItem(STORAGE_KEYS.locale, junk);
      expect(detectLocale({ store, languages: ["pt-BR"] }), junk).toBe("pt-BR");
    }
  });

  test("matchLocale", () => {
    expect(matchLocale("PT")).toBe("pt-BR");
    expect(matchLocale("en-AU")).toBe("en");
    expect(matchLocale("es-419")).toBeUndefined();
  });
});
