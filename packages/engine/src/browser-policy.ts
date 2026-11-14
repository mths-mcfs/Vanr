// Rules for the agent's browser. The server builds each agent's policy and sends it with every action; the
// runner applies it before every load (the CDP Fetch domain, before the request leaves) and before every
// action on the page. The private network is left to the runner's proxy (net-address.ts), which checks the
// IP it actually connects to.
//
// - Origins: each allowed site is read only (read, scroll, wait, capture) or read and write (click, type,
//   select, upload). Outside the list, the agent's level decides: strict blocks, balanced allows reading,
//   free allows acting.
// - Sensitive sites (bank, email, health, identity): only with the person driving. The agent does not open,
//   read or act on them, even with the site on the list.
// - A person who took control may go to any public site; the private network stays closed.
import type { BlockedReason, BrowserLevel, SecretBrowserBinding, SiteAccess, SiteRule } from "@vanr/contract";
import { z } from "zod";
import { addressAllowed, addressKind, rangeOpenable } from "./net-address";

const SITE_ACCESS = ["read", "write"] as const satisfies readonly SiteAccess[];

export const BROWSER_LEVELS = ["strict", "balanced", "free"] as const satisfies readonly BrowserLevel[];
export const DEFAULT_BROWSER_LEVEL: BrowserLevel = "balanced";

const BROWSER_DRIVERS = ["agent", "person"] as const;
export type BrowserDriver = (typeof BROWSER_DRIVERS)[number];

/** `example.com` matches only itself; `*.example.com` matches itself and its subdomains. */
export const SITE_PATTERN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$|^localhost$/;
export const SITES_MAX = 200;
export const PRIVATE_RANGES_MAX = 50;

export const siteRule = z.object({
  pattern: z.string().trim().toLowerCase().regex(SITE_PATTERN).max(253),
  access: z.enum(SITE_ACCESS),
}) satisfies z.ZodType<SiteRule>;

/** What goes to the runner with every browser action. */
export const browserPolicy = z.object({
  driver: z.enum(BROWSER_DRIVERS),
  level: z.enum(BROWSER_LEVELS),
  sites: z.array(siteRule).max(SITES_MAX * 2),
  /** Allowed private network ranges (CIDR), already filtered for the agent's current environment. */
  privateRanges: z.array(z.string().max(64)).max(PRIVATE_RANGES_MAX),
});
export type BrowserPolicy = z.infer<typeof browserPolicy>;

/** Field a secret can be typed into: a password, or a one-line text field (user name, code). */
export const SECRET_FIELDS = ["password", "text"] as const;

/** Where the browser may type a secret. Sealed together with the value: the server cannot swap it. */
export const secretBrowserBinding = z.object({
  sites: z.array(siteRule.shape.pattern).min(1).max(10),
  field: z.enum(SECRET_FIELDS),
}) satisfies z.ZodType<SecretBrowserBinding>;

const SENSITIVE_CATEGORIES = ["bank", "email", "health", "identity"] as const;
type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

/**
 * Sensitive sites: the domain matches with its subdomains. A short fixed list of the most used services in
 * Brazil and elsewhere; a site missing here falls under the agent's regular rule (list and level).
 */
const SENSITIVE_SITES: Readonly<Record<SensitiveCategory, readonly string[]>> = {
  bank: [
    "itau.com.br",
    "bb.com.br",
    "caixa.gov.br",
    "santander.com.br",
    "bradesco.com.br",
    "banco.bradesco",
    "nubank.com.br",
    "bancointer.com.br",
    "inter.co",
    "c6bank.com.br",
    "btgpactual.com",
    "sicredi.com.br",
    "sicoob.com.br",
    "banrisul.com.br",
    "safra.com.br",
    "bancooriginal.com.br",
    "mercadopago.com.br",
    "pagbank.com.br",
    "pagseguro.uol.com.br",
    "picpay.com",
    "xpi.com.br",
    "rico.com.vc",
    "paypal.com",
    "wise.com",
    "revolut.com",
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citi.com",
    "capitalone.com",
    "hsbc.com",
    "americanexpress.com",
    "schwab.com",
    "fidelity.com",
    "coinbase.com",
    "binance.com",
    "kraken.com",
    "dashboard.stripe.com",
  ],
  email: [
    "mail.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "outlook.office365.com",
    "mail.yahoo.com",
    "mail.proton.me",
    "mail.aol.com",
    "mail.zoho.com",
    "fastmail.com",
    "email.uol.com.br",
    "webmail.terra.com.br",
    "mail.yandex.com",
    "gmx.com",
  ],
  health: [
    "conectesus.saude.gov.br",
    "meususdigital.saude.gov.br",
    "unimed.coop.br",
    "amil.com.br",
    "sulamericasaude.com.br",
    "bradescosaude.com.br",
    "hapvida.com.br",
    "gndi.com.br",
    "mychart.com",
    "kp.org",
  ],
  identity: [
    "acesso.gov.br",
    "login.gov",
    "accounts.google.com",
    "myaccount.google.com",
    "login.microsoftonline.com",
    "appleid.apple.com",
    "account.apple.com",
  ],
};

/** Host name as the browser connects to it: lowercase and without the trailing dot (`bank.com.br.`). */
function normalHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function sensitiveCategory(host: string): SensitiveCategory | null {
  const h = normalHost(host);
  for (const category of SENSITIVE_CATEGORIES)
    if (SENSITIVE_SITES[category].some((d) => under(h, d))) return category;
  return null;
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = normalHost(host);
  if (pattern.startsWith("*.")) return under(h, pattern.slice(2));
  return h === pattern;
}

/** The most specific rule wins (exact name before `*.`, longer wildcard before shorter). */
function ruleFor(host: string, sites: readonly SiteRule[]): SiteRule | null {
  let best: SiteRule | null = null;
  let bestScore = -1;
  for (const r of sites) {
    if (!hostMatches(host, r.pattern)) continue;
    const score = r.pattern.startsWith("*.") ? r.pattern.length : 10_000;
    // Tie on the same pattern as read and write: write (the person allowed both).
    if (score > bestScore || (score === bestScore && r.access === "write")) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Why a page is blocked (`BlockedReason` of the contract): `scheme` only http and https (about:blank and
 * Chrome's error page count as read only); `not_allowed` outside the list with the strict level; `sensitive`
 * bank, email, health or identity with the agent driving; `private_network` a private-network IP literal
 * outside the allowed ranges (the proxy also checks names).
 */
export type SiteVerdict =
  | { kind: "read" | "write" }
  | { kind: "blocked"; reason: BlockedReason; category?: SensitiveCategory };

/** What the agent (or the person in control) may do at this URL. */
export function siteAccess(policy: BrowserPolicy, rawUrl: string): SiteVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "blocked", reason: "scheme" };
  }
  if (url.protocol === "about:" || url.protocol === "chrome-error:") return { kind: "read" };
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "blocked", reason: "scheme" };
  const host = normalHost(url.hostname);
  const ipKind = addressKind(host);
  if (ipKind && !addressAllowed(host, policy.privateRanges).ok)
    return { kind: "blocked", reason: "private_network" };
  if (policy.driver === "person") return { kind: "write" };
  // An IP in a range the owner allowed: they opened that network for the agent to use.
  if (ipKind && ipKind !== "public") return { kind: "write" };
  const category = sensitiveCategory(host);
  if (category) return { kind: "blocked", reason: "sensitive", category };
  const rule = ruleFor(host, policy.sites);
  if (rule) return { kind: rule.access };
  if (policy.level === "strict") return { kind: "blocked", reason: "not_allowed" };
  return { kind: policy.level === "free" ? "write" : "read" };
}

/** What each browser action needs on the page it runs on. */
export const ACTION_NEEDS = {
  back: "none",
  tabs: "none",
  read: "read",
  scroll: "read",
  wait: "read",
  screenshot: "read",
  click: "write",
  fill: "write",
  select: "write",
  check: "write",
  press: "write",
  upload: "write",
  type_secret: "write",
} as const;
type BrowserAction = keyof typeof ACTION_NEEDS;

type ActionVerdict =
  | { ok: true }
  | { ok: false; reason: BlockedReason | "read_only"; category?: SensitiveCategory };

export function actionAllowed(site: SiteVerdict, action: BrowserAction): ActionVerdict {
  const need = ACTION_NEEDS[action];
  if (need === "none") return { ok: true };
  if (site.kind === "blocked") return { ok: false, reason: site.reason, category: site.category };
  if (need === "write" && site.kind === "read") return { ok: false, reason: "read_only" };
  return { ok: true };
}

// ---- consequential actions ----

/** What the runner reports about the element the action will hit (`browser.inspect`). */
export interface ElementFacts {
  tag: string;
  type: string | null;
  role: string | null;
  /** Button or link text, `aria-label`, checkbox label; for a field, only its name or placeholder. */
  label: string;
  href: string | null;
  /**
   * Form the element submits (click on the submit button, Enter in a field through the default button):
   * method and target with `formmethod` and `formaction`, and whether it is a search (`role=search`, a
   * `type=search` field, or a single field named `q`, `busca` and the like).
   */
  form: { method: string; action: string; search: boolean } | null;
  /** Clicking submits the form (submit button). */
  submits: boolean;
  /** Text field (text input, textarea, contenteditable). */
  editable: boolean;
  /** A known control (button, link, field, button role); otherwise, something the page drew. */
  control: boolean;
}

export type Consequence = "purchase" | "publish" | "delete" | "send" | "submit" | "upload";

export type AimedAction = "click" | "press" | "upload" | "check" | "select";

/** Button and link labels that need a person, already without accents and lowercase. Order decides the kind. */
const CONSEQUENT_LABELS: readonly [Consequence, RegExp][] = [
  [
    "purchase",
    /\b(buy|purchase|place (an )?order|order now|pay|checkout|check out|subscribe|donate|reserve|book( now)?|place (a )?bid|bid now|comprar?|compre|finalizar (a )?(compra|pedido)|fechar (o )?pedido|(confirm|make|complete) payment|(confirmar|efetuar|realizar|concluir) (o )?pagamento|pagar|pague|assinar|assine|contratar|contrate|doar|reservar|reserve|agendar|dar (um )?lance|ofertar|pix)\b/,
  ],
  [
    "delete",
    /\b(delete|remove|erase|destroy|discard|deactivate|unsubscribe|close (my |the )?account|cancel (my |the )?(subscription|order|plan|account)|apagar|apague|excluir|exclua|deletar|remover|remova|descartar|desativar|encerrar (a )?conta|cancelar (a |o )?(assinatura|pedido|plano|conta))\b/,
  ],
  [
    "publish",
    /\b(publish|post|tweet|retweet|repost|reblog|share|go live|reply|comment|follow|merge( pull request)?|publicar|publique|postar|republicar|compartilhar|compartilhe|responder|comentar)\b/,
  ],
  [
    "send",
    /\b(send|submit|confirm|transfer|apply|sign up|register|create (an )?account|approve|invite|accept (the )?(invitation|invite|offer|request)|finish|yes|i'?m sure|enviar|envie|confirmar|confirme|transferir|cadastrar|cadastre-se|criar (uma )?conta|inscrever|candidatar|aprovar|convidar|aceitar (o |a )?(convite|proposta|pedido|solicitacao)|finalizar|concluir|sim|tenho certeza)\b/,
  ],
];

const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const byLabel = (label: string): Consequence | null =>
  CONSEQUENT_LABELS.find(([, re]) => re.test(plain(label)))?.[0] ?? null;

/** Form submission: only a GET search passes (it is navigation, like opening the URL); `dialog` only closes the dialog. */
const byForm = (f: NonNullable<ElementFacts["form"]>): Consequence | null =>
  f.method === "dialog" || (f.method === "get" && f.search) ? null : "submit";

/**
 * If the action changes something outside the page in a way that does not come back (purchase, publish,
 * delete, submit a form, send a file), its kind; otherwise null. The server escalates these to K3 (a person
 * always approves). Sending a file always counts. A form that is not a GET search counts, with or without
 * `method` (the page's JavaScript sends it however it likes). Enter in a field submits the surrounding form;
 * outside a form and in a textarea the page decides (a chat sends the message), so it counts, and on a form
 * checkbox, option or range too. Enter or space on a button or link is a click on it; on something the page
 * drew (a closed component, a focused `div`), the runner cannot know what happens, so it counts. Check and
 * select count by the label and the option (`detail`); the key comes in `detail`.
 */
export function consequenceOf(
  el: ElementFacts | null,
  action: AimedAction,
  detail?: string,
): Consequence | null {
  if (action === "upload") return "upload";
  if (!el) return null;
  if (action === "check" || action === "select") return byLabel(`${el.label} ${detail ?? ""}`);
  if (action === "press") {
    const key = detail?.split("+").at(-1);
    if (key !== "Enter" && key !== " " && key !== "Space") return null;
    if (el.editable) {
      if (key !== "Enter") return null;
      return el.tag === "input" && el.form ? byForm(el.form) : "submit";
    }
    if (!el.control) return "submit";
    // Enter on a form checkbox, option or range also submits (the browser's implicit submission).
    if (key === "Enter" && el.tag === "input" && el.form && !el.submits) return byForm(el.form);
  }
  return byLabel(el.label) ?? (el.submits && el.form ? byForm(el.form) : null);
}

/** Text for the model: why the page or action was blocked and what to do. */
export function blockMessage(reason: BlockedReason | "read_only", target: string, category?: string): string {
  switch (reason) {
    case "scheme":
      return `${target} is not an http(s) page. Only http and https pages open in your browser.`;
    case "not_allowed":
      return `${target} is not in your allowed sites. Ask a person to add it in your browser settings.`;
    case "sensitive":
      return `${target} is a sensitive site (${category ?? "sensitive"}). Only a person can use it: call browser_ask_person and let them do this step.`;
    case "private_network":
      return `${target} is on a private network (local, loopback or cloud metadata address). Your browser cannot reach it unless a person allows that range.`;
    case "read_only":
      return `${target} is read-only for you: you can read and scroll, but not click or type. Open links with browser_navigate, or ask a person to allow acting on this site.`;
  }
}

/** Allowed network ranges: free text from the screen becomes a valid list (or the first bad item). */
export function checkRanges(list: readonly string[]): { ok: true } | { ok: false; bad: string } {
  for (const r of list) if (!rangeOpenable(r)) return { ok: false, bad: r };
  return { ok: true };
}
