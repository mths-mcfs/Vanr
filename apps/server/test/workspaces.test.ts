// Workspaces and invitations: creating a workspace, its settings, overview, usage, logo, people and roles; and
// invitations by email, in bulk, by link, expired, on a closed sign-up, and who may invite with which role. The
// invitation tests create the workspace with members.createWorkspace, the workspace tests through its route;
// every route is called over HTTP.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId, sha256Hex } from "@vanr/engine/ids";
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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
).toString("base64");

/** Creates a workspace through its route, as the web app does after sign-up. */
async function create(b: Browser, input: { name: string; context?: string; timezone?: string }) {
  const res = await call(b, "POST", "/api/v1/workspaces", input);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as {
    workspace: { id: string; name: string; context: string; logo: string | null };
    defaultChannelId: string;
  };
}

describe("workspaces", () => {
  test("create already makes #general, puts the creator as owner and shows up in /me", async () => {
    const { browser, user } = await signedIn(server, "Ana Souza", "ana@space.test");
    const { workspace, defaultChannelId } = await create(browser, { name: "Bakery", context: "Bread" });
    expect(workspace).toMatchObject({ name: "Bakery", context: "Bread", logo: null });
    expect(defaultChannelId).toStartWith("ch_");
    const me = (await call(browser, "GET", "/api/v1/me")).body;
    expect(me?.workspaces).toEqual([{ id: workspace.id, name: "Bakery", role: "owner", logo: null }]);
    const members = (await call(browser, "GET", `${ws(workspace.id)}/members`)).body.members;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      userId: user.id,
      role: "owner",
      handle: "ana-souza",
      email: "ana@space.test",
    });
    expect((await call(browser, "GET", ws(workspace.id))).body).toMatchObject({
      id: workspace.id,
      name: "Bakery",
    });
  });

  test("a non-member gets 404, no session 401", async () => {
    const bia = await signedIn(server, "Bia", "bia@space.test");
    const { workspace } = await create(bia.browser, { name: "Closed" });
    const caio = await signedIn(server, "Caio", "caio@space.test");
    const err = await call(caio.browser, "GET", ws(workspace.id));
    expect([err.status, err.body.error.code]).toEqual([404, "not_found"]);
    expect((await call(new Browser(server.url), "GET", ws(workspace.id))).status).toBe(401);
    expect((await call(caio.browser, "GET", ws("workspace_missing"))).status).toBe(404);
  });

  test("settings, update, overview and usage", async () => {
    const { browser } = await signedIn(server, "Duda", "duda@space.test");
    const { workspace } = await create(browser, { name: "Shop" });
    const id = workspace.id;
    expect((await call(browser, "GET", `${ws(id)}/settings`)).body).toEqual({
      name: "Shop",
      context: "",
      timezone: "America/Sao_Paulo",
      primaryCredentialId: null,
      agentBudgetDefaultUsd: 20,
      approvalReviewer: false,
    });
    const s = await call(browser, "PATCH", `${ws(id)}/settings`, {
      timezone: "Europe/Lisbon",
      agentBudgetDefaultUsd: 35,
    });
    expect(s.body).toMatchObject({ timezone: "Europe/Lisbon", agentBudgetDefaultUsd: 35 });
    expect((await call(browser, "PATCH", `${ws(id)}/settings`, { timezone: "Mars/Base" })).status).toBe(400);
    await call(browser, "PATCH", ws(id), { name: "New Shop", context: "We sell" });
    expect((await call(browser, "GET", ws(id))).body).toMatchObject({ name: "New Shop", context: "We sell" });
    expect((await call(browser, "GET", `${ws(id)}/overview`)).body).toEqual({
      myApprovalQueue: 0,
      budgetSpentPct: 0,
      people: 1,
      agents: 0,
    });
    const report = (await call(browser, "GET", `${ws(id)}/usage/report?since=2026-10-01`)).body;
    expect(report).toEqual({ spendUsd: 0, since: "2026-10-01T00:00:00.000Z", perKind: [], agents: [] });
  });

  test("logo and avatar: the image is checked by its content and served only to members", async () => {
    const { browser } = await signedIn(server, "Eva", "eva@space.test");
    const { workspace } = await create(browser, { name: "With logo" });
    const id = workspace.id;
    const { logo } = (
      await call(browser, "PUT", `${ws(id)}/logo`, { imageBase64: PNG, contentType: "image/png" })
    ).body;
    expect(logo).toStartWith(`/api/v1/workspaces/${id}/logo?v=`);
    const img = await browser.fetch(logo);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    const fake = await call(browser, "PUT", `${ws(id)}/logo`, {
      imageBase64: PNG,
      contentType: "image/jpeg",
    });
    expect(fake.status).toBe(400);
    const svg = Buffer.from("<svg onload=alert(1)>").toString("base64");
    expect(
      (await call(browser, "PUT", `${ws(id)}/logo`, { imageBase64: svg, contentType: "image/svg+xml" }))
        .status,
    ).toBe(400);
    expect((await call(browser, "GET", "/api/v1/me")).body?.workspaces[0]?.logo).toBe(logo);
    await call(browser, "DELETE", `${ws(id)}/logo`);
    expect((await browser.fetch(logo)).status).toBe(404);

    const { avatarUrl } = (
      await call(browser, "PUT", `${ws(id)}/me/avatar`, { imageBase64: PNG, contentType: "image/png" })
    ).body;
    expect((await browser.fetch(avatarUrl)).status).toBe(200);
    expect((await call(browser, "GET", `${ws(id)}/members`)).body.members[0]?.avatarUrl).toBe(avatarUrl);
    const outsider = await signedIn(server, "Outside", "outside@space.test");
    expect((await outsider.browser.fetch(avatarUrl)).status).toBe(404);
    await call(browser, "DELETE", `${ws(id)}/me/avatar`);
    expect((await call(browser, "GET", `${ws(id)}/members`)).body.members[0]?.avatarUrl).toBeNull();
  });

  test("updateMe changes name, handle and time zone; a repeated handle gives handle.taken", async () => {
    const { browser, user } = await signedIn(server, "Gabi", "gabi@space.test");
    const { workspace } = await create(browser, { name: "Profiles" });
    const person = (
      await call(browser, "PATCH", `${ws(workspace.id)}/me`, {
        name: "Gabriela",
        handle: "gabs",
        timezone: "America/Recife",
      })
    ).body;
    expect(person).toMatchObject({
      userId: user.id,
      name: "Gabriela",
      handle: "gabs",
      timezone: "America/Recife",
    });
    expect(person.online).toBe(true);
    const people = (await call(browser, "GET", `${ws(workspace.id)}/people`)).body.people;
    expect(people.map((p: { handle: string }) => p.handle)).toEqual(["gabs"]);
    const link = (await call(browser, "POST", `${ws(workspace.id)}/invite-links`)).body;
    const hugo = await signedIn(server, "Hugo", "hugo@space.test");
    await accept(hugo.browser, tokenOf(link.url));
    const err = await call(hugo.browser, "PATCH", `${ws(workspace.id)}/me`, { handle: "gabs" });
    expect([err.status, err.body.error.code]).toEqual([409, "handle.taken"]);
    expect((await call(hugo.browser, "PATCH", `${ws(workspace.id)}/me`, { handle: "A B" })).status).toBe(400);
  });
});

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
    expect((await call(lia.browser, "GET", `${ws(id)}/people`)).body.people.length).toBe(3);
    expect((await call(lia.browser, "GET", `${ws(id)}/overview`)).body.people).toBe(3);
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

describe("asking for a new invitation", () => {
  test("once an hour: one millisecond before the hour is quiet, the exact hour and later tell whoever invited", async () => {
    const o = await owner(server, "Hal", "hal@ws.test", "Hourly");
    const start = new Date(Math.floor(Date.now() / 1000) * 1000);
    frozen = start;
    try {
      const { url } = await invite(o.browser, o.workspaceId, "hourly@ws.test", "member");
      const asks = () =>
        server.mailer.sent().filter((m) => m.kind === "invite_request" && m.to === "hal@ws.test");
      const ask = async (at: number) => {
        frozen = new Date(at);
        return (
          await call(new Browser(server.url), "POST", `/api/v1/invitations/${tokenOf(url)}/request-new`)
        ).status;
      };
      // The invitation expired 8 days in; the first request tells the inviter.
      const t0 = start.getTime() + 8 * 24 * 3600_000;
      expect(await ask(t0)).toBe(204);
      expect(asks().length).toBe(1);
      expect(await ask(t0 + 3600_000 - 1)).toBe(204);
      expect(asks().length).toBe(1);
      expect(await ask(t0 + 3600_000)).toBe(204);
      expect(asks().length).toBe(2);
      // The window now counts from the exact hour: one millisecond later is still inside it.
      expect(await ask(t0 + 3600_000 + 1)).toBe(204);
      expect(asks().length).toBe(2);
    } finally {
      frozen = null;
    }
  });
});

describe("roles", () => {
  test("a member doesn't manage; an admin doesn't touch an owner; nobody changes their own role; an owner always stays", async () => {
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
    const role = (b: Browser, userId: string, to: string) =>
      call(b, "PATCH", `${ws(id)}/members/${userId}`, { role: to });
    const remove = (b: Browser, userId: string) => call(b, "DELETE", `${ws(id)}/members/${userId}`);

    const byMember = await call(member.browser, "POST", `${ws(id)}/invitations`, {
      email: "x@ws.test",
      role: "member",
    });
    expect(byMember.status).toBe(403);
    expect((await call(member.browser, "PATCH", `${ws(id)}/settings`, { name: "X" })).status).toBe(403);
    expect((await call(member.browser, "GET", `${ws(id)}/usage/report`)).status).toBe(403);
    expect((await role(member.browser, admin.user.id, "member")).status).toBe(403);

    const byAdmin = await call(admin.browser, "POST", `${ws(id)}/invitations`, {
      email: "y@ws.test",
      role: "owner",
    });
    expect(byAdmin.status).toBe(403);
    expect((await role(admin.browser, member.user.id, "owner")).status).toBe(403);
    expect((await role(admin.browser, sol.user.id, "member")).status).toBe(403);
    expect((await role(admin.browser, admin.user.id, "member")).status).toBe(403);
    expect((await role(admin.browser, member.user.id, "admin")).status).toBe(204);

    const last = await remove(sol.browser, sol.user.id);
    expect([last.status, last.body.error.code]).toEqual([409, "last_owner"]);
    expect((await role(sol.browser, admin.user.id, "owner")).status).toBe(204);
    expect((await remove(sol.browser, member.user.id)).status).toBe(204);
    expect((await call(member.browser, "GET", ws(id))).status).toBe(404);
    expect((await remove(sol.browser, sol.user.id)).status).toBe(204);
    expect((await call(sol.browser, "GET", "/api/v1/me")).body).toMatchObject({ workspaces: [] });
    const roles = (await call(admin.browser, "GET", `${ws(id)}/members`)).body.members;
    expect(roles.map((m: { role: string }) => m.role)).toEqual(["owner"]);
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
    const revoke = await call(adm.browser, "DELETE", `${ws(id)}/invitations/${ownerInvite.invitation.id}`);
    expect(revoke.status).toBe(403);
    const replace = await call(adm.browser, "POST", `${ws(id)}/invitations`, {
      email: "other-owner@ws.test",
      role: "member",
    });
    expect(replace.status).toBe(403);
    // The owner's invitation was left as it was.
    expect((await preview(new Browser(server.url), tokenOf(ownerInvite.url))).body).toMatchObject({
      role: "owner",
    });
    const renewed = await invite(olga.browser, id, "other-owner@ws.test", "member");
    expect((await preview(new Browser(server.url), tokenOf(ownerInvite.url))).status).toBe(404);
    expect((await preview(new Browser(server.url), tokenOf(renewed.url))).body.role).toBe("member");
    const revocable = await invite(olga.browser, id, "revoke-owner@ws.test", "owner");
    expect(
      (await call(olga.browser, "DELETE", `${ws(id)}/invitations/${revocable.invitation.id}`)).status,
    ).toBe(204);

    // Bulk skips a live invitation, but must also protect an expired owner invitation it would replace.
    const expired = await invite(olga.browser, id, "expired-owner@ws.test", "owner");
    await server.deps.db
      .update(schema.invitations)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.invitations.id, expired.invitation.id));
    const bulk = (b: Browser) =>
      call(b, "POST", `${ws(id)}/invitations/bulk`, { emails: ["expired-owner@ws.test"], role: "member" });
    expect((await bulk(adm.browser)).status).toBe(403);
    const [unchanged] = await server.deps.db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.id, expired.invitation.id));
    expect(unchanged?.status).toBe("pending");
    expect((await bulk(olga.browser)).body.results[0].status).toBe("invited");
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

// Rules of the workspace routes the origin didn't test, one test each.
describe("workspace route rules", () => {
  /** Every route under the workspace, with a body that would pass its schema. */
  const ROUTES = (id: string, userId: string): [string, string, unknown?][] => [
    ["GET", ws(id)],
    ["PATCH", ws(id), { name: "Renamed" }],
    ["GET", `${ws(id)}/settings`],
    ["PATCH", `${ws(id)}/settings`, { name: "Renamed" }],
    ["GET", `${ws(id)}/overview`],
    ["GET", `${ws(id)}/members`],
    ["GET", `${ws(id)}/people`],
    ["PATCH", `${ws(id)}/members/${userId}`, { role: "admin" }],
    ["DELETE", `${ws(id)}/members/${userId}`],
    ["PATCH", `${ws(id)}/me`, { name: "Someone" }],
    ["PUT", `${ws(id)}/me/avatar`, { imageBase64: PNG, contentType: "image/png" }],
    ["DELETE", `${ws(id)}/me/avatar`],
    ["GET", `${ws(id)}/people/${userId}/avatar`],
    ["PUT", `${ws(id)}/logo`, { imageBase64: PNG, contentType: "image/png" }],
    ["DELETE", `${ws(id)}/logo`],
    ["GET", `${ws(id)}/logo`],
    ["GET", `${ws(id)}/usage/report`],
  ];

  test("every workspace route: 401 without a session and 404 outside, with nothing changed", async () => {
    const vera = await signedIn(server, "Vera", "vera@space.test");
    const { workspace } = await create(vera.browser, { name: "Guarded" });
    const outsider = await signedIn(server, "Wil", "wil@space.test");
    const anon = new Browser(server.url);
    for (const [method, path, payload] of ROUTES(workspace.id, vera.user.id)) {
      expect([method, path, (await call(anon, method, path, payload)).status]).toEqual([method, path, 401]);
      const res = await call(outsider.browser, method, path, payload);
      expect([method, path, res.status, res.body?.error?.code]).toEqual([method, path, 404, "not_found"]);
    }
    expect((await call(vera.browser, "GET", ws(workspace.id))).body).toMatchObject({ name: "Guarded" });
    const members = (await call(vera.browser, "GET", `${ws(workspace.id)}/members`)).body.members;
    expect(members.map((m: { userId: string; role: string }) => [m.userId, m.role])).toEqual([
      [vera.user.id, "owner"],
    ]);
  });

  test("a member reads the workspace but can't rename it, change its settings or logo, or read usage", async () => {
    const xavi = await owner(server, "Xavi", "xavi@space.test", "Members only");
    const id = xavi.workspaceId;
    const { url } = await invite(xavi.browser, id, "yara@space.test", "member");
    const yara = await signedIn(server, "Yara", "yara@space.test");
    await accept(yara.browser, tokenOf(url));
    for (const [method, path, payload] of [
      ["PATCH", ws(id), { name: "Taken over" }],
      ["PATCH", `${ws(id)}/settings`, { approvalReviewer: true }],
      ["PUT", `${ws(id)}/logo`, { imageBase64: PNG, contentType: "image/png" }],
      ["DELETE", `${ws(id)}/logo`],
      ["GET", `${ws(id)}/usage/report`],
      ["PATCH", `${ws(id)}/members/${xavi.user.id}`, { role: "member" }],
      ["DELETE", `${ws(id)}/members/${xavi.user.id}`],
    ] as [string, string, unknown?][]) {
      expect([method, path, (await call(yara.browser, method, path, payload)).status]).toEqual([
        method,
        path,
        403,
      ]);
    }
    for (const path of [ws(id), `${ws(id)}/settings`, `${ws(id)}/overview`, `${ws(id)}/people`]) {
      expect([path, (await call(yara.browser, "GET", path)).status]).toEqual([path, 200]);
    }
    expect((await call(xavi.browser, "GET", `${ws(id)}/settings`)).body).toMatchObject({
      name: "Members only",
      approvalReviewer: false,
    });
    // Anyone can leave on their own.
    expect((await call(yara.browser, "DELETE", `${ws(id)}/members/${yara.user.id}`)).status).toBe(204);
    expect((await call(yara.browser, "GET", ws(id))).status).toBe(404);
  });

  test("ids from another workspace don't reach into this one: member, avatar and credential", async () => {
    const zoe = await signedIn(server, "Zoe", "zoe@space.test");
    const mine = (await create(zoe.browser, { name: "Mine" })).workspace.id;
    const abel = await signedIn(server, "Abel", "abel@space.test");
    const theirs = (await create(abel.browser, { name: "Theirs" })).workspace.id;
    await call(abel.browser, "PUT", `${ws(theirs)}/me/avatar`, {
      imageBase64: PNG,
      contentType: "image/png",
    });

    // Abel is no member of Mine: as Zoe, his id is unknown there.
    expect(
      (await call(zoe.browser, "PATCH", `${ws(mine)}/members/${abel.user.id}`, { role: "admin" })).status,
    ).toBe(404);
    expect((await call(zoe.browser, "DELETE", `${ws(mine)}/members/${abel.user.id}`)).status).toBe(404);
    expect((await zoe.browser.fetch(`${ws(mine)}/people/${abel.user.id}/avatar`)).status).toBe(404);
    expect((await abel.browser.fetch(`${ws(theirs)}/people/${abel.user.id}/avatar`)).status).toBe(200);

    const credentialId = newId("cred");
    await server.deps.db.insert(schema.credentials).values({
      id: credentialId,
      workspaceId: theirs,
      label: "Theirs",
      provider: "anthropic",
      secret: "sealed",
      keyPreview: "sk-…abcd",
    });
    const borrowed = await call(zoe.browser, "PATCH", `${ws(mine)}/settings`, {
      primaryCredentialId: credentialId,
    });
    expect(borrowed.status).toBe(400);
    expect((await call(zoe.browser, "GET", `${ws(mine)}/settings`)).body.primaryCredentialId).toBeNull();
    const own = await call(abel.browser, "PATCH", `${ws(theirs)}/settings`, {
      primaryCredentialId: credentialId,
    });
    expect(own.body.primaryCredentialId).toBe(credentialId);
  });

  test("overview and usage count only this workspace's active agents and their spend this month", async () => {
    frozen = new Date("2026-11-20T12:00:00Z");
    try {
      const bento = await signedIn(server, "Bento", "bento@space.test");
      const id = (await create(bento.browser, { name: "Spend" })).workspace.id;
      const other = (await create(bento.browser, { name: "Elsewhere" })).workspace.id;
      const agent = async (workspaceId: string, name: string, budgetPerMonthUsd: number | null) => {
        const agentId = newId("agent");
        await server.deps.db.insert(schema.agents).values({
          id: agentId,
          workspaceId,
          name,
          handle: name.toLowerCase(),
          model: "claude-haiku-5-5",
          ownerUserId: bento.user.id,
          instructions: "",
          appearance: { color: "blue", eyes: "dot", adornment: "none" },
          budgetPerMonthUsd,
        });
        return agentId;
      };
      const run = (workspaceId: string, agentId: string, costUsd: number, createdAt: Date) =>
        server.deps.db
          .insert(schema.runs)
          .values({ id: newId("run"), workspaceId, agentId, model: "claude-haiku-5-5", costUsd, createdAt });
      const cleo = await agent(id, "Cleo", 10);
      const dino = await agent(id, "Dino", null);
      const gone = await agent(id, "Gone", 10);
      await server.deps.db
        .update(schema.agents)
        .set({ archivedAt: frozen })
        .where(eq(schema.agents.id, gone));
      const far = await agent(other, "Far", 10);
      await run(id, cleo, 3, new Date("2026-11-05T00:00:00Z"));
      await run(id, dino, 2, new Date("2026-11-19T00:00:00Z"));
      await run(id, cleo, 100, new Date("2026-10-31T23:59:59Z"));
      await run(other, far, 50, new Date("2026-11-10T00:00:00Z"));

      // Budget 10 + 20 (the default) = 30; spent this month 3 + 2 = 5.
      expect((await call(bento.browser, "GET", `${ws(id)}/overview`)).body).toEqual({
        myApprovalQueue: 0,
        budgetSpentPct: 16.7,
        people: 1,
        agents: 2,
      });
      const report = (await call(bento.browser, "GET", `${ws(id)}/usage/report`)).body;
      expect(report).toEqual({
        spendUsd: 5,
        since: "2026-11-01T00:00:00.000Z",
        perKind: [{ kind: "model", calls: 2, costUsd: 5 }],
        agents: [
          {
            agentId: cleo,
            name: "Cleo",
            costUsd: 3,
            budgetPerMonthUsd: 10,
            budgetInherited: false,
            budgetSpentPct: 30,
          },
          {
            agentId: dino,
            name: "Dino",
            costUsd: 2,
            budgetPerMonthUsd: 20,
            budgetInherited: true,
            budgetSpentPct: 10,
          },
        ],
      });
      expect((await call(bento.browser, "GET", `${ws(id)}/usage/report?since=yesterday`)).status).toBe(400);
    } finally {
      frozen = null;
    }
  });

  test("an empty update changes nothing: rename answers 204 and settings the current settings", async () => {
    const dora = await signedIn(server, "Dora", "dora@space.test");
    const id = (await create(dora.browser, { name: "Steady", context: "Calm" })).workspace.id;
    const before = (await call(dora.browser, "GET", `${ws(id)}/settings`)).body;
    expect((await call(dora.browser, "PATCH", ws(id), {})).status).toBe(204);
    const settings = await call(dora.browser, "PATCH", `${ws(id)}/settings`, {});
    expect([settings.status, settings.body]).toEqual([200, before]);
    expect((await call(dora.browser, "GET", ws(id))).body).toMatchObject({ name: "Steady", context: "Calm" });
  });

  test("updateMe is all or nothing: a taken handle leaves the name and the time zone as they were", async () => {
    const eli = await signedIn(server, "Eli", "eli@space.test");
    const id = (await create(eli.browser, { name: "Handles" })).workspace.id;
    const link = (await call(eli.browser, "POST", `${ws(id)}/invite-links`)).body;
    const fred = await signedIn(server, "Fred", "fred@space.test");
    await accept(fred.browser, tokenOf(link.url));
    const taken = await call(fred.browser, "PATCH", `${ws(id)}/me`, {
      name: "Frederick",
      handle: "eli",
      timezone: "Europe/Lisbon",
    });
    expect([taken.status, taken.body.error.code]).toEqual([409, "handle.taken"]);
    const people = (await call(fred.browser, "GET", `${ws(id)}/people`)).body.people;
    expect(people.find((p: { userId: string }) => p.userId === fred.user.id)).toMatchObject({
      name: "Fred",
      handle: "fred",
      timezone: null,
    });
  });

  test("creating a workspace validates the body before any write", async () => {
    const cris = await signedIn(server, "Cris", "cris@space.test");
    for (const payload of [
      {},
      { name: "" },
      { name: "x".repeat(81) },
      { name: "Ok", timezone: "Mars/Base" },
    ]) {
      expect((await call(cris.browser, "POST", "/api/v1/workspaces", payload)).status).toBe(400);
    }
    expect((await call(new Browser(server.url), "POST", "/api/v1/workspaces", { name: "Anon" })).status).toBe(
      401,
    );
    expect((await call(cris.browser, "GET", "/api/v1/me")).body.workspaces).toEqual([]);
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
