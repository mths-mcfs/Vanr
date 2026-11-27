// The message namespaces and the loader. One namespace per area, named after the area, plus the
// two the shell shares with everyone: `common` (words every screen uses) and `errors` (the text of
// each server error code), and two more of the shell's own screens, `settings` and `inbox`, so the
// frame does not fetch their text on every page. Each namespace is one file per language, fetched
// on first use.
import type account from "../messages/account/en.ts";
import type agents from "../messages/agents/en.ts";
import type chat from "../messages/chat/en.ts";
import type common from "../messages/common/en.ts";
import type control from "../messages/control/en.ts";
import type debates from "../messages/debates/en.ts";
import type errors from "../messages/errors/en.ts";
import type files from "../messages/files/en.ts";
import type inbox from "../messages/inbox/en.ts";
import type settings from "../messages/settings/en.ts";
import type shell from "../messages/shell/en.ts";
import type wiki from "../messages/wiki/en.ts";
import type work from "../messages/work/en.ts";
import { AREAS } from "../routes.ts";
import type { Catalog } from "./format.ts";
import type { Locale } from "./locales.ts";

export const NAMESPACES = [...AREAS, "common", "errors", "settings", "inbox"] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** The English catalog of each namespace: the source of the key and parameter types. */
export type Catalogs = {
  account: typeof account;
  shell: typeof shell;
  chat: typeof chat;
  agents: typeof agents;
  wiki: typeof wiki;
  files: typeof files;
  work: typeof work;
  debates: typeof debates;
  control: typeof control;
  common: typeof common;
  errors: typeof errors;
  settings: typeof settings;
  inbox: typeof inbox;
};

/**
 * A promise that also says, in the fields React's `use` reads, whether it has settled. `use` then
 * returns a catalog that already arrived without suspending, so a screen whose catalogs were
 * fetched ahead renders in one pass.
 */
type Tracked<T> = Promise<T> & { status?: "pending" | "fulfilled" | "rejected"; value?: T; reason?: unknown };

const loading = new Map<string, Tracked<Catalog>>();

/** The catalog of a namespace in a language. The same promise is returned on every call. */
export function loadCatalog(namespace: Namespace, locale: Locale): Promise<Catalog> {
  const id = `${namespace}/${locale}`;
  let pending = loading.get(id);
  if (pending === undefined) {
    const tracked: Tracked<Catalog> = import(`../messages/${namespace}/${locale}.ts`).then(
      (module: { default: Catalog }) => module.default,
    );
    tracked.status = "pending";
    tracked.then(
      (catalog) => {
        tracked.status = "fulfilled";
        tracked.value = catalog;
      },
      (reason: unknown) => {
        tracked.status = "rejected";
        tracked.reason = reason;
      },
    );
    loading.set(id, tracked);
    pending = tracked;
  }
  return pending;
}

/** Fetches several catalogs at once, so a screen that needs them does not wait for each in turn. */
export function preloadCatalogs(namespaces: readonly Namespace[], locale: Locale): Promise<unknown> {
  return Promise.all(namespaces.map((namespace) => loadCatalog(namespace, locale)));
}

/** Every namespace that was asked for so far, in any language. */
export function requestedNamespaces(): Namespace[] {
  const names = new Set([...loading.keys()].map((id) => id.split("/")[0]));
  return NAMESPACES.filter((namespace) => names.has(namespace));
}
