// Light, dark or whatever the system uses. The choice is an attribute on <html>, which the design
// tokens read; "system" removes it.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { type KeyValueStore, readStored, STORAGE_KEYS, writeStored } from "../platform/storage.ts";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
const ThemeSchema = z.enum(THEMES);

export function readTheme(store: KeyValueStore): Theme {
  return readStored(store, STORAGE_KEYS.theme, ThemeSchema) ?? "system";
}

export function isTheme(value: string): value is Theme {
  return ThemeSchema.safeParse(value).success;
}

function applyTheme(theme: Theme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);

export function ThemeProvider({ store, children }: { store: KeyValueStore; children: ReactNode }) {
  const [theme, setCurrent] = useState(() => readTheme(store));
  useEffect(() => applyTheme(theme), [theme]);
  const setTheme = useCallback(
    (next: Theme) => {
      writeStored(store, STORAGE_KEYS.theme, next);
      setCurrent(next);
    },
    [store],
  );
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
