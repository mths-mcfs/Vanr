// Loaded before every web test (bunfig.toml): gives the process a DOM before React and Radix are
// imported, fetches the messages of every language once, and cleans the page between tests.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://vanr.test/" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { afterEach } = await import("bun:test");
const { cleanup, configure } = await import("@testing-library/react");
const { NAMESPACES, preloadCatalogs } = await import("../src/i18n/catalogs.ts");
const { LOCALES } = await import("../src/i18n/locales.ts");

// A first render imports a whole area; give it more than the default second.
configure({ asyncUtilTimeout: 4000 });
// With the catalogs in memory, a screen never suspends on its messages in a test.
await Promise.all(LOCALES.map((locale) => preloadCatalogs(NAMESPACES, locale)));

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("lang");
});
