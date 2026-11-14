import type { Catalog } from "../../i18n/format.ts";

/** Words every screen uses. */
export default {
  "action.retry": "Retry",
  "action.close": "Close",
  "action.cancel": "Cancel",
  "state.loading": "Loading",
  "screen.failed": "This could not be loaded",
  "screen.broken": "This screen stopped working",
  "screen.reserved": "This area is not part of this build yet.",
  "toast.region": "Notifications",
  "language.label": "Language",
  "language.en": "English",
  "language.pt-BR": "Português (Brasil)",
  "theme.label": "Theme",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",
} as const satisfies Catalog;
