// The sidebar: one column in three ruled bands. Place (the workspace and its areas), channels,
// and now (the agents at work, then you). Navigation is text; the only shapes are agents (square)
// and people (round), and an agent at work has its square lit.
import type { Me, WorkspaceSummary } from "@vanr/contract";
import {
  AgentSigil,
  Avatar,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
} from "@vanr/ui";
import { ChevronsUpDown, Ellipsis } from "lucide-react";
import { type ComponentType, Suspense, use } from "react";
import type { AgentSummary } from "../api/index.ts";
import { loadSidebarChannels } from "../app/areas.ts";
import { AppLink, useGo } from "../app/navigation.tsx";
import { isTheme, THEMES, useTheme } from "../app/theme.tsx";
import { LOCALES } from "../i18n/locales.ts";
import { useLocale, useMessages } from "../i18n/react.tsx";
import type { RouteId } from "../routes.ts";
import { useSignOut } from "../session/react.tsx";

/** The areas in the sidebar, in groups: what is waiting, work, knowledge, the team. */
export const NAVIGATION = [
  ["home", "notifications", "approvals", "threads"],
  ["assignments", "issues", "routines", "calendar"],
  ["wiki", "files", "bases", "debates"],
  ["agents", "proposals"],
] as const satisfies readonly (readonly RouteId[])[];

type NavigationId = (typeof NAVIGATION)[number][number];

export type SidebarProps = {
  me: Me;
  workspace: WorkspaceSummary;
  /** Counts shown beside an area, when there is something waiting. */
  counts: Partial<Record<NavigationId, number>>;
  /** The agents in the middle of a run; "loading" and "failed" while that is not known. */
  working: AgentSummary[] | "loading" | "failed";
  onRetryWorking: () => void;
};

function WorkspaceMenu({ me, workspace }: Pick<SidebarProps, "me" | "workspace">) {
  const t = useMessages("shell");
  const go = useGo();
  const workspaceId = workspace.id;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="side__button side__button--workspace"
          aria-label={t("workspace.menu", { workspace: workspace.name })}
        >
          <span className="side__name">{workspace.name}</span>
          <Icon icon={ChevronsUpDown} size="sm" className="side__chevron" />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>{t("workspace.switch")}</MenuLabel>
        <MenuRadioGroup value={workspaceId} onValueChange={(next) => void go("home", { workspaceId: next })}>
          {me.workspaces.map((candidate) => (
            <MenuRadioItem key={candidate.id} value={candidate.id}>
              {candidate.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onSelect={() => void go("settings", { workspaceId, section: "members" })}>
          {t("workspace.members")}
        </MenuItem>
        <MenuItem onSelect={() => void go("settings", { workspaceId, section: "general" })}>
          {t("workspace.settings")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => void go("onboarding", {})}>{t("workspace.create")}</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function PersonMenu({ me, workspace }: Pick<SidebarProps, "me" | "workspace">) {
  const t = useMessages("shell");
  const common = useMessages("common");
  const go = useGo();
  const signOut = useSignOut();
  const { locale, setLocale } = useLocale();
  const { theme, setTheme } = useTheme();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="side__button side__button--person"
          aria-label={t("person.menu", { name: me.user.name })}
        >
          <Avatar name={me.user.name} size="sm" {...(me.user.image !== null && { src: me.user.image })} />
          <span className="side__name">{me.user.name}</span>
          <Icon icon={Ellipsis} size="sm" className="side__chevron" />
        </button>
      </MenuTrigger>
      <MenuContent side="top">
        <MenuLabel>{me.user.email}</MenuLabel>
        <MenuItem onSelect={() => void go("settings", { workspaceId: workspace.id, section: "profile" })}>
          {t("person.profile")}
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>{common("language.label")}</MenuLabel>
        <MenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            const next = LOCALES.find((candidate) => candidate === value);
            if (next !== undefined) setLocale(next);
          }}
        >
          {LOCALES.map((candidate) => (
            <MenuRadioItem key={candidate} value={candidate}>
              {common(`language.${candidate}`)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>{common("theme.label")}</MenuLabel>
        <MenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isTheme(value)) setTheme(value);
          }}
        >
          {THEMES.map((candidate) => (
            <MenuRadioItem key={candidate} value={candidate}>
              {common(`theme.${candidate}`)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onSelect={() => void signOut()}>{t("person.signOut")}</MenuItem>
      </MenuContent>
    </Menu>
  );
}

// One promise for the life of the page, so `use` sees a stable value.
let sidebarChannelsPromise: Promise<ComponentType | undefined> | undefined;

/** The chat area's channel list, once chat has built one; until then, a plain statement. */
function SidebarChannels() {
  const t = useMessages("shell");
  sidebarChannelsPromise ??= loadSidebarChannels();
  const List = use(sidebarChannelsPromise);
  return List === undefined ? <p className="side__quiet">{t("channels.reserved")}</p> : <List />;
}

function WorkingNow({
  workspaceId,
  working,
  onRetry,
}: {
  workspaceId: string;
  working: SidebarProps["working"];
  onRetry: () => void;
}) {
  const t = useMessages("shell");
  const common = useMessages("common");
  const titleId = "side-working";
  return (
    <section className="side__band" aria-labelledby={titleId}>
      <h2 className="side__band-title">
        <span id={titleId}>{t("working.title")}</span>
        {Array.isArray(working) && working.length > 0 && (
          <span className="side__count">{working.length}</span>
        )}
      </h2>
      {working === "loading" && (
        <div className="side__quiet" aria-busy="true">
          <Skeleton />
        </div>
      )}
      {working === "failed" && (
        <p className="side__quiet">
          {t("working.failed")}{" "}
          <button type="button" className="app-link-button" onClick={onRetry}>
            {common("action.retry")}
          </button>
        </p>
      )}
      {Array.isArray(working) && working.length === 0 && <p className="side__quiet">{t("working.none")}</p>}
      {Array.isArray(working) && working.length > 0 && (
        <ul className="side__agents">
          {working.map((agent) => (
            <li key={agent.id}>
              <AppLink
                className="side__link side__link--agent"
                route="agent"
                params={{ workspaceId, agentId: agent.id }}
              >
                <AgentSigil
                  agentId={agent.id}
                  name={t("working.agent", { name: agent.name })}
                  size="sm"
                  working
                />
                <span aria-hidden="true">{agent.name}</span>
              </AppLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Sidebar({ me, workspace, counts, working, onRetryWorking }: SidebarProps) {
  const t = useMessages("shell");
  const workspaceId = workspace.id;
  const channelsId = "side-channels";
  return (
    <div className="side">
      <div className="side__workspace">
        <WorkspaceMenu me={me} workspace={workspace} />
      </div>
      <div className="side__scroll">
        <nav className="side__nav" aria-label={t("nav.label")}>
          {NAVIGATION.map((group) => (
            <ul key={group[0]} className="side__group">
              {group.map((id) => {
                const count = counts[id] ?? 0;
                const label = t(`route.${id}`);
                return (
                  <li key={id}>
                    <AppLink
                      className="side__link"
                      route={id}
                      params={{ workspaceId }}
                      exact={id === "home"}
                      {...(count > 0 && { "aria-label": t("nav.count", { label, count }) })}
                    >
                      <span>{label}</span>
                      {count > 0 && <span className="side__count">{count > 99 ? "99+" : count}</span>}
                    </AppLink>
                  </li>
                );
              })}
            </ul>
          ))}
        </nav>
        <section className="side__band" aria-labelledby={channelsId}>
          <h2 className="side__band-title" id={channelsId}>
            {t("channels.title")}
          </h2>
          <Suspense fallback={null}>
            <SidebarChannels />
          </Suspense>
        </section>
      </div>
      <WorkingNow workspaceId={workspaceId} working={working} onRetry={onRetryWorking} />
      <div className="side__person">
        <PersonMenu me={me} workspace={workspace} />
      </div>
    </div>
  );
}
