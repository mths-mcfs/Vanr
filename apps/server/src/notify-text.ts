// Text of the notice outside the app (push and email), in pt-BR and en. On screen, the front end builds its own text
// with i18n; only what leaves the server lives here.
import type { AppNotification, NotificationReason } from "@vanr/contract";
import { PRODUCT } from "@vanr/product";

type Locale = "pt-BR" | "en";

const REASON: Record<Locale, Record<NotificationReason, string>> = {
  "pt-BR": {
    approval_requested: "pediu sua aprovação",
    question_raised: "fez uma pergunta para você",
    secret_prompt: "pediu um segredo",
    browser_intervention: "precisa de você no navegador",
    turn_requested: "é a sua vez no debate",
    review_requested: "pediu sua revisão",
    join_requested: "pediu para entrar no trabalho",
    mentioned: "mencionou você",
    dm: "mandou uma mensagem",
    thread_followup: "respondeu numa thread que você segue",
    reacted: "reagiu à sua mensagem",
    assigned: "atribuiu uma tarefa a você",
    commented: "comentou numa tarefa",
    status_changed: "mudou o status de uma tarefa",
    synthesis_ready: "fechou a síntese do debate",
    assignment_finished: "terminou o trabalho e espera sua revisão",
    assignment_stopped: "parou o trabalho",
    routine_report: "terminou a rotina",
    routine_alert: "teve uma rotina que falhou",
    agent_failed: "falhou com uma ação em andamento",
    runner_connected: "conectou um runner",
    reminder: "lembrete",
  },
  en: {
    approval_requested: "asked for your approval",
    question_raised: "asked you a question",
    secret_prompt: "asked for a secret",
    browser_intervention: "needs you in the browser",
    turn_requested: "it's your turn in the debate",
    review_requested: "asked for your review",
    join_requested: "asked to join the assignment",
    mentioned: "mentioned you",
    dm: "sent you a message",
    thread_followup: "replied in a thread you follow",
    reacted: "reacted to your message",
    assigned: "assigned you a task",
    commented: "commented on a task",
    status_changed: "changed a task's status",
    synthesis_ready: "closed the debate synthesis",
    assignment_finished: "finished the assignment and awaits your review",
    assignment_stopped: "stopped the assignment",
    routine_report: "finished the routine",
    routine_alert: "had a routine fail",
    agent_failed: "failed with an action in progress",
    runner_connected: "connected a environment",
    reminder: "reminder",
  },
};

const MAX = 180;

/** A single line, with no control characters (the text comes from the agent and goes into an email header). */
export function oneLine(text: string, max = MAX): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Control characters and line separators become a space.
    out += code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? " " : ch;
  }
  const flat = out.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function reasonText(locale: Locale, reason: NotificationReason): string {
  return REASON[locale][reason] ?? reason;
}

export function snippetOf(n: Pick<AppNotification, "latest" | "source">): string {
  return oneLine(n.latest.title ?? n.latest.text ?? n.latest.quote ?? n.source.label ?? "");
}

/** Path of the direct link: the inbox opens the notice, marks it as read and leads to the source. */
export const notificationPath = (workspaceId: string, id: string) =>
  `/workspace/${encodeURIComponent(workspaceId)}/notifications?open=${encodeURIComponent(id)}`;

export function pushText(
  locale: Locale,
  who: string,
  n: Pick<AppNotification, "reason" | "latest" | "source">,
) {
  return { title: oneLine(`${who} ${reasonText(locale, n.reason)}`, 120), body: snippetOf(n) };
}

export function emailText(
  locale: Locale,
  input: {
    who: string;
    workspaceName: string;
    link: string;
    settingsLink: string;
    n: Pick<AppNotification, "reason" | "latest" | "source">;
  },
) {
  const what = snippetOf(input.n);
  const who = oneLine(input.who, 60);
  const reason = reasonText(locale, input.n.reason);
  if (locale === "en")
    return {
      subject: oneLine(`[${PRODUCT.name}] ${who} is waiting for you${what ? `: ${what}` : ""}`, 150),
      text: [
        `${who} ${reason} in ${oneLine(input.workspaceName, 80)}.`,
        what ? `\n${what}\n` : "",
        `Open: ${input.link}`,
        "",
        `You got this email because the request is still open and you haven't seen it in ${PRODUCT.name}.`,
        `Notification settings: ${input.settingsLink}`,
      ].join("\n"),
    };
  return {
    subject: oneLine(`[${PRODUCT.name}] ${who} está esperando você${what ? `: ${what}` : ""}`, 150),
    text: [
      `${who} ${reason} em ${oneLine(input.workspaceName, 80)}.`,
      what ? `\n${what}\n` : "",
      `Abrir: ${input.link}`,
      "",
      `Você recebeu este e-mail porque o pedido segue aberto e você ainda não viu no ${PRODUCT.name}.`,
      `Preferências de aviso: ${input.settingsLink}`,
    ].join("\n"),
  };
}
