import type { TranslationOf } from "../../i18n/format.ts";
import type en from "./en.ts";

export default {
  "area.purpose":
    "Os agentes deste espaço de trabalho: o que cada um faz, onde trabalha e no que pode mexer.",
  "team.count": {
    one: "{count} agente neste espaço de trabalho.",
    other: "{count} agentes neste espaço de trabalho.",
  },
  "team.list": "Agentes",
  "team.working": "Em atividade",
  "team.idle": "Parado",
  "team.empty.title": "Nenhum agente neste espaço de trabalho",
  "team.empty.body": "Um agente assume um papel, entra nos canais e trabalha ao lado das pessoas.",
  "team.empty.action": "Adicionar um agente",
  "team.failed": "Não foi possível carregar os agentes",
  "error.agent.archived": "Este agente está arquivado.",
} satisfies TranslationOf<typeof en>;
