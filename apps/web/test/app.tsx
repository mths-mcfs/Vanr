// Renders the whole web app against the fake server, for tests of what a person sees and does.
//
//   const app = await renderApp({ path: "/login" });
//   await app.user.type(screen.getByLabelText("Email"), "ana@birchwood.example");
//
// Nothing here waits for real time: the clock is manual (`app.clock.advance(ms)`) and a slow
// answer is a held one (`app.server.hold("signIn")`).
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManualClock } from "@vanr/client/testing";
import { type CookieJar, FakeServer, newJar, type SeedName } from "../dev/fake-server.ts";
import { createFetchTransport } from "../src/api/index.ts";
import { AppProviders } from "../src/app/context.tsx";
import { type AppRuntime, createRuntime } from "../src/app/runtime.ts";
import { type KeyValueStore, memoryStore } from "../src/platform/storage.ts";

export const TEST_NOW = new Date(Date.UTC(2026, 10, 14, 12));

/** A fake server at the test's fixed date, to prepare before the app renders. */
export const newServer = (seed: SeedName = "team") => new FakeServer({ seed, now: () => TEST_NOW });

export type RenderOptions = {
  path: string;
  seed?: SeedName;
  /** A fake server to reuse, e.g. to render a second "browser" against the same data. */
  server?: FakeServer;
  /** Signs this seeded person in before the app starts. */
  signedInAs?: string;
  languages?: readonly string[];
  /** Storage to reuse across two renders, as a reload would. */
  store?: KeyValueStore;
  tabStore?: KeyValueStore;
  jar?: CookieJar;
};

/** The app's runtime over the fake server, without rendering it: for tests of one piece. */
export function newTestRuntime(options: RenderOptions) {
  const server = options.server ?? newServer(options.seed);
  const jar = options.jar ?? newJar();
  if (options.signedInAs !== undefined) jar.session = server.sessionFor(options.signedInAs);
  // The client's manual clock starts at zero; the app's day is TEST_NOW.
  const clock = new ManualClock();
  clock.advance(TEST_NOW.getTime());
  const tabStore = options.tabStore ?? memoryStore();
  const runtime: AppRuntime = createRuntime({
    transport: (locale) => createFetchTransport({ fetch: server.fetch(jar), locale }),
    history: createMemoryHistory({ initialEntries: [options.path] }),
    store: options.store ?? memoryStore(),
    tabStore,
    // The number a reconnection draws decides its wait; a fixed one keeps the wait the same.
    openSocket: { baseUrl: "https://vanr.test", createSocket: server.socketFactory(jar), random: () => 0 },
    clock,
    languages: options.languages ?? ["en-US"],
    origin: "https://vanr.test",
    // A failed call is tried again at once instead of after a real wait.
    retryDelayMs: 0,
  });
  return { server, jar, clock, tabStore, runtime };
}

export async function renderApp(options: RenderOptions) {
  const { server, jar, clock, tabStore, runtime } = newTestRuntime(options);
  const user = userEvent.setup();
  // The first render suspends on the route's lazy screen; awaiting act lets it settle.
  const view = await act(async () =>
    render(
      <AppProviders runtime={runtime}>
        <RouterProvider router={runtime.router} />
      </AppProviders>,
    ),
  );
  return {
    ...view,
    user,
    server,
    jar,
    clock,
    runtime,
    /** Where this "tab" keeps its drafts; pass it to another render to act as a reload. */
    tabStore,
    /** The open address: path and query string. */
    address: () => `${runtime.router.state.location.pathname}${runtime.router.state.location.searchStr}`,
    /** Moves the clock inside React's batching, so timers that set state are flushed. */
    advance: (ms: number) => act(async () => clock.advance(ms)),
  };
}

export type App = Awaited<ReturnType<typeof renderApp>>;

/** Resizes the test window, so the frame switches between the docked sidebar and the drawer. */
export async function setViewportWidth(width: number): Promise<void> {
  const api: unknown = Reflect.get(window, "happyDOM");
  if (
    typeof api !== "object" ||
    api === null ||
    !("setViewport" in api) ||
    typeof api.setViewport !== "function"
  ) {
    throw new Error("the test window cannot be resized");
  }
  const resize = api.setViewport.bind(api);
  await act(async () => {
    resize({ width, height: 844 });
  });
}
