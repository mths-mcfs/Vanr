import { publicKeyFor } from "@vanr/engine/runner-update";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().nonnegative().default(4400),
  PUBLIC_URL: z.string().url().optional(),
  /** Public domain Railway sets; it becomes PUBLIC_URL when that is missing. */
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default(".data"),
  BETTER_AUTH_SECRET: z.string().min(16).optional(),
  SIGNUP_OPEN: bool,
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Required in production (`file` writes to DATA_DIR/mail: a deliberate choice). Outside it, defaults to `file`. */
  MAIL_PROVIDER: z.enum(["file", "resend"]).optional(),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("no-reply@localhost"),
  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL_PROVIDER: z.enum(["fake", "anthropic"]).optional(),
  /**
   * On-demand tool loading (`defer_loading` + the API's search): `auto` defers when the
   * definitions go over the limit; `off` always sends all of them (back to the old behaviour).
   */
  TOOL_SEARCH: z.enum(["auto", "off"]).default("auto"),
  /** Pause between chunks of the fake provider, so the stream shows in dev. */
  FAKE_MODEL_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(40),
  /** Undo window of the agent's email and post; 0 sends at once. */
  UNDO_SEND_SECONDS: z.coerce.number().int().min(0).max(60).default(30),
  WEB_DIST: z.string().optional(),
  /** Extra accepted origins (comma separated). Required in production; outside it, defaults to Vite (localhost:5173). */
  TRUSTED_ORIGINS: z.string().optional(),
  EDITION: z.enum(["selfhost", "cloud"]).default("selfhost"),
  NODE_ENV: z.string().optional(),
  /** Integrations may talk to local network addresses (default: only in the selfhost edition). */
  ALLOW_PRIVATE_NETWORKS: bool,
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  /** PEM of the GitHub App key; a literal `\n` becomes a line break. */
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  /** The App's OAuth client: the install callback proves the person controls the installation with it. */
  GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_WEB_URL: z.string().url().default("https://github.com"),
  /** Search embeddings: `voyage` (with VOYAGE_API_KEY), `fake` (tests and dev) or `off`. Default: voyage with a key, else off. */
  SEARCH_EMBEDDER: z.enum(["voyage", "fake", "off"]).optional(),
  VOYAGE_API_KEY: z.string().optional(),
  /** Gotenberg (LibreOffice) for the PDF preview of docx, xlsx and pptx. Without it, the preview is the extracted text. */
  GOTENBERG_URL: z.string().url().optional(),
  COMPOSIO_API_KEY: z.string().optional(),
  COMPOSIO_API_URL: z.string().url().default("https://backend.composio.dev"),
  COMPOSIO_GMAIL_AUTH_CONFIG: z.string().optional(),
  COMPOSIO_OUTLOOK_AUTH_CONFIG: z.string().optional(),
  /** Web Push VAPID keys (base64url). Without them, the server generates a pair and keeps it in DATA_DIR. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** VAPID contact (`mailto:` or https). Default: MAIL_FROM. */
  VAPID_SUBJECT: z.string().optional(),
  /** Version of the assignments in DBOS. Fixed: changing it leaves the open assignments to the fork at boot. */
  DURABLE_VERSION: z.string().trim().min(1).max(64).default("1"),
  /** DBOS connections (the Drizzle pool is another one). */
  DURABLE_POOL: z.coerce.number().int().min(2).max(20).default(4),
  /**
   * Ed25519 seed (32 bytes in base64) that signs the runner updates. Without it, the server does not
   * offer updates. The public key it derives is pinned in the runner.
   */
  RUNNER_SIGNING_KEY: z.string().optional(),
  /**
   * Debate default: `debate` (round 0 + 1 challenge only on disagreement) or `vote` (round 0 + synthesis).
   * Owner's rule: if the harness with a real model shows that the debate does not beat a simple majority, it becomes `vote`.
   */
  DEBATE_DEFAULT_MODE: z.enum(["debate", "vote"]).default("debate"),
  /** Default cap of a debate, in % of the monthly budget of the cheapest agent at the table. */
  DEBATE_CAP_PCT: z.coerce.number().min(0.1).max(100).default(5),
});

export interface Config {
  port: number;
  publicUrl: string;
  db: { kind: "postgres"; url: string } | { kind: "pglite"; dataDir: string | null };
  dataDir: string;
  authSecret: string;
  signupOpen: boolean;
  social: {
    github: { clientId: string; clientSecret: string } | null;
    google: { clientId: string; clientSecret: string } | null;
  };
  mail:
    | { provider: "file"; dir: string; from: string }
    | { provider: "resend"; apiKey: string; from: string };
  /**
   * `fake` only outside production; `forced`: explicit MODEL_PROVIDER=fake, then not even a credential key
   * calls the API (dev and E2E). `workspace_only`: production without a platform key, only the workspace's
   * credential answers (without it, the run fails with `no_credential`).
   */
  model:
    | { provider: "fake"; delayMs: number; forced: boolean }
    | { provider: "anthropic"; apiKey: string }
    | { provider: "workspace_only" };
  /** `auto`: defers the tools that are not pinned when the definitions are heavy. */
  toolSearch: "auto" | "off";
  webDist: string;
  /** Extra origins that Better Auth and the WebSockets accept, besides the public URL. */
  trustedOrigins: string[];
  /** Web Push: fixed VAPID keys (production) or null to generate a local pair. */
  push: { vapid: { publicKey: string; privateKey: string } | null; subject: string };
  debate: { defaultMode: "debate" | "vote"; spendCapPercent: number };
  /** How long the agent's email and post wait before going out (undo cancels); 0 = at once. */
  undoSendMs: number;
  edition: "selfhost" | "cloud";
  version: string;
  /** Durable engine of the assignments (DBOS), only with Postgres. */
  durable: { version: string; poolSize: number };
  search: { embedder: { kind: "voyage"; apiKey: string } | { kind: "fake" } | { kind: "off" } };
  drive: { gotenbergUrl: string | null };
  /** Signs the runner update manifest (the seed and the public key it derives). */
  runnerSigning: { seed: string; publicKey: string } | null;
  integrations: {
    allowPrivateNetworks: boolean;
    githubApp: {
      appId: string;
      slug: string;
      privateKey: string;
      apiUrl: string;
      webUrl: string;
      /** Without it the App can't be installed from here (the callback has nothing to verify with). */
      oauthClient: { clientId: string; clientSecret: string } | null;
    } | null;
    composio: { apiKey: string; apiUrl: string; authConfigs: { gmail?: string; outlook?: string } } | null;
  };
}

export const VERSION = "0.1.0";
const DEV_SECRET = "dev-secret-only-for-local-use-change-me";
/** Vite in dev: the default extra origin outside production. */
const DEV_ORIGIN = "http://localhost:5173";

/** TRUSTED_ORIGINS: a comma-separated list; each item has to be a valid http(s) origin. */
function parseOrigins(raw: string | undefined): string[] {
  const items = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.map((item) => {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(`TRUSTED_ORIGINS has an invalid origin: ${item}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`TRUSTED_ORIGINS has an invalid origin: ${item}`);
    return url.origin;
  });
}

/** Reads the configuration from the environment. Invalid values stop the boot with zod's message. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const e = EnvSchema.parse(env);
  const port = e.PORT;
  const dataDir = e.DATA_DIR;
  const production = e.NODE_ENV === "production";
  if (production && !e.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is required in production");
  const pair = (id?: string, secret?: string) =>
    id && secret ? { clientId: id, clientSecret: secret } : null;
  let mail: Config["mail"];
  if (production && !e.MAIL_PROVIDER)
    throw new Error("MAIL_PROVIDER is required in production (resend, or file to write the emails to disk)");
  if (e.MAIL_PROVIDER === "resend") {
    if (!e.RESEND_API_KEY) throw new Error("MAIL_PROVIDER=resend requires RESEND_API_KEY");
    mail = { provider: "resend", apiKey: e.RESEND_API_KEY, from: e.MAIL_FROM };
  } else {
    mail = { provider: "file", dir: `${dataDir === "memory" ? ".data" : dataDir}/mail`, from: e.MAIL_FROM };
  }
  if (production && e.MODEL_PROVIDER === "fake")
    throw new Error(
      "MODEL_PROVIDER=fake is not accepted in production (the fake provider answers in place of the model)",
    );
  const wantsAnthropic = e.MODEL_PROVIDER === "anthropic" || (!e.MODEL_PROVIDER && e.ANTHROPIC_API_KEY);
  let model: Config["model"] = production
    ? { provider: "workspace_only" }
    : { provider: "fake", delayMs: e.FAKE_MODEL_DELAY_MS, forced: e.MODEL_PROVIDER === "fake" };
  if (wantsAnthropic) {
    if (!e.ANTHROPIC_API_KEY) throw new Error("MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    model = { provider: "anthropic", apiKey: e.ANTHROPIC_API_KEY };
  }
  if (production && e.SEARCH_EMBEDDER === "fake")
    throw new Error("SEARCH_EMBEDDER=fake is not accepted in production (use voyage or off)");
  const embedderKind = e.SEARCH_EMBEDDER ?? (e.VOYAGE_API_KEY ? "voyage" : "off");
  let embedder: Config["search"]["embedder"];
  if (embedderKind === "voyage") {
    if (!e.VOYAGE_API_KEY) throw new Error("SEARCH_EMBEDDER=voyage requires VOYAGE_API_KEY");
    embedder = { kind: "voyage", apiKey: e.VOYAGE_API_KEY };
  } else embedder = { kind: embedderKind };
  const trustedOrigins = parseOrigins(e.TRUSTED_ORIGINS);
  if (production && !trustedOrigins.length)
    throw new Error("TRUSTED_ORIGINS is required in production (comma-separated origins)");
  return {
    port,
    publicUrl:
      e.PUBLIC_URL ??
      (e.RAILWAY_PUBLIC_DOMAIN ? `https://${e.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`),
    db: e.DATABASE_URL
      ? { kind: "postgres", url: e.DATABASE_URL }
      : { kind: "pglite", dataDir: dataDir === "memory" ? null : `${dataDir}/db` },
    dataDir,
    authSecret: e.BETTER_AUTH_SECRET ?? DEV_SECRET,
    signupOpen: e.SIGNUP_OPEN ?? true,
    social: {
      github: pair(e.GITHUB_CLIENT_ID, e.GITHUB_CLIENT_SECRET),
      google: pair(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET),
    },
    mail,
    model,
    toolSearch: e.TOOL_SEARCH,
    webDist: e.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname,
    trustedOrigins: trustedOrigins.length ? trustedOrigins : [DEV_ORIGIN],
    push: {
      vapid:
        e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY
          ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY }
          : null,
      subject: e.VAPID_SUBJECT ?? `mailto:${e.MAIL_FROM}`,
    },
    debate: { defaultMode: e.DEBATE_DEFAULT_MODE, spendCapPercent: e.DEBATE_CAP_PCT },
    undoSendMs: e.UNDO_SEND_SECONDS * 1000,
    edition: e.EDITION,
    version: VERSION,
    durable: { version: e.DURABLE_VERSION, poolSize: e.DURABLE_POOL },
    search: { embedder },
    drive: { gotenbergUrl: e.GOTENBERG_URL?.replace(/\/$/, "") ?? null },
    runnerSigning: e.RUNNER_SIGNING_KEY
      ? { seed: e.RUNNER_SIGNING_KEY.trim(), publicKey: publicKeyFor(e.RUNNER_SIGNING_KEY) }
      : null,
    integrations: {
      allowPrivateNetworks: e.ALLOW_PRIVATE_NETWORKS ?? e.EDITION === "selfhost",
      githubApp:
        e.GITHUB_APP_ID && e.GITHUB_APP_SLUG && e.GITHUB_APP_PRIVATE_KEY
          ? {
              appId: e.GITHUB_APP_ID,
              slug: e.GITHUB_APP_SLUG,
              privateKey: e.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
              apiUrl: e.GITHUB_API_URL.replace(/\/$/, ""),
              webUrl: e.GITHUB_WEB_URL.replace(/\/$/, ""),
              oauthClient: pair(e.GITHUB_APP_CLIENT_ID, e.GITHUB_APP_CLIENT_SECRET),
            }
          : null,
      composio: e.COMPOSIO_API_KEY
        ? {
            apiKey: e.COMPOSIO_API_KEY,
            apiUrl: e.COMPOSIO_API_URL.replace(/\/$/, ""),
            authConfigs: {
              ...(e.COMPOSIO_GMAIL_AUTH_CONFIG ? { gmail: e.COMPOSIO_GMAIL_AUTH_CONFIG } : {}),
              ...(e.COMPOSIO_OUTLOOK_AUTH_CONFIG ? { outlook: e.COMPOSIO_OUTLOOK_AUTH_CONFIG } : {}),
            },
          }
        : null,
    },
  };
}
