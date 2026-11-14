// What the router wraps screens in. Loaded on demand by router.tsx.

import { Outlet, useRouter } from "@tanstack/react-router";
import { Button, ErrorState, Spinner } from "@vanr/ui";
import { Suspense } from "react";
import { Frame } from "../frame/Frame.tsx";
import { useMessages } from "../i18n/react.tsx";
import { AppLink } from "./navigation.tsx";
import { StandalonePage } from "./Standalone.tsx";
import { ReservedScreen, useErrorMessage } from "./screens.tsx";

export { Frame };
export const Reserved = ReservedScreen;

export function Pending() {
  return (
    <div className="page" aria-busy="true">
      <Spinner size="lg" />
    </div>
  );
}

export function Root() {
  return (
    <Suspense fallback={<Pending />}>
      <Outlet />
    </Suspense>
  );
}

/** A route that threw while loading or rendering. */
export function RouteFailed({ error, reset }: { error: unknown; reset: () => void }) {
  const t = useMessages("common");
  const describe = useErrorMessage();
  const router = useRouter();
  return (
    <div className="page">
      <ErrorState
        title={t("screen.broken")}
        description={describe(error)}
        action={
          <Button
            onClick={() => {
              reset();
              void router.invalidate();
            }}
          >
            {t("action.retry")}
          </Button>
        }
      />
    </div>
  );
}

export function NotFound() {
  const t = useMessages("shell");
  return (
    <StandalonePage title={t("notFound.title")} why={t("notFound.body")}>
      <p>
        <AppLink className="app-link" route="root" params={{}}>
          {t("notFound.action")}
        </AppLink>
      </p>
    </StandalonePage>
  );
}
