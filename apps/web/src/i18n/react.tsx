// The language of the interface, for components.
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { KeyValueStore } from "../platform/storage.ts";
import {
  type Catalogs,
  loadCatalog,
  type Namespace,
  preloadCatalogs,
  requestedNamespaces,
} from "./catalogs.ts";
import { type Catalog, formatMessage, type MessageParams, type Translate } from "./format.ts";
import { type Locale, rememberLocale } from "./locales.ts";

type LocaleContextValue = { locale: Locale; setLocale: (locale: Locale) => void };

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  initial,
  store,
  onChange,
  children,
}: {
  initial: Locale;
  /** Where the choice is remembered. */
  store: KeyValueStore;
  /** Told about every change, so calls to the server carry the new language. */
  onChange?: (locale: Locale) => void;
  children: ReactNode;
}) {
  const [locale, setCurrent] = useState(initial);
  const setLocale = useCallback(
    (next: Locale) => {
      rememberLocale(store, next);
      onChange?.(next);
      // The messages on screen are fetched in the new language first, so the page does not blank.
      void preloadCatalogs(requestedNamespaces(), next).then(
        () => setCurrent(next),
        () => setCurrent(next),
      );
    },
    [store, onChange],
  );
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (value === null) throw new Error("useLocale must be used inside <LocaleProvider>");
  return value;
}

function translator(catalog: Catalog, locale: Locale) {
  return (key: string, params?: MessageParams): string => {
    const message = catalog[key];
    return message === undefined ? key : formatMessage(message, params, locale);
  };
}

/**
 * The messages of a namespace in the current language. Suspends while the file loads; the keys and
 * the parameters of each message are checked against the English catalog.
 */
export function useMessages<N extends Namespace>(namespace: N): Translate<Catalogs[N]> {
  const { locale } = useLocale();
  const catalog = use(loadCatalog(namespace, locale));
  return useMemo(() => translator(catalog, locale), [catalog, locale]);
}

/**
 * A message looked up by a key that is only known at run time (a server error code, a route id):
 * returns undefined when the namespace has no such key.
 */
export function useLookup(namespace: Namespace): (key: string, params?: MessageParams) => string | undefined {
  const { locale } = useLocale();
  const catalog = use(loadCatalog(namespace, locale));
  return useCallback(
    (key, params) => {
      const message = catalog[key];
      return message === undefined ? undefined : formatMessage(message, params, locale);
    },
    [catalog, locale],
  );
}
