// The states every screen shares: loading, failed, and "this area is not built yet". An area's
// screen uses these instead of drawing its own.

import { isApiError } from "@vanr/client";
import { Button, ErrorState, Skeleton } from "@vanr/ui";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { Namespace } from "../i18n/catalogs.ts";
import { useLookup, useMessages } from "../i18n/react.tsx";
import { ROUTES, type RouteId } from "../routes.ts";

const PRODUCT = "Vanr";

const TitleScope = createContext<string | undefined>(undefined);

/** Everything under it is titled "<screen> | <scope> | Vanr": the frame scopes its screens to the workspace. */
export function TitleScopeProvider({ scope, children }: { scope: string; children: ReactNode }) {
  return <TitleScope.Provider value={scope}>{children}</TitleScope.Provider>;
}

/** Names the browser tab after the screen. The screen is the only one that sets it. */
export function useDocumentTitle(title: string | undefined): void {
  const scope = useContext(TitleScope);
  useEffect(() => {
    const parts = [title, scope, PRODUCT].filter((part) => part !== undefined && part !== "");
    document.title = parts.join(" | ");
  }, [title, scope]);
}

/**
 * The text of an error for a person. An error from the server is looked up by the code it sent:
 * as `error.<code>` in the area's own namespace, then in the shared `errors`; then by what the
 * client made of it (`network`, `timeout`, `http_503`); then the server's own message.
 */
export function useErrorMessage(namespace?: Namespace): (error: unknown) => string {
  const own = useLookup(namespace ?? "errors");
  const shared = useLookup("errors");
  return (cause) => {
    if (!isApiError(cause)) return shared("fallback") ?? "";
    const fromArea = namespace === undefined ? undefined : own(`error.${cause.rawCode}`);
    return (
      fromArea ??
      shared(cause.rawCode) ??
      shared(cause.code) ??
      (cause.message !== "" ? cause.message : shared("fallback")) ??
      ""
    );
  };
}

/** A screen whose data is on its way. */
export function ScreenLoading() {
  const t = useMessages("common");
  return (
    <div className="page" aria-busy="true">
      <span className="vr-visually-hidden" role="status">
        {t("state.loading")}
      </span>
      <div className="page__loading">
        <Skeleton shape="block" />
        <Skeleton />
        <Skeleton />
      </div>
    </div>
  );
}

/** A screen whose data did not arrive: what failed, why, and a way to try again. */
export function ScreenError({
  title,
  error,
  onRetry,
  namespace,
}: {
  /** What could not be loaded, e.g. "The agents could not be loaded". */
  title?: string;
  error: unknown;
  onRetry?: () => void;
  /** The area's namespace, to look its own error codes up first. */
  namespace?: Namespace;
}) {
  const t = useMessages("common");
  const describe = useErrorMessage(namespace);
  return (
    <div className="page">
      <ErrorState
        title={title ?? t("screen.failed")}
        description={describe(error)}
        {...(onRetry !== undefined && { action: <Button onClick={onRetry}>{t("action.retry")}</Button> })}
      />
    </div>
  );
}

const SHELL_AREAS: readonly string[] = ["account", "shell"];

/** The screen of a route whose area has not built it yet: what the area is, and that it is not here. */
export function ReservedScreen({ id }: { id: RouteId }) {
  const shell = useLookup("shell");
  const common = useMessages("common");
  const { area } = ROUTES[id];
  const purpose = useLookup(SHELL_AREAS.includes(area) ? "common" : area)("area.purpose");
  const title = shell(`route.${id}`) ?? "";
  useDocumentTitle(title);
  return (
    <div className="page">
      <h1 className="page__title">{title}</h1>
      {purpose !== undefined && <p className="page__lead">{purpose}</p>}
      <p className="page__muted">{common("screen.reserved")}</p>
    </div>
  );
}
