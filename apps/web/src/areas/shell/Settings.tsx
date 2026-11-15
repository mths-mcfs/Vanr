import { type ComponentType, Suspense, use, useEffect } from "react";
import { loadSettingsSection } from "../../app/areas.ts";
import { AppLink, useGo, useRouteParams } from "../../app/navigation.tsx";
import { useDocumentTitle } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { SETTINGS_SECTIONS, type SettingsSection } from "../../routes.ts";

const SECTIONS = Object.keys(SETTINGS_SECTIONS).filter(
  (name): name is SettingsSection => name in SETTINGS_SECTIONS,
);

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
 * The frame of the settings: the list of sections and the open one. Each section's content comes
 * from the area that owns it (SETTINGS_SECTIONS); an address with an unknown section opens General.
 */
export function SettingsScreen() {
  const t = useMessages("shell");
  const go = useGo();
  const { workspaceId, section: raw } = useRouteParams("settings");
  const section = SECTIONS.find((name) => name === raw);
  useDocumentTitle(section === undefined ? t("route.settings") : t(`settings.${section}`));
  useEffect(() => {
    if (section === undefined) void go("settings", { workspaceId, section: "general" }, { replace: true });
  }, [section, go, workspaceId]);
  if (section === undefined) return null;
  return (
    <div className="page">
      <h1 className="page__title">{t("route.settings")}</h1>
      <div className="settings">
        <nav aria-label={t("settings.sections")}>
          <ul className="settings__nav">
            {SECTIONS.map((name) => (
              <li key={name}>
                <AppLink className="side__link" route="settings" params={{ workspaceId, section: name }}>
                  {t(`settings.${name}`)}
                </AppLink>
              </li>
            ))}
          </ul>
        </nav>
        <section className="settings__body" aria-labelledby="settings-section">
          <h2 className="page__heading" id="settings-section">
            {t(`settings.${section}`)}
          </h2>
          <Suspense fallback={null}>
            <SectionBody section={section} />
          </Suspense>
        </section>
      </div>
    </div>
  );
}
