// Small pieces the frame needs from the browser and the router.
import { useLocation, useMatches } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import { ROUTE_IDS, ROUTES, type RouteId } from "../routes.ts";

/** At this width and above the sidebar sits beside the content; below it, it is a drawer. */
export const DOCKED_SIDEBAR_QUERY = "(min-width: 900px)";

/** Whether a media query matches, following the window. True where the browser cannot say. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : true),
    () => true,
  );
}

const trim = (path: string) => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);

/** The id of the open route in the route table, or undefined on an address outside it. */
export function useCurrentRouteId(): RouteId | undefined {
  const fullPath = useMatches({ select: (matches) => matches.at(-1)?.fullPath });
  if (typeof fullPath !== "string") return undefined;
  return ROUTE_IDS.find((id) => ROUTES[id].path === trim(fullPath));
}

/** Runs `handler` every time the address changes (not on the first render). */
export function useOnNavigate(handler: () => void): void {
  const address = useLocation({ select: (location) => location.href });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the address is the trigger; the handler is read fresh.
  useEffect(() => {
    return () => handler();
  }, [address]);
}

/** Ctrl+K or Command+K, wherever the focus is. */
export function useCommandKey(run: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);
}
