// Navigation by route id. Areas link and navigate with these, never with a path string, so an
// address only ever comes from the route table.
import { Link, useLocation, useParams, useRouter } from "@tanstack/react-router";
import { type ComponentPropsWithRef, useCallback, useMemo } from "react";
import type { z } from "zod";
import { type ParamsOf, paramNames, ROUTES, type RouteId } from "../routes.ts";

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

/** Navigates to a route: `go("wikiPage", { workspaceId, pageId })`. */
export function useGo() {
  const router = useRouter();
  return useCallback(
    <Id extends RouteId>(
      route: Id,
      params: ParamsOf<Id>,
      options: { search?: Search; replace?: boolean } = {},
    ) =>
      router.navigate({
        to: ROUTES[route].path,
        params,
        ...(options.search !== undefined && { search: options.search }),
        ...(options.replace !== undefined && { replace: options.replace }),
      }),
    [router],
  );
}

/** Navigates to an address inside the web that was already checked (see `safeRedirect`). */
export function useGoToAddress() {
  const router = useRouter();
  return useCallback(
    (address: string, options: { replace?: boolean } = {}) => {
      const url = new URL(address, "https://vanr.invalid");
      return router.navigate({
        to: url.pathname,
        search: Object.fromEntries(url.searchParams),
        ...(url.hash !== "" && { hash: url.hash.slice(1) }),
        ...(options.replace !== undefined && { replace: options.replace }),
      });
    },
    [router],
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
