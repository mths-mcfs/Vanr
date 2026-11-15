import "./styles/app.css";
import { createBrowserHistory, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createFetchTransport } from "./api/index.ts";
import { AppProviders } from "./app/context.tsx";
import { createRuntime } from "./app/runtime.ts";
import { systemClock } from "./platform/clock.tsx";
import { browserStore } from "./platform/storage.ts";
import { browserSocketOpener } from "./realtime/connection.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("web: #root is missing from index.html");

const runtime = createRuntime({
  // The one place the wire is chosen (see src/api/index.ts).
  transport: (locale) => createFetchTransport({ locale }),
  history: createBrowserHistory(),
  store: browserStore("localStorage"),
  tabStore: browserStore("sessionStorage"),
  openSocket: browserSocketOpener(window.location.origin),
  clock: systemClock,
  languages: navigator.languages,
  origin: window.location.origin,
});

createRoot(root).render(
  <StrictMode>
    <AppProviders runtime={runtime}>
      <RouterProvider router={runtime.router} />
    </AppProviders>
  </StrictMode>,
);
