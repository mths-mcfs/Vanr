// Invitations: by email, in bulk, by link, expired, on a closed sign-up, and who may invite with which role.
// The workspace is created with members.createWorkspace (the workspaces routes come with slice S4) and the
// routes are called over HTTP (the typed API client isn't ported yet).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { sha256Hex } from "@vanr/engine/ids";
import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../src/context";
import { errorBody, HttpError } from "../src/http";
import { createWorkspace, memberRows } from "../src/members";
import { registerInvitations } from "../src/routes/invitations";
import type { RunningServer } from "../src/server";
import { Browser, body as read, signedIn, startTestServer } from "./harness";

// Many HTTP calls per test against a real server: a loaded host needs more than the default 5 s.
setDefaultTimeout(30_000);

let server: RunningServer;
/** A test that needs the clock at a given time freezes it here (and puts back the real one at the end). */
let frozen: Date | null = null;
beforeAll(async () => {
  server = await startTestServer({ now: () => frozen ?? new Date() });
});
afterAll(() => server.stop());

const tokenOf = (url: string) => url.split("/invite/")[1] ?? "";

/** Calls a route and returns the status and the JSON body (null without a body). */
async function call(b: Browser, method: string, path: string, payload?: unknown) {
  const res = await b.json(path, method, payload);
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: in tests the body is checked by the assertions
  const json: any = text ? JSON.parse(text) : null;
  return { status: res.status, body: json };
}

/** Signs up and creates a workspace with the person as owner. */
async function owner(local: RunningServer, name: string, email: string, workspaceName: string) {
  const p = await signedIn(local, name, email);
  const { workspaceId } = await createWorkspace(local.deps.db, {
    name: workspaceName,
    context: "",
    user: p.user,
  });
  return { ...p, workspaceId };
}

const ws = (id: string) => `/api/v1/workspaces/${id}`;

async function invite(b: Browser, workspaceId: string, email: string, role: "owner" | "admin" | "member") {
  const res = await call(b, "POST", `${ws(workspaceId)}/invitations`, { email, role });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as {
    invitation: { id: string; email: string; role: string; expiresAt: string };
    url: string;
  };
}

const preview = (b: Browser, token: string) => call(b, "GET", `/api/v1/invitations/${token}`);
const accept = (b: Browser, token: string) => call(b, "POST", `/api/v1/invitations/${token}/accept`);

describe("invitations", () => {
  test("invitation by email: preview without a session, wrong email, accept and single use", async () => {
    const ivo = await owner(server, "Ivo", "ivo@ws.test", "Invitations");
    const { invitation, url } = await invite(ivo.browser, ivo.workspaceId, "Joana@Ws.test", "admin");
    expect(invitation).toMatchObject({ email: "joana@ws.test", role: "admin" });
    const mail = server.mailer.sent().find((m) => m.kind === "invite" && m.to === "joana@ws.test");
    expect(mail?.link).toBe(url);

    const anon = new Browser(server.url);
    const shown = await preview(anon, tokenOf(url));
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      workspaceId: ivo.workspaceId,
      workspaceName: "Invitations",
      email: "joana@ws.test",
      role: "admin",
      invitedByName: "Ivo",
    });
    expect((await preview(anon, "token-that-does-not-exist")).status).toBe(404);
    const raw = await new Browser(server.url).fetch("/api/v1/invitations/does-not-exist");
    expect(await raw.json()).toEqual({
      error: { code: "not_found", message: "Invitation not found or expired" },
    });

    const wrong = await signedIn(server, "Kiko", "kiko@ws.test");
    const err = await accept(wrong.browser, tokenOf(url));
    expect([err.status, err.body.error.code, err.body.error.params?.email]).toEqual([
      403,
      "invitation.wrong_email",
      "joana@ws.test",
    ]);

    const joana = await signedIn(server, "Joana", "joana@ws.test");
    expect(await accept(joana.browser, tokenOf(url))).toEqual({
      status: 200,
      body: { workspaceId: ivo.workspaceId },
    });
    const me = await call(joana.browser, "GET", "/api/v1/me");
    expect(me.body.workspaces.map((w: { role: string }) => w.role)).toEqual(["admin"]);
    expect((await accept(joana.browser, tokenOf(url))).body).toEqual({ workspaceId: ivo.workspaceId });
    // Invitation already accepted: a member still sees the preview (and reaches the workspace); everyone else
    // gets `invitation.used` (410), not the 404 of an expired invitation, because asking for a new one doesn't apply.
    expect((await preview(joana.browser, tokenOf(url))).body).toMatchObject({ workspaceId: ivo.workspaceId });
    for (const who of [anon, wrong.browser]) {
      const used = await preview(who, tokenOf(url));
      expect([used.status, used.body.error.code]).toEqual([410, "invitation.used"]);
    }
    expect((await call(anon, "POST", `/api/v1/invitations/${tokenOf(url)}/request-new`)).status).toBe(404);
    const all = await call(ivo.browser, "GET", `${ws(ivo.workspaceId)}/invitations?scope=all`);
    expect(all.body.invitations[0]).toMatchObject({ email: "joana@ws.test", status: "accepted" });
    expect((await call(ivo.browser, "GET", `${ws(ivo.workspaceId)}/invitations`)).body.invitations).toEqual(
      [],
    );
    const again = await call(ivo.browser, "POST", `${ws(ivo.workspaceId)}/invitations`, {
      email: "joana@ws.test",
      role: "member",
    });
    expect([again.status, again.body.error.code]).toEqual([409, "already_member"]);
  });

  test("bulk invitations, resend, revoke and invite link", async () => {
    const lia = await owner(server, "Lia", "lia@ws.test", "Bulk");
    const id = lia.workspaceId;
    const first = (
      await call(lia.browser, "POST", `${ws(id)}/invitations/bulk`, {
        emails: ["m1@ws.test", "not-an-email", "lia@ws.test", "m1@ws.test", " M2@ws.test "],
        role: "member",
      })
    ).body.results as { email: string; status: string; url?: string }[];
    expect(first.map((r) => [r.email, r.status])).toEqual([
      ["m1@ws.test", "invited"],
      ["not-an-email", "bad_email"],
      ["lia@ws.test", "already_member"],
      ["m2@ws.test", "invited"],
    ]);
    const second = await call(lia.browser, "POST", `${ws(id)}/invitations/bulk`, {
      emails: ["m1@ws.test"],
      role: "member",
    });
    expect(second.body.results[0]?.status).toBe("already_invited");

    const pending = (await call(lia.browser, "GET", `${ws(id)}/invitations`)).body.invitations as {
      id: string;
      email: string;
    }[];
    expect(pending.map((i) => i.email).sort()).toEqual(["m1@ws.test", "m2@ws.test"]);
    const m1 = pending.find((i) => i.email === "m1@ws.test");
    if (!m1) throw new Error("m1 has no invitation");
    const oldUrl = first[0]?.url ?? "";
    const resent = (await call(lia.browser, "POST", `${ws(id)}/invitations/${m1.id}/resend`)).body;
    expect(resent.url).not.toBe(oldUrl);
    const anon = new Browser(server.url);
    expect((await preview(anon, tokenOf(oldUrl))).status).toBe(404);
    expect((await preview(anon, tokenOf(resent.url))).body).toMatchObject({ email: "m1@ws.test" });

    const m2 = pending.find((i) => i.email === "m2@ws.test");
    expect((await call(lia.browser, "DELETE", `${ws(id)}/invitations/${m2?.id ?? ""}`)).status).toBe(204);
    expect((await preview(anon, tokenOf(first[3]?.url ?? ""))).status).toBe(404);

    const link = (await call(lia.browser, "POST", `${ws(id)}/invite-links`)).body;
    for (const who of ["n1", "n2"]) {
      const p = await signedIn(server, who, `${who}@ws.test`);
      expect((await accept(p.browser, tokenOf(link.url))).body).toEqual({ workspaceId: id });
    }
    expect((await memberRows(server.deps.db, id)).length).toBe(3);
  });

  test("expired invitation: preview 404, accept 404 and asking for a new one tells whoever invited", async () => {
    let clock = new Date("2026-10-20T12:00:00Z");
    const local = await startTestServer({ now: () => clock });
    try {
      const otto = await owner(local, "Otto", "otto@ws.test", "Deadline");
      const { url } = await invite(otto.browser, otto.workspaceId, "pia@ws.test", "member");
      clock = new Date(clock.getTime() + 8 * 24 * 3600_000);
      const pia = await signedIn(local, "Pia", "pia@ws.test");
      expect((await preview(pia.browser, tokenOf(url))).status).toBe(404);
      expect((await accept(pia.browser, tokenOf(url))).status).toBe(404);
      const all = await call(otto.browser, "GET", `${ws(otto.workspaceId)}/invitations?scope=all`);
      expect(all.body.invitations[0]?.status).toBe("expired");
      expect(
        (await call(pia.browser, "POST", `/api/v1/invitations/${tokenOf(url)}/request-new`)).status,
      ).toBe(204);
      expect(
        (await call(pia.browser, "POST", `/api/v1/invitations/${tokenOf(url)}/request-new`)).status,
      ).toBe(204);
      const asks = local.mailer.sent().filter((m) => m.kind === "invite_request");
      expect(asks.map((m) => m.to)).toEqual(["otto@ws.test"]);
    } finally {
      await local.stop();
    }
  }, 30_000);

  test("closed sign-up accepts whoever has a pending invitation (by email or through the link)", async () => {
    const local = await startTestServer({ env: { SIGNUP_OPEN: "false" } });
    try {
      const rui = await owner(local, "Rui", "rui@ws.test", "Closed");
      const blocked = await new Browser(local.url).signUp("Nobody", "nobody@ws.test");
      expect(blocked.status).toBe(403);
      await invite(rui.browser, rui.workspaceId, "invited@ws.test", "member");
      expect((await new Browser(local.url).signUp("Invited", "invited@ws.test")).ok).toBe(true);

      const link = (await call(rui.browser, "POST", `${ws(rui.workspaceId)}/invite-links`)).body;
      const viaLink = new Browser(local.url);
      expect((await preview(viaLink, tokenOf(link.url))).status).toBe(200);
      expect((await viaLink.signUp("Through Link", "link@ws.test")).ok).toBe(true);
      expect((await accept(viaLink, tokenOf(link.url))).body).toEqual({ workspaceId: rui.workspaceId });
    } finally {
      await local.stop();
    }
  }, 30_000);
});

describe("roles", () => {
  test("a member doesn't manage invitations; an admin doesn't invite an owner", async () => {
    const sol = await owner(server, "Sol", "sol@ws.test", "Roles");
    const id = sol.workspaceId;
    const join = async (name: string, role: "admin" | "member") => {
      const { url } = await invite(sol.browser, id, `${name}@ws.test`, role);
      const p = await signedIn(server, name, `${name}@ws.test`);
      await accept(p.browser, tokenOf(url));
      return p;
    };
    const admin = await join("tais", "admin");
    const member = await join("ugo", "member");

    const byMember = await call(member.browser, "POST", `${ws(id)}/invitations`, {
      email: "x@ws.test",
      role: "member",
    });
    expect(byMember.status).toBe(403);
    const byAdmin = await call(admin.browser, "POST", `${ws(id)}/invitations`, {
      email: "y@ws.test",
      role: "owner",
    });
    expect(byAdmin.status).toBe(403);
  });
});

// Rules of the invitation routes the origin didn't test, one test each.
describe("invitation rules", () => {
  test("every workspace route of invitations: 401 without a session, 404 outside, 403 for a member", async () => {
    const vera = await owner(server, "Vera", "vera@ws.test", "Fences");
    const id = vera.workspaceId;
    const { invitation, url } = await invite(vera.browser, id, "wes@ws.test", "member");
    const memberUrl = (await invite(vera.browser, id, "mo@ws.test", "member")).url;
    const mo = await signedIn(server, "Mo", "mo@ws.test");
    await accept(mo.browser, tokenOf(memberUrl));
    const stranger = await owner(server, "Stan", "stan@ws.test", "Elsewhere");
    const routes: [string, string, unknown?][] = [
      ["GET", `${ws(id)}/invitations`],
      ["GET", `${ws(id)}/invitations?scope=all`],
      ["POST", `${ws(id)}/invitations`, { email: "z@ws.test", role: "member" }],
      ["POST", `${ws(id)}/invitations/bulk`, { emails: ["z@ws.test"], role: "member" }],
      ["POST", `${ws(id)}/invitations/${invitation.id}/resend`],
      ["DELETE", `${ws(id)}/invitations/${invitation.id}`],
      ["POST", `${ws(id)}/invite-links`],
    ];
    for (const [method, path, payload] of routes) {
      expect([method, path, (await call(new Browser(server.url), method, path, payload)).status]).toEqual([
        method,
        path,
        401,
      ]);
      expect([method, path, (await call(stranger.browser, method, path, payload)).status]).toEqual([
        method,
        path,
        404,
      ]);
      expect([method, path, (await call(mo.browser, method, path, payload)).status]).toEqual([
        method,
        path,
        403,
      ]);
    }
    // Nothing changed: the invitation is still pending and its link still works.
    expect((await preview(new Browser(server.url), tokenOf(url))).status).toBe(200);
    // Accepting needs a session.
    expect((await accept(new Browser(server.url), tokenOf(url))).status).toBe(401);
  });

  test("another workspace's admin can neither resend nor revoke this workspace's invitation", async () => {
    const a = await owner(server, "Ada", "ada@ws.test", "A");
    const b = await owner(server, "Bea", "bea@ws.test", "B");
    const { invitation, url } = await invite(a.browser, a.workspaceId, "cal@ws.test", "member");
    // B's admin uses B's path with A's invitation id.
    expect(
      (await call(b.browser, "POST", `${ws(b.workspaceId)}/invitations/${invitation.id}/resend`)).status,
    ).toBe(404);
    expect(
      (await call(b.browser, "DELETE", `${ws(b.workspaceId)}/invitations/${invitation.id}`)).status,
    ).toBe(404);
    expect((await preview(new Browser(server.url), tokenOf(url))).status).toBe(200);
  });

  test("an owner invites an owner; an admin invites an admin but can't resend an owner's invitation", async () => {
    const olga = await owner(server, "Olga", "olga@ws.test", "Owners");
    const id = olga.workspaceId;
    const ownerInvite = await invite(olga.browser, id, "other-owner@ws.test", "owner");
    expect(ownerInvite.invitation.role).toBe("owner");
    const { url } = await invite(olga.browser, id, "adm@ws.test", "admin");
    const adm = await signedIn(server, "Adm", "adm@ws.test");
    await accept(adm.browser, tokenOf(url));
    expect(
      (await call(adm.browser, "POST", `${ws(id)}/invitations`, { email: "a2@ws.test", role: "admin" }))
        .status,
    ).toBe(201);
    expect(
      (
        await call(adm.browser, "POST", `${ws(id)}/invitations/bulk`, {
          emails: ["o2@ws.test"],
          role: "owner",
        })
      ).status,
    ).toBe(403);
    const resend = await call(
      adm.browser,
      "POST",
      `${ws(id)}/invitations/${ownerInvite.invitation.id}/resend`,
    );
    expect(resend.status).toBe(403);
    // The owner's invitation was left as it was.
    expect((await preview(new Browser(server.url), tokenOf(ownerInvite.url))).body).toMatchObject({
      role: "owner",
    });
  });

  test("inviting the same email again renews the invitation: the old link stops and only one stays pending", async () => {
    const rita = await owner(server, "Rita", "rita@ws.test", "Renew");
    const first = await invite(rita.browser, rita.workspaceId, "ren@ws.test", "member");
    const second = await invite(rita.browser, rita.workspaceId, "REN@ws.test", "admin");
    expect((await preview(new Browser(server.url), tokenOf(first.url))).status).toBe(404);
    expect((await preview(new Browser(server.url), tokenOf(second.url))).body).toMatchObject({
      role: "admin",
    });
    const pending = (await call(rita.browser, "GET", `${ws(rita.workspaceId)}/invitations`)).body.invitations;
    expect(pending.map((i: { email: string }) => i.email)).toEqual(["ren@ws.test"]);
    const all = (await call(rita.browser, "GET", `${ws(rita.workspaceId)}/invitations?scope=all`)).body
      .invitations;
    expect(all.map((i: { status: string }) => i.status).sort()).toEqual(["pending", "revoked"]);
  });

  test("a revoked invitation can't be accepted or revoked again, but can be resent; an accepted one can't be resent", async () => {
    const remo = await owner(server, "Remo", "remo@ws.test", "Revoked");
    const id = remo.workspaceId;
    const { invitation, url } = await invite(remo.browser, id, "rev@ws.test", "member");
    expect((await call(remo.browser, "DELETE", `${ws(id)}/invitations/${invitation.id}`)).status).toBe(204);
    expect((await call(remo.browser, "DELETE", `${ws(id)}/invitations/${invitation.id}`)).status).toBe(404);
    const rev = await signedIn(server, "Rev", "rev@ws.test");
    expect((await accept(rev.browser, tokenOf(url))).status).toBe(404);
    expect((await memberRows(server.deps.db, id)).length).toBe(1);
    const resent = await call(remo.browser, "POST", `${ws(id)}/invitations/${invitation.id}/resend`);
    expect(resent.status).toBe(200);
    expect((await accept(rev.browser, tokenOf(resent.body.url))).body).toEqual({ workspaceId: id });
    const accepted = (
      await call(remo.browser, "GET", `${ws(id)}/invitations?scope=all`)
    ).body.invitations.find((i: { status: string }) => i.status === "accepted");
    expect((await call(remo.browser, "POST", `${ws(id)}/invitations/${accepted.id}/resend`)).status).toBe(
      404,
    );
  });

  test("the invitation lasts 7 days: valid one second before, gone at the deadline", async () => {
    const tom = await owner(server, "Tom", "tom@ws.test", "Week");
    const start = new Date(Math.floor(Date.now() / 1000) * 1000);
    frozen = start;
    try {
      const { invitation, url } = await invite(tom.browser, tom.workspaceId, "wk@ws.test", "member");
      const deadline = start.getTime() + 7 * 24 * 3600_000;
      expect(new Date(invitation.expiresAt).getTime()).toBe(deadline);
      frozen = new Date(deadline - 1000);
      expect((await preview(new Browser(server.url), tokenOf(url))).status).toBe(200);
      frozen = new Date(deadline);
      expect((await preview(new Browser(server.url), tokenOf(url))).status).toBe(404);
    } finally {
      frozen = null;
    }
  });

  test("the preview leaves the invitation cookie only for a valid invitation, scoped to the auth routes", async () => {
    const pam = await owner(server, "Pam", "pam@ws.test", "Cookie");
    const { url } = await invite(pam.browser, pam.workspaceId, "ck@ws.test", "member");
    const res = await new Browser(server.url).fetch(`/api/v1/invitations/${tokenOf(url)}`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("vanr.invite="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain(`vanr.invite=${tokenOf(url)}`);
    expect(cookie).toContain("Path=/api/auth");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    // http in the tests: not Secure. 7 days, in seconds.
    expect(cookie).not.toContain("Secure");
    expect(Number(/Max-Age=(\d+)/.exec(cookie ?? "")?.[1])).toBeGreaterThan(7 * 24 * 3600 - 60);
    const ck = await signedIn(server, "Ck", "ck@ws.test");
    await accept(ck.browser, tokenOf(url));
    // A member opening the used invitation still sees the preview, without a new cookie.
    const again = await ck.browser.fetch(`/api/v1/invitations/${tokenOf(url)}`);
    expect(again.status).toBe(200);
    expect(again.headers.getSetCookie().some((c) => c.startsWith("vanr.invite="))).toBe(false);
  });

  describe("on a closed sign-up", () => {
    let closed: RunningServer;
    let una: Awaited<ReturnType<typeof owner>>;
    beforeAll(async () => {
      closed = await startTestServer({ env: { SIGNUP_OPEN: "false" } });
      una = await owner(closed, "Una", "una@ws.test", "Closed");
    });
    afterAll(() => closed.stop());

    test("the cookie of an email invitation only lets that email in; a bogus cookie lets nobody", async () => {
      const { url } = await invite(una.browser, una.workspaceId, "only@ws.test", "member");
      const other = new Browser(closed.url);
      expect((await preview(other, tokenOf(url))).status).toBe(200);
      const rejected = await other.signUp("Other", "other@ws.test");
      expect(rejected.status).toBe(403);
      expect(await read(rejected)).toMatchObject({ code: "SIGNUP_CLOSED" });
      const bogus = new Browser(closed.url);
      bogus.cookies.set("vanr.invite", "made-up-token");
      expect((await bogus.signUp("Bogus", "bogus@ws.test")).status).toBe(403);
      // The invited email in another case gets in.
      expect((await new Browser(closed.url).signUp("Only", "ONLY@ws.test")).ok).toBe(true);
    });

    test("two simultaneous sign-ups with the same invitation don't both get in", async () => {
      await invite(una.browser, una.workspaceId, "twin@ws.test", "member");
      const before = (await closed.deps.db.select({ n: count() }).from(schema.users))[0]?.n ?? 0;
      const results = await Promise.all(
        [0, 1].map((i) => new Browser(closed.url).signUp(`Twin ${i}`, "twin@ws.test")),
      );
      expect(results.filter((r) => r.ok).length).toBe(1);
      const after = (await closed.deps.db.select({ n: count() }).from(schema.users))[0]?.n ?? 0;
      expect(after - before).toBe(1);
    });

    test("an invitation cookie that doesn't decode, or is too long, counts as absent", async () => {
      await invite(una.browser, una.workspaceId, "pending@ws.test", "member");
      const logged: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
        logged.push(String(chunk));
        return write(chunk, ...rest);
      }) as typeof process.stderr.write;
      try {
        const malformed = new Browser(closed.url);
        malformed.cookies.set("vanr.invite", "%E0%A4%A");
        // The email has a pending invitation: the broken cookie doesn't get in the way.
        expect((await malformed.signUp("Pending", "pending@ws.test")).status).toBe(200);
        const link = (await call(una.browser, "POST", `${ws(una.workspaceId)}/invite-links`)).body;
        // A valid token padded past the limit is not read: the link doesn't let this email in.
        const long = new Browser(closed.url);
        long.cookies.set("vanr.invite", tokenOf(link.url) + "A".repeat(300));
        expect((await long.signUp("Long", "long@ws.test")).status).toBe(403);
        const badOnly = new Browser(closed.url);
        badOnly.cookies.set("vanr.invite", "%E0%A4%A");
        expect((await badOnly.signUp("Nobody", "nobody2@ws.test")).status).toBe(403);
      } finally {
        process.stderr.write = write;
      }
      expect(logged.filter((l) => /URIError|%E0%A4%A|AAAAAAAAAA/.test(l))).toEqual([]);
    });
  });

  test("two simultaneous accepts of one email invitation: one member, the invitation accepted once", async () => {
    const wu = await owner(server, "Wu", "wu@ws.test", "Accept race");
    const { invitation, url } = await invite(wu.browser, wu.workspaceId, "duo@ws.test", "member");
    const duo = await signedIn(server, "Duo", "duo@ws.test");
    const results = await Promise.all([accept(duo.browser, tokenOf(url)), accept(duo.browser, tokenOf(url))]);
    expect(results.every((r) => r.status === 200 || r.status === 404)).toBe(true);
    expect((await memberRows(server.deps.db, wu.workspaceId)).map((m) => m.userId).sort()).toEqual(
      [wu.user.id, duo.user.id].sort(),
    );
    const [row] = await server.deps.db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.id, invitation.id));
    expect(row).toMatchObject({ status: "accepted", endorsedBy: duo.user.id });
    expect(row?.tokenHash).toBe(sha256Hex(tokenOf(url)));
  });

  test("bodies outside the schema are rejected with 400, before any write", async () => {
    const xia = await owner(server, "Xia", "xia@ws.test", "Schema");
    const id = xia.workspaceId;
    for (const payload of [
      { email: "not-an-email", role: "member" },
      { email: "ok@ws.test", role: "superuser" },
      { email: `${"a".repeat(250)}@ws.test`, role: "member" },
      {},
    ]) {
      expect((await call(xia.browser, "POST", `${ws(id)}/invitations`, payload)).status).toBe(400);
    }
    const tooMany = Array.from({ length: 101 }, (_, i) => `b${i}@ws.test`);
    for (const payload of [
      { emails: [], role: "member" },
      { emails: tooMany, role: "member" },
    ]) {
      expect((await call(xia.browser, "POST", `${ws(id)}/invitations/bulk`, payload)).status).toBe(400);
    }
    expect((await call(xia.browser, "GET", `${ws(id)}/invitations?scope=everything`)).status).toBe(400);
    const all = (await call(xia.browser, "GET", `${ws(id)}/invitations?scope=all`)).body.invitations;
    expect(all).toEqual([]);
  });
});

// The pair (workspace, email) has at most one pending invitation, whatever runs at the same time.
describe("invitations at the same time", () => {
  const N = 20;
  /**
   * The invitation routes in the process with the session already resolved: Better Auth's session lookup runs
   * the requests of one person one after the other, so through the whole app they rarely overlap on PGlite.
   * Here every request's queries interleave on the database, as they do on Postgres with a pool.
   */
  const callNow = async (b: Browser, method: string, path: string, payload?: unknown) => {
    const me = await call(b, "GET", "/api/v1/me");
    const app = new Hono<AppEnv>();
    app.onError((err, c) =>
      err instanceof HttpError
        ? c.json(errorBody(err.code, err.message), err.status)
        : c.json({ error: String(err) }, 500),
    );
    app.use("*", async (c, next) => {
      c.set("deps", server.deps);
      c.set("user", me.body.user);
      const workspaceId = c.req.param("workspaceId") ?? /workspaces\/([^/]+)/.exec(c.req.path)?.[1];
      const [m] = workspaceId
        ? await server.deps.db
            .select()
            .from(schema.members)
            .where(
              and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, me.body.user.id)),
            )
        : [];
      c.set(
        "member",
        m && workspaceId ? { workspaceId, userId: m.userId, role: m.role, handle: m.handle } : null,
      );
      await next();
    });
    registerInvitations(app);
    return async () => {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
      });
      const text = await res.text();
      // biome-ignore lint/suspicious/noExplicitAny: in tests the body is checked by the assertions
      const json: any = text ? JSON.parse(text) : null;
      return { status: res.status, body: json };
    };
  };
  /** Prepares every request first (the session lookups), then fires them all at once. */
  const together = async <R>(calls: Promise<() => Promise<R>>[]) => {
    const ready = await Promise.all(calls);
    return Promise.all(ready.map((go) => go()));
  };
  const pendingOf = async (workspaceId: string, email: string) =>
    server.deps.db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.workspaceId, workspaceId),
          eq(schema.invitations.email, email),
          eq(schema.invitations.status, "pending"),
        ),
      );
  /** How many of the links still open a preview. */
  const working = async (urls: string[]) => {
    const anon = new Browser(server.url);
    const statuses = await Promise.all(urls.map(async (u) => (await preview(anon, tokenOf(u))).status));
    return urls.filter((_, i) => statuses[i] === 200);
  };

  test("N invitations to one email with different roles and cases: one pending, and only its link works", async () => {
    const o = await owner(server, "Nia", "nia@ws.test", "Same time");
    const results = await together(
      Array.from({ length: N }, (_, i) =>
        callNow(o.browser, "POST", `${ws(o.workspaceId)}/invitations`, {
          email: i % 2 ? " Same@WS.test " : "same@ws.test",
          role: i % 2 ? "admin" : "member",
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(N).fill(201));
    const pending = await pendingOf(o.workspaceId, "same@ws.test");
    expect(pending.length).toBe(1);
    const alive = await working(results.map((r) => r.body.url));
    expect(alive.length).toBe(1);
    expect(sha256Hex(tokenOf(alive[0] ?? ""))).toBe(pending[0]?.tokenHash ?? "");
  });

  test("N bulk requests that repeat one email: one pending, one result says invited", async () => {
    const o = await owner(server, "Bo", "bo@ws.test", "Bulk same time");
    const results = await together(
      Array.from({ length: N }, () =>
        callNow(o.browser, "POST", `${ws(o.workspaceId)}/invitations/bulk`, {
          emails: ["twice@ws.test", "TWICE@ws.test"],
          role: "member",
        }),
      ),
    );
    const statuses = results.flatMap((r) => r.body.results.map((x: { status: string }) => x.status));
    expect(statuses.filter((x) => x === "invited").length).toBe(1);
    expect(statuses.filter((x) => x === "already_invited").length).toBe(N - 1);
    expect((await pendingOf(o.workspaceId, "twice@ws.test")).length).toBe(1);
  });

  test("N resends together with a revoke: one pending at most, and only its link works", async () => {
    const o = await owner(server, "Rex", "rex@ws.test", "Resend same time");
    const { invitation, url } = await invite(o.browser, o.workspaceId, "again@ws.test", "member");
    const base = `${ws(o.workspaceId)}/invitations/${invitation.id}`;
    const results = await together([
      ...Array.from({ length: N }, () => callNow(o.browser, "POST", `${base}/resend`)),
      callNow(o.browser, "DELETE", base),
    ]);
    const urls = [url, ...results.filter((r) => r.status === 200).map((r) => r.body.url)];
    const pending = await pendingOf(o.workspaceId, "again@ws.test");
    expect(pending.length).toBeLessThanOrEqual(1);
    const alive = await working(urls);
    expect(alive.length).toBe(pending.length);
    if (alive[0]) expect(sha256Hex(tokenOf(alive[0]))).toBe(pending[0]?.tokenHash ?? "");
  });

  test("accepting while the same email is invited again: never a member with a pending invitation", async () => {
    const o = await owner(server, "Ace", "ace@ws.test", "Accept same time");
    const { url } = await invite(o.browser, o.workspaceId, "both@ws.test", "member");
    const both = await signedIn(server, "Both", "both@ws.test");
    const [accepted, again] = await together([
      callNow(both.browser, "POST", `/api/v1/invitations/${tokenOf(url)}/accept`),
      callNow(o.browser, "POST", `${ws(o.workspaceId)}/invitations`, {
        email: "both@ws.test",
        role: "admin",
      }),
    ]);
    const member = (await memberRows(server.deps.db, o.workspaceId)).some((m) => m.userId === both.user.id);
    const pending = await pendingOf(o.workspaceId, "both@ws.test");
    expect([member, pending.length]).toEqual(member ? [true, 0] : [false, 1]);
    // Either the accept came first (member, the new invitation rejected) or the renewal did (old link gone).
    expect([accepted?.status, again?.status]).toEqual(member ? [200, 409] : [404, 201]);
  });

  test("N requests for a new invitation at once tell whoever invited once", async () => {
    let frozenHere = new Date();
    frozen = frozenHere;
    try {
      const o = await owner(server, "Req", "req@ws.test", "Ask same time");
      const { url } = await invite(o.browser, o.workspaceId, "late@ws.test", "member");
      frozenHere = new Date(frozenHere.getTime() + 8 * 24 * 3600_000);
      frozen = frozenHere;
      const before = server.mailer
        .sent()
        .filter((m) => m.kind === "invite_request" && m.to === "req@ws.test").length;
      const anon = new Browser(server.url);
      const results = await together(
        Array.from({ length: N }, () =>
          callNow(anon, "POST", `/api/v1/invitations/${tokenOf(url)}/request-new`),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(N).fill(204));
      const asks = server.mailer.sent().filter((m) => m.kind === "invite_request" && m.to === "req@ws.test");
      expect(asks.length - before).toBe(1);
    } finally {
      frozen = null;
    }
  });
});
