import type { Db } from "@vanr/engine/db";
import { schema } from "@vanr/engine/db";
import { PRODUCT } from "@vanr/product";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import type { Config } from "./config";
import type { Mailer } from "./mailer";
import { authSubject, localeFromHeader } from "./notify-text";

export type SignupDecision = "allow" | "closed" | "busy";

export interface AuthDeps {
  db: Db;
  config: Pick<Config, "publicUrl" | "authSecret" | "social" | "authRateLimit">;
  mailer: Mailer;
  trustedOrigins: string[];
  /**
   * Decides whether this email may create an account (open sign-up, first install or a pending invite).
   * `busy`: the installation is empty but another sign-up holds the first user's place; try again soon.
   */
  signupAllowed: (email: string, headers: Headers | null) => Promise<SignupDecision>;
  /** A sign-in session was deleted (sign-out, revoked): every live connection it opened closes now. */
  onSessionEnded?: (sessionId: string) => void | Promise<void>;
}

/**
 * Requests per IP (the first `x-forwarded-for` address) in each window, in seconds, on the routes that guess
 * passwords, create accounts or send email. The rest of /api/auth gets the global limit. The counters live in
 * the process: the server is a single instance per database.
 */
export const AUTH_RATE_LIMITS = {
  global: { window: 60, max: 100 },
  rules: {
    "/sign-in/*": { window: 60, max: 5 },
    "/sign-up/*": { window: 60, max: 5 },
    "/request-password-reset": { window: 300, max: 3 },
    "/reset-password": { window: 300, max: 5 },
    "/send-verification-email": { window: 300, max: 3 },
    "/verify-email": { window: 60, max: 10 },
  },
} as const;

/**
 * Better Auth with the Drizzle adapter. Email and password always; GitHub and Google only with their
 * environment variables. The sign-up block lives in the user creation hook, so it also applies to
 * social login (the first social login creates the user).
 */
export function createAuth(deps: AuthDeps) {
  const { github, google } = deps.config.social;
  return betterAuth({
    appName: PRODUCT.name,
    baseURL: deps.config.publicUrl,
    basePath: "/api/auth",
    secret: deps.config.authSecret,
    trustedOrigins: deps.trustedOrigins,
    database: drizzleAdapter(deps.db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url }, request) => {
        await deps.mailer.send({
          to: user.email,
          kind: "reset",
          subject: authSubject(localeFromHeader(request?.headers.get("accept-language")), "reset"),
          text: url,
          link: url,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }, request) => {
        await deps.mailer.send({
          to: user.email,
          kind: "verify",
          subject: authSubject(localeFromHeader(request?.headers.get("accept-language")), "verify"),
          text: url,
          link: url,
        });
      },
    },
    socialProviders: {
      ...(github ? { github: { clientId: github.clientId, clientSecret: github.clientSecret } } : {}),
      ...(google ? { google: { clientId: google.clientId, clientSecret: google.clientSecret } } : {}),
    },
    advanced: { cookiePrefix: PRODUCT.slug },
    rateLimit: {
      enabled: deps.config.authRateLimit,
      storage: "memory",
      ...AUTH_RATE_LIMITS.global,
      customRules: AUTH_RATE_LIMITS.rules,
    },
    logger: { level: "error" },
    databaseHooks: {
      session: {
        delete: {
          after: async (session) => {
            await deps.onSessionEnded?.(session.id);
          },
        },
      },
      user: {
        create: {
          before: async (user, ctx) => {
            const headers = ctx?.headers ?? ctx?.request?.headers ?? null;
            const decision = await deps.signupAllowed(user.email, headers);
            if (decision === "busy") {
              throw new APIError(
                "SERVICE_UNAVAILABLE",
                {
                  message: "Another sign-up is creating the first account; try again shortly.",
                  code: "SIGNUP_BUSY",
                },
                { "retry-after": "5" },
              );
            }
            if (decision === "closed") {
              throw new APIError("FORBIDDEN", {
                message: "Sign-up is closed. Ask a workspace admin for an invite.",
                code: "SIGNUP_CLOSED",
              });
            }
            return { data: user };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
