import { can } from "@vanr/contract";
import { EmptyState } from "@vanr/ui";
import { type ComponentType, Suspense, use, useEffect, useRef } from "react";
import { loadSettingsSection } from "../../app/areas.ts";
import { AppLink, useGo, useRouteParams } from "../../app/navigation.tsx";
import { useDocumentTitle } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { SETTINGS_SECTIONS, type SettingsSection } from "../../routes.ts";
import { useSession } from "../../session/react.tsx";

const SECTIONS = Object.keys(SETTINGS_SECTIONS).filter(
  (name): name is SettingsSection => name in SETTINGS_SECTIONS,
);

/**
 * Who may open each section. A section the role may not open is left out of the list, and its
 * address shows why instead of its content. The server enforces the same rules on every call.
 */
const SECTION_PERMISSION: { readonly [S in SettingsSection]: Parameters<typeof can>[1] } = {
  general: "read",
  profile: "read",
  members: "read",
  storage: "configure",
  runners: "read",
  connectors: "configure",
  "data-sources": "configure",
  access: "manage_agents",
  usage: "view_usage",
};

const loaded = new Map<SettingsSection, Promise<ComponentType | undefined>>();

/** The content the owning area built for a section, or the plain "not in this build" line. */
function SectionBody({ section }: { section: SettingsSection }) {
  const common = useMessages("common");
  let pending = loaded.get(section);
  if (pending === undefined) {
    pending = loadSettingsSection(section);
    loaded.set(section, pending);
  }
  const Body = use(pending);
  return Body === undefined ? <p className="page__muted">{common("screen.reserved")}</p> : <Body />;
}

/**
 * The frame of the settings: the sections the person may open and the open one. Each section's
 * content comes from the area that owns it (SETTINGS_SECTIONS); an address with an unknown section
 * opens General.
 */
export function SettingsScreen() {
  const t = useMessages("shell");
  const go = useGo();
  const { me } = useSession();
  const { workspaceId, section: raw } = useRouteParams("settings");
  const section = SECTIONS.find((name) => name === raw);
  const role = me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? "member";
  const open = SECTIONS.filter((name) => can(role, SECTION_PERMISSION[name]));
  const nav = useRef<HTMLElement>(null);
  useDocumentTitle(section === undefined ? t("route.settings") : t(`settings.${section}`));
  useEffect(() => {
    if (section === undefined) void go("settings", { workspaceId, section: "general" }, { replace: true });
  }, [section, go, workspaceId]);
  // On a phone the list scrolls sideways: the open section, even one reached by a link, stays in view.
  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [section]);
  if (section === undefined) return null;
  const allowed = open.includes(section);
  return (
    <div className="page page--wide">
      <h1 className="page__title">{t("route.settings")}</h1>
      <div className="settings">
        <nav aria-label={t("settings.sections")} ref={nav}>
          <ul className="settings__nav">
            {open.map((name) => (
              <li key={name}>
                <AppLink className="side__link" route="settings" params={{ workspaceId, section: name }}>
                  {t(`settings.${name}`)}
                </AppLink>
              </li>
            ))}
          </ul>
        </nav>
        <section className="settings__body" aria-labelledby="settings-section">
          <h2 className="page__heading settings__heading" id="settings-section">
            {t(`settings.${section}`)}
          </h2>
          {allowed ? (
            <Suspense fallback={null}>
              <SectionBody section={section} />
            </Suspense>
          ) : (
            <EmptyState
              className="page__narrow"
              title={t("settings.locked.title")}
              description={t("settings.locked.body")}
            />
          )}
        </section>
      </div>
    </div>
  );
}
