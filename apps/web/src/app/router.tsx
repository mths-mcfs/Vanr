// The router, built from the route table. The shell owns it: an area fills the ids the table
// reserves for it (see src/routes.ts) and never adds a route here.
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type ParsedLocation,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { type Namespace, preloadCatalogs } from "../i18n/catalogs.ts";
import type { Locale } from "../i18n/locales.ts";
import type { KeyValueStore } from "../platform/storage.ts";
import {
  type Access,
  href,
  REDIRECTS,
  ROUTE_IDS,
  ROUTES,
  type RouteId,
  WORKSPACE_PREFIX,
} from "../routes.ts";
import { safeRedirect } from "../session/redirect.ts";
import { type Session, startAddress } from "../session/session.ts";
import { loadScreen } from "./areas.ts";

export type RouterDeps = { session: Session; store: KeyValueStore; language: { current: Locale } };

/** The message namespaces a route's screen reads: its area's, and the ones every screen shares. */
function namespacesOf(id: RouteId): Namespace[] {
  const shared: Namespace[] = ["common", "errors"];
  const { area, access } = ROUTES[id];
  return access === "member" ? [area, "shell", ...shared] : [area, ...shared];
}

/** The query string as plain text values: no JSON, so a numeric token stays a string. */
function parseSearch(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}

function stringifySearch(search: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string" && value !== "") query.set(key, value);
    else if (typeof value === "number" || typeof value === "boolean") query.set(key, String(value));
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

type GuardInput = { location: ParsedLocation; params: Record<string, string> };

/** The address of a location, to come back to after signing in. */
const addressOf = (location: ParsedLocation) =>
  `${location.pathname}${location.searchStr}${location.hash === "" ? "" : `#${location.hash}`}`;

/** The check a route runs before it renders, by who may open it. */
function guardFor(deps: RouterDeps, id: RouteId, access: Access) {
  return async ({ location, params }: GuardInput) => {
    if (access === "public") {
      // The root address has no screen of its own unless it carries a waitlist confirmation.
      if (id !== "root" || new URLSearchParams(location.searchStr).has("confirm")) return;
      const me = await deps.session.load();
      throw redirect({ to: me === null ? href("login", {}) : startAddress(deps.store, me), replace: true });
    }
    const me = await deps.session.load();
    if (access === "guest") {
      if (me === null) return;
      const wanted = safeRedirect(new URLSearchParams(location.searchStr).get("redirect"));
      throw redirect({ to: wanted ?? startAddress(deps.store, me), replace: true });
    }
    if (me === null) {
      throw redirect({ to: href("login", {}), search: { redirect: addressOf(location) }, replace: true });
    }
    if (access === "member" && !me.workspaces.some((workspace) => workspace.id === params.workspaceId)) {
      // The cached answer may predate an invitation just accepted or a workspace just created.
      await deps.session.load(true);
    }
  };
}

export function createAppRouter(
  deps: RouterDeps,
  history: RouterHistory,
  // The layouts are injected so this module does not import every screen eagerly.
  layouts: () => Promise<{
    Root: ComponentType;
    Frame: ComponentType;
    Reserved: ComponentType<{ id: RouteId }>;
    RouteFailed: ComponentType<{ error: unknown; reset: () => void }>;
    NotFound: ComponentType;
    Pending: ComponentType;
  }> = () => import("./layouts.tsx"),
) {
  const layout = <Key extends "Root" | "Frame" | "NotFound" | "Pending">(key: Key) =>
    lazyRouteComponent(async () => ({ default: (await layouts())[key] }));
  const failed = lazyRouteComponent(async () => ({ default: (await layouts()).RouteFailed }));
  const screen = (id: RouteId) =>
    lazyRouteComponent(async () => {
      const [built, { Reserved }] = await Promise.all([
        loadScreen(id),
        layouts(),
        preloadCatalogs(namespacesOf(id), deps.language.current),
      ]);
      return { default: built ?? (() => <Reserved id={id} />) };
    });

  const root = createRootRoute({
    component: layout("Root"),
    notFoundComponent: layout("NotFound"),
    errorComponent: failed,
  });
  const workspace = createRoute({
    getParentRoute: () => root,
    path: WORKSPACE_PREFIX,
    component: layout("Frame"),
    beforeLoad: guardFor(deps, "home", "member"),
  });

  const outside = [];
  const inside = [];
  for (const id of ROUTE_IDS) {
    const { path, access } = ROUTES[id];
    if (access === "member") {
      inside.push(
        createRoute({
          getParentRoute: () => workspace,
          path: path.slice(WORKSPACE_PREFIX.length) || "/",
          component: screen(id),
          errorComponent: failed,
        }),
      );
    } else {
      outside.push(
        createRoute({
          getParentRoute: () => root,
          path,
          component: screen(id),
          beforeLoad: guardFor(deps, id, access),
        }),
      );
    }
  }
  for (const { from, to } of REDIRECTS) {
    inside.push(
      createRoute({
        getParentRoute: () => workspace,
        path: from.slice(WORKSPACE_PREFIX.length),
        beforeLoad: ({ params }: { params: Record<string, string> }) => {
          throw redirect({ to, params, replace: true });
        },
      }),
    );
  }

  return createRouter({
    routeTree: root.addChildren([...outside, workspace.addChildren(inside)]),
    history,
    parseSearch,
    stringifySearch,
    defaultPendingComponent: layout("Pending"),
    defaultPendingMs: 200,
    defaultPendingMinMs: 0,
    defaultPreload: false,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
