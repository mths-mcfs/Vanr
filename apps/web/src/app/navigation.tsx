// Navigation by route id. Areas link and navigate with these, never with a path string, so an
// address only ever comes from the route table.
import { Link, useLocation, useParams, useRouter } from "@tanstack/react-router";
import { type ComponentPropsWithRef, useCallback, useEffect, useMemo, useRef } from "react";
import type { z } from "zod";
import { type ParamsOf, paramNames, ROUTES, type RouteId } from "../routes.ts";
import { addressParts } from "../session/redirect.ts";

type Search = Record<string, string | undefined>;

export type AppLinkProps<Id extends RouteId> = Omit<ComponentPropsWithRef<"a">, "href"> & {
  route: Id;
  params: ParamsOf<Id>;
  search?: Search;
  /** Marks the link as current only on this exact address, not on the addresses under it. */
  exact?: boolean;
};

/** A link to a route. It carries `aria-current="page"` while its address is open. */
export function AppLink<Id extends RouteId>({
  route,
  params,
  search,
  exact = false,
  ...props
}: AppLinkProps<Id>) {
  return (
    <Link
      {...props}
      to={ROUTES[route].path}
      params={params}
      {...(search !== undefined && { search })}
      activeOptions={{ exact, includeSearch: false }}
      activeProps={{ "aria-current": "page" }}
    />
  );
}

/** Whether the component calling it is still on screen. */
function useOnScreen(): { readonly current: boolean } {
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);
  return onScreen;
}

/**
 * Navigates to a route: `go("wikiPage", { workspaceId, pageId })`. Only while the component that
 * asked is on screen: an answer that arrives after the person moved on does not move them again.
 */
export function useGo() {
  const router = useRouter();
  const onScreen = useOnScreen();
  return useCallback(
    async <Id extends RouteId>(
      route: Id,
      params: ParamsOf<Id>,
      options: { search?: Search; replace?: boolean } = {},
    ): Promise<void> => {
      if (!onScreen.current) return;
      await router.navigate({
        to: ROUTES[route].path,
        params,
        ...(options.search !== undefined && { search: options.search }),
        ...(options.replace !== undefined && { replace: options.replace }),
      });
    },
    [router, onScreen],
  );
}

/**
 * Navigates to an address inside the web (see `safeRedirect`), under the same rule as `useGo`. An
 * address that is not one is ignored.
 */
export function useGoToAddress() {
  const router = useRouter();
  const onScreen = useOnScreen();
  return useCallback(
    async (address: string, options: { replace?: boolean } = {}): Promise<void> => {
      const parts = addressParts(address);
      if (parts === undefined || !onScreen.current) return;
      await router.navigate({
        to: parts.path,
        search: parts.search,
        ...(parts.hash !== "" && { hash: parts.hash }),
        ...(options.replace !== undefined && { replace: options.replace }),
      });
    },
    [router, onScreen],
  );
}

/** The path parameters of the open route. Throws when the screen is rendered under another route. */
export function useRouteParams<Id extends RouteId>(route: Id): ParamsOf<Id> {
  const raw: Record<string, unknown> = useParams({ strict: false });
  return useMemo(() => {
    const params: Record<string, string> = {};
    for (const name of paramNames(ROUTES[route].path)) {
      const value = raw[name];
      if (typeof value !== "string") throw new Error(`route "${route}" is not open: "${name}" is missing`);
      params[name] = value;
    }
    // Every name in the route's path was just read as a string, which is what ParamsOf<Id> lists.
    return params as ParamsOf<Id>;
  }, [raw, route]);
}

/**
 * The query string, validated. The schema should accept an empty object; when the address carries
 * something it rejects, `fallback` is returned.
 */
export function useSearch<T>(schema: z.ZodType<T>, fallback: T): T {
  const text = useLocation({ select: (location) => location.searchStr });
  return useMemo(() => {
    const parsed = schema.safeParse(Object.fromEntries(new URLSearchParams(text)));
    return parsed.success ? parsed.data : fallback;
  }, [schema, text, fallback]);
}
