// The workspace's mail accounts, called as the integration routes will call them (they come with a later
// slice): an IMAP account is checked against the server before it is kept, and the hosted (Composio) account's
// callback spends its state once, for the same person and session, before it expires. The IMAP/SMTP server and
// Composio are local fakes; nothing goes out to the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { createSealer } from "@vanr/engine/seal";
import { eq } from "drizzle-orm";
import type { Starter } from "../src/integrations/connectors";
import {
  connectComposio,
  connectImap,
  finishComposio,
  foldersOf,
  sentOutOf,
  transmitMail,
} from "../src/integrations/mail";
import type { RunningServer } from "../src/server";
import { type FakeMailServer, startFakeMail } from "./fake-mail";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

const STATE_TTL_MS = 30 * 60_000;
let clock = new Date("2026-11-14T12:00:00Z");

/** The fake Composio: each connected account answers a redirect link. */
function fakeComposio() {
  const started: { authConfig: string; callback: string; apiKey: string | null }[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/v3/connected_accounts") return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init.body));
    started.push({
      authConfig: body.auth_config.id,
      callback: body.connection.callback_url,
      apiKey: new Headers(init.headers).get("x-api-key"),
    });
    return Response.json({ id: `ca_${started.length}`, redirect_url: "https://composio.test/consent" });
  };
  return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, started };
}

const composio = fakeComposio();
let mail: FakeMailServer;
let server: RunningServer;
let me: Starter;

beforeAll(async () => {
  mail = await startFakeMail();
  server = await startTestServer({
    env: {
      ALLOW_PRIVATE_NETWORKS: "true",
      COMPOSIO_API_KEY: "composio-key",
      COMPOSIO_API_URL: "https://composio.test",
      COMPOSIO_GMAIL_AUTH_CONFIG: "ac_gmail",
    },
    fetchExternal: composio.fetch,
    now: () => clock,
  });
  const ana = await signedIn(server, "Ana", "ana@mail.test");
  const { workspaceId } = await seedWorkspace(server, ana, "Mail");
  me = { workspaceId, userId: ana.user.id, role: "owner", handle: "ana", sessionId: "s-ana" };
}, SERVER_TEST_MS);
afterAll(async () => {
  await server.stop();
  mail.stop();
}, SERVER_TEST_MS);

const imapInput = (password: string, address = mail.user) => ({
  address,
  preset: "other",
  imapHost: mail.host,
  imapPort: mail.imapPort,
  smtpHost: mail.host,
  smtpPort: mail.smtpPort,
  username: mail.user,
  password,
});

describe("IMAP accounts", () => {
  test(
    "a wrong password is rejected before anything is kept; the right one connects once per address",
    async () => {
      await expect(connectImap(server.deps, me, imapInput("wrong"))).rejects.toMatchObject({
        code: "mail.auth",
      });
      expect(await server.deps.db.select().from(schema.mailConnections)).toEqual([]);
      const row = await connectImap(server.deps, me, imapInput(mail.password));
      expect(row).toMatchObject({ status: "active", via: "imap", workspaceId: me.workspaceId });
      // The password rests sealed.
      expect(row.secret).not.toContain(mail.password);
      expect((await foldersOf(server.deps, row)).map((f) => f.role)).toContain("inbox");
      await expect(connectImap(server.deps, me, imapInput(mail.password))).rejects.toMatchObject({
        code: "mail.exists",
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "a send says whether it had gone out when it failed",
    async () => {
      const [row] = await server.deps.db.select().from(schema.mailConnections);
      if (!row) throw new Error("no account");
      await transmitMail(
        server.deps,
        row,
        { from: mail.user, to: ["pat@example.test"] },
        "Subject: hi\r\n\r\nhi",
      );
      expect(mail.sent.at(-1)?.to).toEqual(["pat@example.test"]);
      // A wrong kept password fails at the IMAP login, before SMTP: nothing went out.
      const err = await transmitMail(
        server.deps,
        { ...row, secret: await withWrongPassword(row.secret) },
        { from: mail.user, to: ["pat@example.test"] },
        "x",
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "mail.auth" });
      expect(sentOutOf(err)).toBe(false);
    },
    SERVER_TEST_MS,
  );
});

/** The same account's secret with a wrong password, sealed as the module seals it. */
async function withWrongPassword(sealed: string | null): Promise<string | null> {
  const sealer = createSealer(server.deps.config.authSecret, "mail");
  if (!sealed) return null;
  return sealer.seal(JSON.stringify({ ...JSON.parse(sealer.open(sealed)), password: "wrong" }));
}

describe("hosted (Composio) accounts", () => {
  const stateIn = (callback: string) => new URL(callback).searchParams.get("state") ?? "";
  const account = async (id: string) =>
    (await server.deps.db.select().from(schema.mailConnections).where(eq(schema.mailConnections.id, id)))[0];

  test(
    "the callback turns the account on once; the state is bound to the session",
    async () => {
      const started = await connectComposio(server.deps, me, { provider: "gmail" });
      const call = composio.started.at(-1);
      expect(call).toMatchObject({ authConfig: "ac_gmail", apiKey: "composio-key" });
      expect(
        call?.callback.startsWith(`${server.deps.config.publicUrl}/api/v1/mail/composio/callback?state=`),
      ).toBe(true);
      const state = stateIn(call?.callback ?? "");
      const viewer = { userId: me.userId, sessionId: me.sessionId };
      expect((await account(started.accountId))?.status).toBe("pending");
      expect(await finishComposio(server.deps, viewer, { state, status: "success" })).toBe(
        `/workspace/${me.workspaceId}/settings/connectors?mail_connected=${started.accountId}`,
      );
      expect((await account(started.accountId))?.status).toBe("active");
      expect(await finishComposio(server.deps, viewer, { state, status: "success" })).toBe(
        "/?mail_error=state",
      );

      const other = await connectComposio(server.deps, me, { provider: "gmail" });
      const otherState = stateIn(composio.started.at(-1)?.callback ?? "");
      expect(
        await finishComposio(
          server.deps,
          { ...viewer, sessionId: "s-other" },
          { state: otherState, status: "success" },
        ),
      ).toContain("mail_error=state");
      expect((await account(other.accountId))?.status).toBe("pending");
    },
    SERVER_TEST_MS,
  );

  test(
    "a denied consent removes the pending account; the state lasts thirty minutes",
    async () => {
      const viewer = { userId: me.userId, sessionId: me.sessionId };
      const denied = await connectComposio(server.deps, me, { provider: "gmail" });
      const state = stateIn(composio.started.at(-1)?.callback ?? "");
      expect(await finishComposio(server.deps, viewer, { state, status: "failed" })).toContain(
        "mail_error=denied",
      );
      expect(await account(denied.accountId)).toBeUndefined();

      const early = await connectComposio(server.deps, me, { provider: "gmail" });
      const earlyState = stateIn(composio.started.at(-1)?.callback ?? "");
      clock = new Date(clock.getTime() + STATE_TTL_MS - 1);
      expect(await finishComposio(server.deps, viewer, { state: earlyState, status: "success" })).toContain(
        `mail_connected=${early.accountId}`,
      );
      await connectComposio(server.deps, me, { provider: "gmail" });
      const lateState = stateIn(composio.started.at(-1)?.callback ?? "");
      clock = new Date(clock.getTime() + STATE_TTL_MS);
      expect(await finishComposio(server.deps, viewer, { state: lateState, status: "success" })).toContain(
        "mail_error=state",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "a provider without an auth config is rejected before anything is kept",
    async () => {
      const before = composio.started.length;
      await expect(connectComposio(server.deps, me, { provider: "outlook" })).rejects.toMatchObject({
        code: "mail.composio_unavailable",
      });
      expect(composio.started.length).toBe(before);
    },
    SERVER_TEST_MS,
  );
});
