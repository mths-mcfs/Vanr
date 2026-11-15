// The providers every screen sits under, and access to the runtime they were built from.

import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@vanr/ui";
import { createContext, type ReactNode, Suspense, useContext } from "react";
import { ApiProvider } from "../api/index.ts";
import { LocaleProvider, useMessages } from "../i18n/react.tsx";
import { ClockProvider } from "../platform/clock.tsx";
import type { AppRuntime } from "./runtime.ts";
import { ThemeProvider } from "./theme.tsx";

const RuntimeContext = createContext<AppRuntime | null>(null);

export function useRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) throw new Error("useRuntime must be used inside <AppProviders>");
  return runtime;
}

function Toasts({ children }: { children: ReactNode }) {
  const t = useMessages("common");
  return (
    <ToastProvider label={t("toast.region")} closeLabel={t("action.close")}>
      {children}
    </ToastProvider>
  );
}

export function AppProviders({ runtime, children }: { runtime: AppRuntime; children: ReactNode }) {
  return (
    <RuntimeContext.Provider value={runtime}>
      <QueryClientProvider client={runtime.queryClient}>
        <ApiProvider api={runtime.api}>
          <ClockProvider clock={runtime.clock}>
            <ThemeProvider store={runtime.store}>
              <LocaleProvider
                initial={runtime.language.current}
                store={runtime.store}
                onChange={(locale) => {
                  runtime.language.current = locale;
                }}
              >
                <Suspense fallback={null}>
                  <Toasts>{children}</Toasts>
                </Suspense>
              </LocaleProvider>
            </ThemeProvider>
          </ClockProvider>
        </ApiProvider>
      </QueryClientProvider>
    </RuntimeContext.Provider>
  );
}
