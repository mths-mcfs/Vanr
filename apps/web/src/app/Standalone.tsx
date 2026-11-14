// The one layout of every screen outside the frame: an open column on the canvas, with the
// language and theme controls in the corner.
import { Select, SelectItem, Wordmark } from "@vanr/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { LOCALES } from "../i18n/locales.ts";
import { useLocale, useMessages } from "../i18n/react.tsx";
import { useDocumentTitle } from "./screens.tsx";
import { isTheme, THEMES, useTheme } from "./theme.tsx";

function Controls() {
  const t = useMessages("common");
  const { locale, setLocale } = useLocale();
  const { theme, setTheme } = useTheme();
  return (
    <div className="acct__controls">
      <Select
        size="sm"
        aria-label={t("language.label")}
        value={locale}
        onValueChange={(value) => {
          const next = LOCALES.find((candidate) => candidate === value);
          if (next !== undefined) setLocale(next);
        }}
      >
        {LOCALES.map((candidate) => (
          <SelectItem key={candidate} value={candidate}>
            {t(`language.${candidate}`)}
          </SelectItem>
        ))}
      </Select>
      <Select
        size="sm"
        aria-label={t("theme.label")}
        value={theme}
        onValueChange={(value) => {
          if (isTheme(value)) setTheme(value);
        }}
      >
        {THEMES.map((candidate) => (
          <SelectItem key={candidate} value={candidate}>
            {t(`theme.${candidate}`)}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}

/**
 * A page outside the frame: wordmark, a title that says what happens, the reason, then whatever
 * the screen needs. Account screens use it, and so does every dead end (no access, no such page). The title takes focus when the screen changes, so a keyboard or a
 * screen reader starts at the top of the new one.
 */
export function StandalonePage({
  title,
  why,
  children,
  foot,
}: {
  title: string;
  why?: ReactNode;
  children?: ReactNode;
  /** A line under a rule at the end: the way to the neighbouring screen. */
  foot?: ReactNode;
}) {
  useDocumentTitle(title);
  const heading = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the title changing is the screen changing.
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <div className="acct">
      <Controls />
      <main className="acct__column">
        <Wordmark size="md" />
        <div className="acct__head">
          <h1 className="acct__title" tabIndex={-1} ref={heading}>
            {title}
          </h1>
          {why !== undefined && <p className="acct__why">{why}</p>}
        </div>
        {children}
        {foot !== undefined && <p className="acct__foot">{foot}</p>}
      </main>
    </div>
  );
}
