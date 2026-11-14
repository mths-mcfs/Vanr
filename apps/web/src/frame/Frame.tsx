// The frame of a workspace: sidebar, header, the connection banner and the open area's screen.
// It owns the one real-time connection and the data the sidebar shows; areas render inside it.

import { Outlet, useParams } from "@tanstack/react-router";
import { useApiQuery } from "@vanr/client/react";
import type { Me, WorkspaceSummary } from "@vanr/contract";
import { AgentSigil, Banner, Button, Drawer, DrawerContent, Icon, Kbd } from "@vanr/ui";
import { Menu, PanelLeft, Search } from "lucide-react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useRuntime } from "../app/context.tsx";
import { AppLink, useGo } from "../app/navigation.tsx";
import { StandalonePage } from "../app/Standalone.tsx";
import { ScreenLoading, TitleScopeProvider } from "../app/screens.tsx";
import { useLookup, useMessages } from "../i18n/react.tsx";
import { readStored, STORAGE_KEYS, writeStored } from "../platform/storage.ts";
import {
  useInvalidateOn,
  useRealtimeStatus,
  useReconnectNow,
  WorkspaceRealtime,
} from "../realtime/react.tsx";
import { useSession } from "../session/react.tsx";
import { rememberWorkspace } from "../session/session.ts";
import { agentsAtWork } from "./at-work.ts";
import {
  DOCKED_SIDEBAR_QUERY,
  useCommandKey,
  useCurrentRouteId,
  useMediaQuery,
  useOnNavigate,
} from "./hooks.ts";
import { Sidebar } from "./Sidebar.tsx";

/** How long the frame's own answers are reused before asking again. */
const AGENTS_FRESH_MS = 30_000;
const OVERVIEW_FRESH_MS = 15_000;
/** How many lit sigils fit in the header before the count takes over. */
const HEADER_SIGILS = 3;

const SidebarChoice = z.enum(["shown", "hidden"]);

export function Frame() {
  const params: Record<string, unknown> = useParams({ strict: false });
  const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : "";
  const { me } = useSession();
  // The guard already sent a visitor to sign in; while the session is being dropped there is nothing to draw.
  if (me === undefined || me === null) return null;
  const workspace = me.workspaces.find((candidate) => candidate.id === workspaceId);
  if (workspace === undefined) return <NoAccess />;
  return (
    <WorkspaceRealtime workspaceId={workspace.id}>
      <FrameBody me={me} workspace={workspace} />
    </WorkspaceRealtime>
  );
}

function NoAccess() {
  const t = useMessages("shell");
  return (
    <StandalonePage title={t("noAccess.title")} why={t("noAccess.body")}>
      <p>
        <AppLink className="app-link" route="root" params={{}}>
          {t("noAccess.action")}
        </AppLink>
      </p>
    </StandalonePage>
  );
}

function ConnectionBanner() {
  const t = useMessages("shell");
  const status = useRealtimeStatus();
  const retry = useReconnectNow();
  if (status !== "reconnecting") return null;
  return (
    <Banner
      tone="warning"
      action={
        <Button size="sm" onClick={retry}>
          {t("connection.retry")}
        </Button>
      }
    >
      {t("connection.lost")}
    </Banner>
  );
}

function FrameBody({ me, workspace }: { me: Me; workspace: WorkspaceSummary }) {
  const t = useMessages("shell");
  const titles = useLookup("shell");
  const { store } = useRuntime();
  const go = useGo();
  const workspaceId = workspace.id;
  const scope = { workspaceId };

  const docked = useMediaQuery(DOCKED_SIDEBAR_QUERY);
  const [hidden, setHidden] = useState(
    () => readStored(store, STORAGE_KEYS.sidebar, SidebarChoice) === "hidden",
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const content = useRef<HTMLElement>(null);
  // What opened the drawer, and whether a navigation is what closed it: where focus goes after.
  const drawerOpener = useRef<HTMLElement | null>(null);
  const drawerLeft = useRef(false);
  const focusContent = useCallback(() => content.current?.focus(), []);

  const agents = useApiQuery("listAgents", scope, { staleTime: AGENTS_FRESH_MS });
  const runs = useApiQuery("listActiveRuns", scope, { staleTime: OVERVIEW_FRESH_MS });
  const overview = useApiQuery("getOverview", scope, { staleTime: OVERVIEW_FRESH_MS });
  const notices = useApiQuery("listNotificationCounts", scope, { staleTime: OVERVIEW_FRESH_MS });
  // Run events refetch the active runs and the notice count through the client's invalidation
  // table. The count of approvals waiting comes with the overview, which the table does not tie to
  // the approval events.
  useInvalidateOn("approval.requested", { method: "getOverview", args: scope });
  useInvalidateOn("approval.resolved", { method: "getOverview", args: scope });

  useEffect(() => rememberWorkspace(store, workspaceId), [store, workspaceId]);
  useOnNavigate(() => {
    // Opening the drawer clears this, so it only ever speaks for the drawer that is open now.
    drawerLeft.current = true;
    setDrawerOpen(false);
  });
  useCommandKey(useCallback(() => void go("search", { workspaceId }), [go, workspaceId]));

  const routeId = useCurrentRouteId();
  const title = routeId === undefined ? undefined : titles(`route.${routeId}`);

  const working =
    agents.isPending || runs.isPending
      ? "loading"
      : agents.isError || runs.isError
        ? "failed"
        : agentsAtWork(agents.data, runs.data);
  const sidebar = (
    <Sidebar
      me={me}
      workspace={workspace}
      counts={{ notifications: notices.data?.badge ?? 0, approvals: overview.data?.myApprovalQueue ?? 0 }}
      working={working}
      onRetryWorking={() => {
        void agents.refetch();
        void runs.refetch();
      }}
      focusContent={focusContent}
    />
  );
  const sidebarOutOfSight = !docked || hidden;
  const toggleSidebar = (opener: HTMLElement) => {
    if (!docked) {
      drawerOpener.current = opener;
      drawerLeft.current = false;
      setDrawerOpen(true);
      return;
    }
    writeStored(store, STORAGE_KEYS.sidebar, hidden ? "shown" : "hidden");
    setHidden(!hidden);
  };

  return (
    <div className="frame" data-sidebar={docked ? (hidden ? "hidden" : "docked") : "drawer"}>
      <button type="button" className="app-skip" onClick={() => content.current?.focus()}>
        {t("skip")}
      </button>
      {docked && !hidden && (
        <aside className="frame__sidebar" aria-label={t("sidebar.label")}>
          {sidebar}
        </aside>
      )}
      {!docked && (
        <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DrawerContent
            title={t("sidebar.label")}
            onCloseAutoFocus={(event) => {
              // Dismissed (Escape, a press outside): back to what opened it. Closed by going
              // somewhere: to the content of where the person went. Never left on the page itself.
              event.preventDefault();
              (drawerLeft.current ? content.current : drawerOpener.current)?.focus();
              drawerLeft.current = false;
            }}
          >
            {sidebar}
          </DrawerContent>
        </Drawer>
      )}
      <div className="frame__main">
        <header className="frame__header">
          <Button
            variant="ghost"
            icon={<Icon icon={docked ? PanelLeft : Menu} />}
            aria-label={docked ? t(hidden ? "sidebar.show" : "sidebar.hide") : t("sidebar.open")}
            aria-expanded={docked ? !hidden : drawerOpen}
            onClick={(event) => toggleSidebar(event.currentTarget)}
          />
          <p className="frame__title">{title ?? workspace.name}</p>
          {sidebarOutOfSight && Array.isArray(working) && working.length > 0 && (
            <button
              type="button"
              className="frame__working"
              aria-label={t("working.open", { count: working.length })}
              onClick={(event) => toggleSidebar(event.currentTarget)}
            >
              {working.slice(0, HEADER_SIGILS).map((agent) => (
                <AgentSigil
                  key={agent.id}
                  agentId={agent.id}
                  name={agent.name}
                  size="sm"
                  working
                  aria-hidden="true"
                />
              ))}
              <span className="frame__working-count" aria-hidden="true">
                {working.length}
              </span>
            </button>
          )}
          <AppLink
            className="frame__search"
            route="search"
            params={{ workspaceId }}
            aria-label={t("search.open")}
          >
            <Icon icon={Search} size="sm" />
            <span>{t("search.open")}</span>
            <span aria-hidden="true">
              <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
            </span>
          </AppLink>
        </header>
        <ConnectionBanner />
        <main className="frame__content" id="content" tabIndex={-1} ref={content}>
          <TitleScopeProvider scope={workspace.name}>
            <Suspense fallback={<ScreenLoading />}>
              <Outlet />
            </Suspense>
          </TitleScopeProvider>
        </main>
      </div>
    </div>
  );
}
