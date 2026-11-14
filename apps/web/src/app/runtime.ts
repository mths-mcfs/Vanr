// Everything the app is made of, built once: the API, the cache, the session, the router. main.tsx
// builds it over the browser; tests build it over the fake server.
import { QueryClient } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import { createWebApi, type WebApi, type WebTransport } from "../api/index.ts";
import { detectLocale, type Locale } from "../i18n/locales.ts";
import type { Clock } from "../platform/clock.tsx";
import type { KeyValueStore } from "../platform/storage.ts";
import type { SocketSource } from "../realtime/connection.ts";
import { href } from "../routes.ts";
import { createDraftStore, type DraftStore } from "../session/drafts.ts";
import { createSessionGate, type SessionGate } from "../session/gate.ts";
import { safeRedirect } from "../session/redirect.ts";
import { createSession, type Session } from "../session/session.ts";
import { type AppRouter, createAppRouter } from "./router.tsx";

export type AppRuntime = {
  /** The shared client and the sign-in calls (see src/api). */
  api: WebApi;
  queryClient: QueryClient;
  session: Session;
  gate: SessionGate;
  drafts: DraftStore;
  router: AppRouter;
  /** Where the real-time connection of a workspace opens its socket. */
  openSocket: SocketSource;
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
  transport: (locale: () => Locale) => WebTransport;
  history: RouterHistory;
  store: KeyValueStore;
  /** Where drafts are kept: they last as long as the tab. */
  tabStore: KeyValueStore;
  openSocket: SocketSource;
  clock: Clock;
  languages: readonly string[];
  origin: string;
  /** Wait before a failed query is tried again. Left out, the wait grows with each try. */
  retryDelayMs?: number;
};

export function createRuntime(options: RuntimeOptions): AppRuntime {
  const language = { current: detectLocale({ store: options.store, languages: options.languages }) };
  // Which queries are retried, and how often, is the client's rule (see `shouldRetry`).
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        ...(options.retryDelayMs !== undefined && { retryDelay: options.retryDelayMs }),
      },
    },
  });
  const drafts = createDraftStore(options.tabStore);
  // The gate is built before the router it navigates with.
  let sendToSignIn = () => {};
  const gate = createSessionGate({ drafts, onEnded: () => sendToSignIn() });
  const api = createWebApi(
    options.transport(() => language.current),
    { onUnauthorized: () => gate.ended(), clock: options.clock },
  );
  const session = createSession({ client: api.client, queryClient, gate });
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
