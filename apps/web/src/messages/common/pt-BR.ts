import type { TranslationOf } from "../../i18n/format.ts";
import type en from "./en.ts";

export default {
  "action.retry": "Tentar de novo",
  "action.close": "Fechar",
  "action.cancel": "Cancelar",
  "state.loading": "Carregando",
  "screen.failed": "Não foi possível carregar isto",
  "screen.broken": "Esta tela parou de funcionar",
  "screen.reserved": "Esta área ainda não faz parte desta versão.",
  "toast.region": "Avisos",
  "language.label": "Idioma",
  "language.en": "English",
  "language.pt-BR": "Português (Brasil)",
  "theme.label": "Tema",
  "theme.system": "Sistema",
  "theme.light": "Claro",
  "theme.dark": "Escuro",
} satisfies TranslationOf<typeof en>;
