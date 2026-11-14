// Everything the app is made of, built once: the API, the cache, the session, the router. main.tsx
// builds it over the browser; tests build it over the fake server.
import { QueryClient } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import { type Api, type ApiError, createApi, type Transport } from "../api/index.ts";
import { detectLocale, type Locale } from "../i18n/locales.ts";
import type { Clock } from "../platform/clock.tsx";
import type { KeyValueStore } from "../platform/storage.ts";
import type { SocketOpener } from "../realtime/connection.ts";
import { href } from "../routes.ts";
import { createDraftStore, type DraftStore } from "../session/drafts.ts";
import { createSessionGate, type SessionGate } from "../session/gate.ts";
import { safeRedirect } from "../session/redirect.ts";
import { createSession, type Session } from "../session/session.ts";
import { type AppRouter, createAppRouter } from "./router.tsx";

export type AppRuntime = {
  api: Api;
  queryClient: QueryClient;
  session: Session;
  gate: SessionGate;
  drafts: DraftStore;
  router: AppRouter;
  openSocket: SocketOpener;
  clock: Clock;
  /** Choices that outlive the tab: language, theme, sidebar, last workspace. */
  store: KeyValueStore;
  /** The interface language: the starting one, then whatever the person picks. */
  language: { current: Locale };
  /** The web's own origin, for the links it asks the server to email. */
  origin: string;
};

export type RuntimeOptions = {
  /** Builds the wire. It receives the current language, to send with every call. */
  transport: (locale: () => Locale) => Transport;
  history: RouterHistory;
  store: KeyValueStore;
  /** Where drafts are kept: they last as long as the tab. */
  tabStore: KeyValueStore;
  openSocket: SocketOpener;
  clock: Clock;
  languages: readonly string[];
  origin: string;
};

/** Failures worth a second try: no answer, a timeout or a server error. Never a 4xx. */
export function shouldRetryQuery(failureCount: number, error: ApiError): boolean {
  return error.retryable && error.status !== 429 && failureCount < MAX_QUERY_RETRIES;
}
export const MAX_QUERY_RETRIES = 2;

export function createRuntime(options: RuntimeOptions): AppRuntime {
  const language = { current: detectLocale({ store: options.store, languages: options.languages }) };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => shouldRetryQuery(failureCount, error as ApiError),
        retryDelay: 0,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
  const drafts = createDraftStore(options.tabStore);
  // The gate is built before the router it navigates with.
  let sendToSignIn = () => {};
  const gate = createSessionGate({ drafts, onEnded: () => sendToSignIn() });
  const api = createApi(
    options.transport(() => language.current),
    { onSessionEnded: () => gate.ended() },
  );
  const session = createSession({ api, queryClient, gate });
  const router = createAppRouter({ session, store: options.store, language }, options.history);
  sendToSignIn = () => {
    const from = router.state.location;
    const back = safeRedirect(`${from.pathname}${from.searchStr}${from.hash === "" ? "" : `#${from.hash}`}`);
    session.forget();
    void router.navigate({
      to: href("login", {}),
      search: { ...(back !== undefined && { redirect: back }), reason: "ended" },
    });
  };
  return {
    api,
    queryClient,
    session,
    gate,
    drafts,
    router,
    openSocket: options.openSocket,
    clock: options.clock,
    store: options.store,
    language,
    origin: options.origin,
  };
}
