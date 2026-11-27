// What every journey builds on. Import `test` and `expect` from here, not from @playwright/test:
//
//   test("…", async ({ page, t, seedUser, signIn }) => {
//     const user = await seedUser({ workspace: "Birchwood" });
//     await signIn(user);
//     await page.goto("/");
//     await expect(page.getByRole("button", { name: t("shell", "workspace.menu", { workspace: user.workspace.name }) })).toBeVisible();
//   });
//
// - `server` (one per worker): the real server on a fresh in-memory PGlite. `baseURL` points at it.
// - `seedUser()`: a new account made through the API, optionally with a workspace. Each call is a
//   new person, so a journey that signs out or changes the account never touches another one.
// - `signIn(user)`: puts the person's session in the page's browser context. The session is made once
//   per person and worker, kept as a storage state file, and reused by every later `signIn`.
// - `t(namespace, key, params)`: the interface text in the project's language, from the web's own
//   catalogs. Find elements by role and accessible name built with it; add a `data-testid` only where
//   no role fits.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type APIRequestContext, test as base, expect, request } from "@playwright/test";
import { type Catalog, formatMessage, type ParamNames } from "../src/i18n/format.ts";
import type { Locale } from "../src/i18n/locales.ts";
import accountEn from "../src/messages/account/en.ts";
import accountPt from "../src/messages/account/pt-BR.ts";
import commonEn from "../src/messages/common/en.ts";
import commonPt from "../src/messages/common/pt-BR.ts";
import shellEn from "../src/messages/shell/en.ts";
import shellPt from "../src/messages/shell/pt-BR.ts";
import { type RunningServer, startServer } from "./server.ts";

export { expect };

const CATALOGS = {
  en: { account: accountEn, common: commonEn, shell: shellEn },
  "pt-BR": { account: accountPt, common: commonPt, shell: shellPt },
} as const;
type Catalogs = (typeof CATALOGS)["en"];
export type Namespace = keyof Catalogs;

/** The interface text of a key in the project's language, with its parameters filled in. */
export type Text = <N extends Namespace, K extends keyof Catalogs[N] & string>(
  namespace: N,
  key: K,
  ...params: [ParamNames<Catalogs[N][K]>] extends [never]
    ? []
    : [params: Record<ParamNames<Catalogs[N][K]>, string | number>]
) => string;

/** The web's language for a browser locale such as `pt-BR` or `en-US` (as `matchLocale` picks it). */
function webLocale(browserLocale: string | undefined): Locale {
  return browserLocale?.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
}

export interface SeededUser {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}
export type SeededMember = SeededUser & {
  readonly workspace: { readonly id: string; readonly name: string };
};

export interface SeedOptions {
  /** Also creates a workspace with this name, owned by the new person. */
  workspace?: string;
}

/** Signed-in storage states of one worker, by email. */
type States = Map<string, string>;

interface Fixtures {
  t: Text;
  seedUser: {
    (options: SeedOptions & { workspace: string }): Promise<SeededMember>;
    (options?: SeedOptions): Promise<SeededUser>;
  };
  signIn: (user: SeededUser) => Promise<void>;
}

interface WorkerFixtures {
  server: RunningServer;
  states: States;
}

let sequence = 0;
/** Unique within the run: the worker, the moment and a counter. */
function uniqueId(workerIndex: number): string {
  sequence += 1;
  return `${workerIndex}${Date.now().toString(36)}${sequence}`;
}

/** An API client of the server, with the Origin header the sign-in service checks. */
function apiOf(server: RunningServer): Promise<APIRequestContext> {
  return request.newContext({ baseURL: server.url, extraHTTPHeaders: { origin: server.url } });
}

async function ok(response: Awaited<ReturnType<APIRequestContext["post"]>>, what: string): Promise<void> {
  if (!response.ok()) throw new Error(`${what}: HTTP ${response.status()} ${await response.text()}`);
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  server: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this pattern.
    async ({}, use, workerInfo) => {
      const webDist = process.env.VANR_E2E_WEB_DIST;
      if (webDist === undefined)
        throw new Error("VANR_E2E_WEB_DIST is not set: run through playwright.config.ts");
      const server = await startServer({
        webDist,
        logPath: join(
          workerInfo.project.outputDir,
          `server-${workerInfo.project.name}-${workerInfo.workerIndex}.log`,
        ),
      });
      await use(server);
      await server.stop();
    },
    { scope: "worker", timeout: 90_000 },
  ],

  states: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this pattern.
    async ({}, use) => use(new Map()),
    { scope: "worker" },
  ],

  baseURL: async ({ server }, use) => use(server.url),

  t: async ({ locale }, use) => {
    const language = webLocale(locale);
    const text: Text = (namespace, key, ...params) => {
      const message = (CATALOGS[language][namespace] as Catalog)[key];
      if (message === undefined) throw new Error(`no message ${namespace}.${key} in ${language}`);
      return formatMessage(message, params[0], language);
    };
    await use(text);
  },

  seedUser: async ({ server, states }, use, testInfo) => {
    const seed = async (options: SeedOptions = {}) => {
      const id = uniqueId(testInfo.workerIndex);
      const user = { name: `Ada ${id}`, email: `ada-${id}@people.example`, password: `pass-${id}-word` };
      const api = await apiOf(server);
      try {
        await ok(await api.post("/api/auth/sign-up/email", { data: user }), "sign-up");
        let workspace: SeededMember["workspace"] | undefined;
        if (options.workspace !== undefined) {
          const created = await api.post("/api/v1/workspaces", {
            data: { name: options.workspace, timezone: "UTC" },
          });
          await ok(created, "create workspace");
          const body = (await created.json()) as { workspace: { id: string; name: string } };
          workspace = { id: body.workspace.id, name: body.workspace.name };
        }
        // The sign-up already signed the person in: that session is the one signIn reuses.
        const path = join(server.dir, `state-${id}.json`);
        await api.storageState({ path });
        states.set(user.email, path);
        return workspace === undefined ? user : { ...user, workspace };
      } finally {
        await api.dispose();
      }
    };
    await use(seed as Fixtures["seedUser"]);
  },

  signIn: async ({ server, states, context }, use) => {
    await use(async (user) => {
      let path = states.get(user.email);
      if (path === undefined) {
        const api = await apiOf(server);
        try {
          await ok(
            await api.post("/api/auth/sign-in/email", {
              data: { email: user.email, password: user.password },
            }),
            "sign-in",
          );
          path = join(server.dir, `state-${encodeURIComponent(user.email)}.json`);
          await api.storageState({ path });
          states.set(user.email, path);
        } finally {
          await api.dispose();
        }
      }
      const state = JSON.parse(await readFile(path, "utf8")) as {
        cookies: Parameters<typeof context.addCookies>[0];
      };
      await context.addCookies(state.cookies);
    });
  },
});
