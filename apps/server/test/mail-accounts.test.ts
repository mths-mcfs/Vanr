// The workspace's mail accounts, called as the integration routes will call them (they come with a later
// slice): an IMAP account is checked against the server before it is kept, and the hosted (Composio) account's
// callback spends its state once, for the same person and session, before it expires. The IMAP/SMTP server and
// Composio are local fakes; nothing goes out to the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
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
  updateMailAccount,
} from "../src/integrations/mail";
import type { RunningServer } from "../src/server";
import { type FakeMailServer, startFakeMail } from "./fake-mail";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

const STATE_TTL_MS = 30 * 60_000;
let clock = new Date("2026-11-14T12:00:00Z");

/** The fake Composio: each connected account answers a redirect link. */
function fakeComposio() {
  const started: { authConfig: string; callback: string; apiKey: string | null; accountId: string }[] = [];
  /** Answers once with a body that isn't JSON and repeats the key it got. */
  const mode = { echo: false, status: "ACTIVE", address: "", profileStatus: 200 };
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    expect(new Headers(init.headers).get("x-api-key")).toBe("composio-key");
    const id = url.pathname.split("/").at(-1) ?? "";
    if (url.pathname.startsWith("/api/v3/connected_accounts/")) {
      const call = started[Number(id.replace("ca_", "")) - 1];
      return Response.json({
        id,
        user_id: call?.accountId,
        status: mode.status,
        is_disabled: false,
        toolkit: { slug: call?.authConfig === "ac_gmail" ? "gmail" : "outlook" },
        auth_config: { id: call?.authConfig },
      });
    }
    if (url.pathname === "/api/v3/tools/execute/proxy") {
      const body = JSON.parse(String(init.body));
      const gmail = body.endpoint === "https://gmail.googleapis.com/gmail/v1/users/me/profile";
      expect([
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        "https://graph.microsoft.com/v1.0/me?$select=mail",
      ]).toContain(body.endpoint);
      expect(body.method).toBe("GET");
      expect(body.connected_account_id).toMatch(/^ca_/);
      return Response.json({
        status: mode.profileStatus,
        data: gmail
          ? { emailAddress: mode.address || `ana${started.length}@gmail.com` }
          : { mail: mode.address || `ana${started.length}@outlook.com` },
      });
    }
    if (url.pathname !== "/api/v3/connected_accounts") return new Response("not found", { status: 404 });
    if (mode.echo) {
      mode.echo = false;
      return new Response(`{oops key=${new Headers(init.headers).get("x-api-key")}`);
    }
    const body = JSON.parse(String(init.body));
    started.push({
      authConfig: body.auth_config.id,
      accountId: body.connection.user_id,
      callback: body.connection.callback_url,
      apiKey: new Headers(init.headers).get("x-api-key"),
    });
    return Response.json({ id: `ca_${started.length}`, redirect_url: "https://composio.test/consent" });
  };
  return { fetch: Object.assign(fn, { preconnect: () => {} }) as typeof fetch, started, mode };
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
      expect(await account(started.accountId)).toMatchObject({ status: "active", address: "ana1@gmail.com" });
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
    "only an authorized account with a verified mailbox becomes active",
    async () => {
      const cfg = server.deps.config;
      if (!cfg.integrations.composio) throw new Error("Composio is configured");
      const deps = {
        ...server.deps,
        config: {
          ...cfg,
          integrations: {
            ...cfg.integrations,
            composio: {
              ...cfg.integrations.composio,
              authConfigs: { gmail: "ac_gmail", outlook: "ac_outlook" },
            },
          },
        },
      };
      for (const mode of [
        { provider: "gmail", status: "INITIATED", address: "ana@example.com", profileStatus: 200 },
        { provider: "outlook", status: "ACTIVE", address: "ana@example.com", profileStatus: 403 },
        { provider: "outlook", status: "ACTIVE", address: " Ana@Example.COM ", profileStatus: 200 },
      ] as const) {
        Object.assign(composio.mode, mode);
        const started = await connectComposio(deps, me, { provider: mode.provider });
        const state = stateIn(composio.started.at(-1)?.callback ?? "");
        await finishComposio(
          deps,
          { userId: me.userId, sessionId: me.sessionId },
          { state, status: "success" },
        );
        const row = await account(started.accountId);
        expect(row?.status === "active").toBe(mode.address.startsWith(" ") && mode.profileStatus === 200);
        if (row?.status === "active") expect(row.address).toBe("ana@example.com");
      }
      Object.assign(composio.mode, { status: "ACTIVE", address: "", profileStatus: 200 });
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

/** What the server writes to its log (stderr) while `run` runs. */
async function logged(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run().catch(() => {});
  } finally {
    process.stderr.write = write;
  }
  return lines.join("");
}

describe("outside text in errors and logs", () => {
  test(
    "an IMAP server that echoes the password in its error doesn't get it into ours",
    async () => {
      const password = 'app"pass\\word+/=';
      const sockets = new Set<Socket>();
      const imap = createServer((sock) => {
        sockets.add(sock);
        sock.on("close", () => sockets.delete(sock));
        sock.write("* OK ready\r\n");
        let buf = "";
        sock.on("data", (chunk) => {
          buf += chunk.toString();
          for (let n = buf.indexOf("\r\n"); n >= 0; n = buf.indexOf("\r\n")) {
            const line = buf.slice(0, n);
            buf = buf.slice(n + 2);
            const tag = line.split(" ")[0];
            if (line.includes("LOGIN")) sock.write(`${tag} OK logged in\r\n`);
            else if (line.includes("LOGOUT")) sock.end(`* BYE\r\n${tag} OK bye\r\n`);
            else
              sock.write(
                `${tag} BAD you said ${line} with ${Buffer.from(password).toString("base64")}\u0007\r\n`,
              );
          }
        });
      });
      await new Promise<void>((r) => imap.listen(0, "127.0.0.1", () => r()));
      const address = imap.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        const err = await connectImap(server.deps, me, {
          address: "echo@mail.test",
          preset: "other",
          imapHost: "127.0.0.1",
          imapPort: port,
          smtpHost: "127.0.0.1",
          smtpPort: port,
          password,
        }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "mail.unreachable" });
        const message = err instanceof Error ? err.message : "";
        for (const form of [password, Buffer.from(password).toString("base64")])
          expect([form, message.includes(form)]).toEqual([form, false]);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion is about control characters
        expect(/[\u0000-\u001f]/.test(message)).toBe(false);
      } finally {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => imap.close(() => r()));
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a Composio answer that repeats our key doesn't put it in the log",
    async () => {
      composio.mode.echo = true;
      const log = await logged(() => connectComposio(server.deps, me, { provider: "gmail" }));
      expect(log).toContain("mail.composio_failed");
      expect(log.includes("composio-key")).toBe(false);
    },
    SERVER_TEST_MS,
  );
});

/** The same server under another network rule (the installation's two switches). */
const under = (allowPrivateNetworks: boolean, allowPlaintext: boolean) => ({
  ...server.deps,
  config: {
    ...server.deps.config,
    integrations: { ...server.deps.config.integrations, allowPrivateNetworks, allowPlaintext },
  },
});

describe("the network rule on mail accounts", () => {
  test(
    "with the local network allowed and plain text off, a loopback account is tried over TLS",
    async () => {
      const first: number[] = [];
      const listener = createServer((socket: Socket) => {
        socket.once("data", (chunk: Buffer) => {
          first.push(chunk[0] ?? -1);
          socket.destroy();
        });
      });
      await new Promise<void>((r) => listener.listen(0, "localhost", () => r()));
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        const err = await connectImap(under(true, false), me, {
          address: "tls@mail.test",
          preset: "other",
          imapHost: "localhost",
          imapPort: port,
          smtpHost: "localhost",
          smtpPort: port,
          password: "tls-test-password",
        }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "mail.unreachable" });
        // 0x16: the first byte of a TLS handshake record (the ClientHello).
        expect(first).toEqual([0x16]);
      } finally {
        await new Promise<void>((r) => listener.close(() => r()));
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a kept account the rule now refuses reports the mail code and the reason, on use and on edit",
    async () => {
      const row = await connectImap(server.deps, me, imapInput(mail.password, "rule@mail.test"));
      await expect(foldersOf(under(false, true), row)).rejects.toMatchObject({ code: "mail.blocked_host" });
      // The account was kept without TLS (loopback, plain text allowed then); plain text is off now.
      await expect(foldersOf(under(true, false), row)).rejects.toMatchObject({
        code: "mail.tls_required",
        message: "This installation only connects to servers over TLS",
      });
      await expect(
        updateMailAccount(under(true, false), row, { password: mail.password }),
      ).rejects.toMatchObject({
        code: "mail.tls_required",
      });
    },
    SERVER_TEST_MS,
  );
});
