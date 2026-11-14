// Text that leaves the server, in en and pt-BR: notices outside the app (push and email) and the auth emails.
// On screen the front end builds its own text with i18n. Everything is one table per language: the reason of
// each notice kind, the parts of the push and of the email, and the auth subjects; the functions only fill it.
import type { AppNotification, NotificationReason } from "@vanr/contract";
import { PRODUCT } from "@vanr/product";

export type Locale = "en" | "pt-BR";

type NoticeParts = Pick<AppNotification, "reason" | "latest" | "source">;

interface EmailInput {
  who: string;
  workspaceName: string;
  link: string;
  settingsLink: string;
  n: NoticeParts;
}

interface Copy {
  reasons: Record<NotificationReason, string>;
  /** "<who> is waiting for you" and the lines of the email body. */
  waiting: (who: string) => string;
  happened: (who: string, reason: string, workspace: string) => string;
  openLine: (link: string) => string;
  why: string;
  preferencesLine: (link: string) => string;
  /** Subjects of the auth emails, after the product name. */
  auth: { reset: string; verify: string };
}

const COPY: Record<Locale, Copy> = {
  en: {
    reasons: {
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
      runner_connected: "connected a runner",
      reminder: "reminder",
    },
    waiting: (who) => `${who} is waiting for you`,
    happened: (who, reason, workspace) => `${who} ${reason} in ${workspace}.`,
    openLine: (link) => `Open: ${link}`,
    why: `You got this email because the request is still open and you haven't seen it in ${PRODUCT.name}.`,
    preferencesLine: (link) => `Notification settings: ${link}`,
    auth: { reset: "reset your password", verify: "confirm your email" },
  },
  "pt-BR": {
    reasons: {
      approval_requested: "pediu sua aprovação",
      question_raised: "fez uma pergunta para você",
      secret_prompt: "pediu um segredo",
      browser_intervention: "precisa de você no navegador",
      turn_requested: "é a sua vez no debate",
      review_requested: "pediu sua revisão",
      join_requested: "pediu para entrar na tarefa atribuída",
      mentioned: "mencionou você",
      dm: "mandou uma mensagem",
      thread_followup: "respondeu numa thread que você segue",
      reacted: "reagiu à sua mensagem",
      assigned: "atribuiu uma tarefa a você",
      commented: "comentou numa tarefa",
      status_changed: "mudou o status de uma tarefa",
      synthesis_ready: "fechou a síntese do debate",
      assignment_finished: "terminou a tarefa atribuída e espera sua revisão",
      assignment_stopped: "parou a tarefa atribuída",
      routine_report: "terminou a rotina",
      routine_alert: "teve uma rotina que falhou",
      agent_failed: "falhou com uma ação em andamento",
      runner_connected: "conectou um runner",
      reminder: "lembrete",
    },
    waiting: (who) => `${who} está esperando você`,
    happened: (who, reason, workspace) => `${who} ${reason} em ${workspace}.`,
    openLine: (link) => `Abrir: ${link}`,
    why: `Você recebeu este e-mail porque o pedido segue aberto e você ainda não viu no ${PRODUCT.name}.`,
    preferencesLine: (link) => `Preferências de aviso: ${link}`,
    auth: { reset: "redefinir senha", verify: "confirme seu e-mail" },
  },
};

/** Line limits of each part: the whole line, the push title, the email subject, the names inside them. */
const LIMIT = { line: 180, pushTitle: 120, subject: 150, who: 60, workspace: 80 } as const;

/** Control characters (C0, DEL) and the Unicode line and paragraph separators. */
const isControl = (code: number) => code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;

/** A single line, with no control characters (the text comes from the agent and goes into an email header). */
export function oneLine(text: string, max: number = LIMIT.line): string {
  const spaced = Array.from(text, (ch) => (isControl(ch.codePointAt(0) ?? 0) ? " " : ch)).join("");
  const flat = spaced.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function reasonText(locale: Locale, reason: NotificationReason): string {
  return COPY[locale].reasons[reason] ?? reason;
}

/** Where the excerpt of a notice comes from, in order: the first one present wins, an empty string included. */
const EXCERPT_SOURCES: readonly ((n: Pick<AppNotification, "latest" | "source">) => string | undefined)[] = [
  (n) => n.latest.title,
  (n) => n.latest.text,
  (n) => n.latest.quote,
  (n) => n.source.label,
];

export function snippetOf(n: Pick<AppNotification, "latest" | "source">): string {
  for (const pick of EXCERPT_SOURCES) {
    const value = pick(n);
    if (value !== undefined && value !== null) return oneLine(value);
  }
  return oneLine("");
}

/** Path of the direct link: the inbox opens the notice, marks it as read and leads to the source. */
export const notificationPath = (workspaceId: string, id: string) =>
  `/workspace/${encodeURIComponent(workspaceId)}/notifications?open=${encodeURIComponent(id)}`;

export function pushText(locale: Locale, who: string, n: NoticeParts) {
  return { title: oneLine(`${who} ${reasonText(locale, n.reason)}`, LIMIT.pushTitle), body: snippetOf(n) };
}

export function emailText(locale: Locale, input: EmailInput) {
  const copy = COPY[locale];
  const excerpt = snippetOf(input.n);
  const who = oneLine(input.who, LIMIT.who);
  const subject = `[${PRODUCT.name}] ${copy.waiting(who)}${excerpt ? `: ${excerpt}` : ""}`;
  const body = [
    copy.happened(who, reasonText(locale, input.n.reason), oneLine(input.workspaceName, LIMIT.workspace)),
    excerpt ? `\n${excerpt}\n` : "",
    copy.openLine(input.link),
    "",
    copy.why,
    copy.preferencesLine(input.settingsLink),
  ];
  return { subject: oneLine(subject, LIMIT.subject), text: body.join("\n") };
}

/**
 * The language of an email sent outside a workspace (auth): the first of en or pt in the request's
 * Accept-Language, else pt-BR, the language these emails always had.
 */
export function localeFromHeader(acceptLanguage: string | null | undefined): Locale {
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase() ?? "";
    if (tag === "pt" || tag.startsWith("pt-")) return "pt-BR";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "pt-BR";
}

export function authSubject(locale: Locale, kind: keyof Copy["auth"]): string {
  return `${PRODUCT.name}: ${COPY[locale].auth[kind]}`;
}
