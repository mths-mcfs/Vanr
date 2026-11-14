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
  config: Pick<Config, "publicUrl" | "authSecret" | "social">;
  mailer: Mailer;
  trustedOrigins: string[];
  /**
   * Decides whether this email may create an account (open sign-up, first install or a pending invite).
   * `busy`: the installation is empty but another sign-up holds the first user's place; try again soon.
   */
  signupAllowed: (email: string, headers: Headers | null) => Promise<SignupDecision>;
}

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
    logger: { level: "error" },
    databaseHooks: {
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
