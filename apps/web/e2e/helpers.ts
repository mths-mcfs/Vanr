// Small pieces more than one journey reads the page with. Each returns a locator or a browser context;
// none of them waits or asserts on its own.
import type { APIRequestContext, Browser, Locator, Page } from "@playwright/test";
import type { Text } from "./fixtures.ts";
import type { RunningServer } from "./server.ts";

/**
 * A second browser, signed in as the person (through their API client), in the same language as the
 * first. `viewport` sets its size, as for a tablet.
 */
export async function browserOf(
  browser: Browser,
  server: RunningServer,
  api: APIRequestContext,
  locale: string | undefined,
  viewport?: { width: number; height: number },
) {
  const storageState = await api.storageState();
  return browser.newContext({
    baseURL: server.url,
    storageState,
    ...(locale !== undefined && { locale }),
    ...(viewport !== undefined && { viewport }),
  });
}

/** A day of the calendar's open week, by the label the page gives it in the browser's language. */
export function dayRegion(page: Page, locale: string | undefined, at: Date) {
  const label = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(
    at,
  );
  return page.getByRole("region", { name: label, exact: true });
}

/** A column of the issues board. */
export const lane = (page: Page, t: Text, stage: "todo" | "in_progress" | "reviewing") =>
  page.getByRole("region", { name: new RegExp(`^${t("work", `stage.${stage}`)},`) });

/** An issue's card in a column of the board, by its title. */
export const card = (column: Locator, title: string) =>
  column.getByRole("listitem").filter({ has: column.page().getByRole("link", { name: title }) });
