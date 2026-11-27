// The agent routes (routes/agents.ts): the registry (create, the @ shared with people, edit, who may change what,
// archive), the agent's channels, its harness and the models, the sealed credentials, importing instructions from
// GitHub, the advisor pair, the appearance checked against the contract's lists, and the access boundary: a member
// of another workspace finds no agent by id, and a run of a channel the person doesn't read stays hidden.
// The run scenarios of the origin's file (a mention runs the agent, stop, budget...) wait for the runtime (P16) and
// the chat routes; see the ledger.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, AgentAppearance, AgentChannel, AgentDetail, Member } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { createProviderLookup, testModelCheck } from "../src/models";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, ws } from "./route-calls";
import { memberOf, type Person, seedChannel } from "./seed";

// A fake GitHub: only the URLs the tests use answer.
const GITHUB: Record<string, string> = {
  "https://raw.githubusercontent.com/acme/agents/HEAD/AGENTS.md": "# Rules\nAnswer briefly.",
};
let githubCalls = 0;
const fakeGithub: typeof fetch = Object.assign(
  async (input: string | URL | Request) => {
    githubCalls++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const text = GITHUB[url];
    return text === undefined ? new Response("nope", { status: 404 }) : new Response(text);
  },
  { preconnect: () => {} },
);

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ fetchExternal: fakeGithub });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@agents.test`;

/** The body of a call that must succeed with `status`. */
async function ok<T>(pending: ReturnType<typeof call>, status = 200): Promise<T> {
  const res = await pending;
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A workspace with Ana (owner), Beto (member) and the agent Lia in #general. */
async function team(opts: { budget?: number } = {}) {
  const ana = await signedIn(server, "Ana", email("ana"));
  const created = await ok<{ workspace: { id: string }; defaultChannelId: string }>(
    call(ana, "POST", "/api/v1/workspaces", { name: "Workshop" }),
    201,
  );
  const workspaceId = created.workspace.id;
  const general = created.defaultChannelId;
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await ok<Agent>(
    call(ana, "POST", `${ws(workspaceId)}/agents`, {
      name: "Lia",
      handle: "lia",
      role: "support",
      instructions: "Serves the workshop's customers. Answers briefly.",
      channelIds: [general],
      ...(opts.budget !== undefined ? { budgetPerMonthUsd: opts.budget } : {}),
    }),
    201,
  );
  return { workspaceId, general, ana, beto, lia };
}

const agentPath = (workspaceId: string, agentId: string) => `${ws(workspaceId)}/agents/${agentId}`;

describe("agent registry", () => {
  test(
    "create, @ taken, edit, permissions and archive",
    async () => {
      const { workspaceId, general, ana, beto, lia } = await team();
      expect(lia).toMatchObject({
        handle: "lia",
        role: "support",
        model: "claude-haiku-5-5",
        ownerUserId: ana.user.id,
        audience: { mode: "everyone", userIds: [] },
        reachable: true,
        busy: false,
        archivedAt: null,
      });
      // The @ is one space for people and agents.
      const { members } = await ok<{ members: Member[] }>(call(ana, "GET", `${ws(workspaceId)}/members`));
      const anaHandle = members.find((m) => m.userId === ana.user.id)?.handle ?? "";
      const create = (who: Person, body: Record<string, unknown>) =>
        call(who, "POST", `${ws(workspaceId)}/agents`, body);
      const taken = await create(ana, { name: "X", handle: anaHandle, role: "custom" });
      expect([taken.status, taken.body.error.code]).toEqual([409, "agent.handle_taken"]);
      expect((await create(ana, { name: "Y", handle: "lia", role: "custom" })).status).toBe(409);
      expect((await create(ana, { name: "Z", handle: "a", role: "custom" })).status).toBe(400);
      expect((await create(ana, { name: "Z", handle: "zeca", role: "custom", model: "gpt-9" })).status).toBe(
        400,
      );
      expect((await create(beto, { name: "B", handle: "bia", role: "custom" })).status).toBe(403);

      const list = await ok<{ agents: Agent[] }>(call(beto, "GET", `${ws(workspaceId)}/agents`));
      expect(list.agents.map((a) => a.handle)).toEqual(["lia"]);
      const detail = await ok<AgentDetail>(call(beto, "GET", agentPath(workspaceId, lia.id)));
      expect(detail).toMatchObject({
        budgetPerMonthUsd: 20,
        inheritedBudgetUsd: 20,
        budgetInherited: true,
        channels: [{ id: general, autoAnswer: false }],
        monthRuns: 0,
        costThisMonthUsd: 0,
      });

      const update = (who: Person, body: Record<string, unknown>) =>
        call(who, "PATCH", agentPath(workspaceId, lia.id), body);
      expect((await update(beto, { name: "Lia 2" })).status).toBe(403);
      const edited = await ok<Agent>(
        update(ana, {
          name: "Lia Souza",
          audience: { mode: "people", userIds: [beto.user.id] },
          budgetPerMonthUsd: 5,
          appearance: { color: "amber", eyes: "wide", adornment: "cap" },
        }),
      );
      expect(edited).toMatchObject({
        name: "Lia Souza",
        audience: { mode: "people", userIds: [beto.user.id] },
      });
      expect((await ok<AgentDetail>(call(ana, "GET", agentPath(workspaceId, lia.id)))).budgetInherited).toBe(
        false,
      );
      // Beto is in the audience; the conversation open to him shows in his `reachable`.
      expect(
        (await ok<{ agents: Agent[] }>(call(beto, "GET", `${ws(workspaceId)}/agents`))).agents[0]?.reachable,
      ).toBe(true);

      // An owner without the admin role: appearance and audience yes; name, model and budget no.
      await ok(update(ana, { ownerUserId: beto.user.id }));
      const look = { color: "teal", eyes: "sleepy", adornment: "none" };
      expect(
        await ok<Agent>(update(beto, { appearance: look, audience: { mode: "owner", userIds: [] } })),
      ).toMatchObject({ appearance: look, audience: { mode: "owner" } });
      for (const patch of [{ name: "Lia 3" }, { budgetPerMonthUsd: 50 }, { instructions: "x" }]) {
        expect((await update(beto, patch)).status).toBe(403);
      }
      await ok(update(ana, { ownerUserId: ana.user.id, audience: { mode: "everyone", userIds: [] } }));

      expect((await call(beto, "DELETE", agentPath(workspaceId, lia.id))).status).toBe(403);
      expect((await call(ana, "DELETE", agentPath(workspaceId, lia.id))).status).toBe(204);
      expect((await ok<{ agents: Agent[] }>(call(ana, "GET", `${ws(workspaceId)}/agents`))).agents).toEqual(
        [],
      );
      expect(
        (await ok<AgentDetail>(call(ana, "GET", agentPath(workspaceId, lia.id)))).archivedAt,
      ).not.toBeNull();
      // An archived agent's @ stays reserved.
      expect((await create(ana, { name: "L", handle: "lia", role: "custom" })).status).toBe(409);
    },
    SERVER_TEST_MS,
  );

  test(
    "the agent's channels and autoAnswer",
    async () => {
      const { workspaceId, general, ana, lia } = await team();
      const sales = await seedChannel(server, workspaceId, { name: "sales", members: [ana] });
      const set = await ok<{ channels: { id: string; autoAnswer: boolean }[] }>(
        call(ana, "PUT", `${agentPath(workspaceId, lia.id)}/channels`, {
          channels: [
            { channelId: sales, autoAnswer: true },
            { channelId: general, autoAnswer: false },
          ],
        }),
      );
      expect(set.channels).toEqual(
        expect.arrayContaining([
          { id: sales, autoAnswer: true },
          { id: general, autoAnswer: false },
        ]),
      );
      const listed = await ok<{ channels: unknown[] }>(
        call(ana, "GET", `${agentPath(workspaceId, lia.id)}/channels`),
      );
      expect(listed.channels).toHaveLength(2);
      // The list is replaced whole: a channel left out leaves.
      const only = await ok<{ channels: AgentChannel[] }>(
        call(ana, "PUT", `${agentPath(workspaceId, lia.id)}/channels`, {
          channels: [{ channelId: general, autoAnswer: true }],
        }),
      );
      expect(only.channels).toEqual([{ id: general, autoAnswer: true }]);
      const bad = await call(ana, "PUT", `${agentPath(workspaceId, lia.id)}/channels`, {
        channels: [{ channelId: "ch_nope", autoAnswer: true }],
      });
      expect(bad.status).toBe(400);
    },
    SERVER_TEST_MS,
  );

  test(
    "harness, models and the platform key",
    async () => {
      const { workspaceId, ana, lia } = await team();
      const { models, defaultModel } = await ok<{ models: { id: string }[]; defaultModel: string }>(
        call(ana, "GET", "/api/v1/models"),
      );
      expect(defaultModel).toBe("claude-haiku-5-5");
      expect(models.map((m) => m.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
      expect(models.find((m) => m.id === "claude-opus-5-5")).toMatchObject({
        inputPricePerMillion: 4,
        outputPricePerMillion: 20,
      });
      expect(
        (await ok<{ available: boolean }>(call(ana, "GET", `${ws(workspaceId)}/credentials/platform`)))
          .available,
      ).toBe(false);
      const harness = await ok<{
        harness: string;
        resolvedModel: string;
        environment: null;
        options: unknown[];
      }>(call(ana, "GET", `${agentPath(workspaceId, lia.id)}/runtime`));
      expect(harness).toMatchObject({
        harness: "model",
        resolvedModel: "claude-haiku-5-5",
        environment: null,
      });
      expect(harness.options.find((o) => (o as { kind: string }).kind === "claude_code")).toMatchObject({
        available: false,
        reason: "no_environment",
      });
      const set = await ok<{ resolvedModel: string }>(
        call(ana, "PUT", `${agentPath(workspaceId, lia.id)}/runtime`, {
          harness: "model",
          model: "claude-sonnet-5-5",
        }),
      );
      expect(set.resolvedModel).toBe("claude-sonnet-5-5");
      const local = await call(ana, "PUT", `${agentPath(workspaceId, lia.id)}/runtime`, {
        harness: "claude_code",
      });
      expect([local.status, local.body.error.code]).toEqual([409, "harness.unavailable"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "sealed credentials: add, rotate, revoke, delete",
    async () => {
      const { workspaceId, ana, beto, lia } = await team();
      const creds = `${ws(workspaceId)}/credentials`;
      expect((await call(beto, "GET", creds)).status).toBe(403);
      const cred = await ok<{ id: string; keyPreview: string }>(
        call(ana, "POST", creds, {
          label: "Workshop account",
          provider: "anthropic",
          apiKey: "sk-ant-api03-test-secret-1234",
        }),
        201,
      );
      expect(cred).toMatchObject({ provider: "anthropic", keyPreview: "sk-ant-…1234", revokedAt: null });
      expect(JSON.stringify((await call(ana, "GET", creds)).body)).not.toContain("secret");
      const [row] = await server.deps.db
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.id, cred.id));
      expect(row?.secret).not.toContain("secret");
      expect(server.deps.sealer.open(row?.secret ?? "")).toBe("sk-ant-api03-test-secret-1234");

      await ok(call(ana, "PATCH", agentPath(workspaceId, lia.id), { credentialId: cred.id }));
      expect((await ok<AgentDetail>(call(ana, "GET", agentPath(workspaceId, lia.id)))).credentialId).toBe(
        cred.id,
      );
      // With the key the agent uses Anthropic; with MODEL_PROVIDER=fake (dev and E2E) it never goes out.
      const [liaRow] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, lia.id));
      if (!liaRow) throw new Error("agent row missing");
      const env = { DATA_DIR: "memory", PORT: "0", WEB_DIST: "/nonexistent" };
      const lookup = (extra: Record<string, string>) =>
        createProviderLookup({ ...server.deps, config: loadConfig({ ...env, ...extra }) }, {});
      expect(await lookup({})(liaRow)).toMatchObject({ kind: "anthropic" });
      expect(await lookup({ MODEL_PROVIDER: "fake" })(liaRow)).toMatchObject({ kind: "fake" });
      // The screen says "test model" by the same rule.
      const answersWithTest = async (extra: Record<string, string>, agent = liaRow, forceFake = false) =>
        (
          await testModelCheck(
            { ...server.deps, config: loadConfig({ ...env, ...extra }) },
            workspaceId,
            forceFake,
          )
        )(agent);
      expect(await answersWithTest({})).toBe(false);
      expect(await answersWithTest({}, { ...liaRow, credentialId: null })).toBe(true);
      expect(await answersWithTest({ MODEL_PROVIDER: "fake" })).toBe(true);
      expect(await answersWithTest({}, liaRow, true)).toBe(true);
      expect(
        await answersWithTest(
          { ANTHROPIC_API_KEY: "sk-ant-platform-1234" },
          { ...liaRow, credentialId: null },
        ),
      ).toBe(false);
      // Whoever thinks on the environment doesn't go through the provider.
      expect(await answersWithTest({}, { ...liaRow, credentialId: null, harnessKind: "claude_code" })).toBe(
        false,
      );
      // The test server forces the fake provider: the API says so.
      expect((await ok<AgentDetail>(call(ana, "GET", agentPath(workspaceId, lia.id)))).testModel).toBe(true);
      // The workspace's primary key only takes a credential of its own, still valid.
      const settings = `${ws(workspaceId)}/settings`;
      expect((await call(ana, "PATCH", settings, { primaryCredentialId: "nope" })).status).toBe(400);
      await ok(call(ana, "PATCH", settings, { primaryCredentialId: cred.id }));
      expect(await answersWithTest({}, { ...liaRow, credentialId: null })).toBe(false);
      const rotated = await ok<{ keyPreview: string }>(
        call(ana, "POST", `${creds}/${cred.id}/rotate`, { apiKey: "sk-ant-api03-new-9876" }),
      );
      expect(rotated.keyPreview).toBe("sk-ant-…9876");

      expect((await call(ana, "DELETE", `${creds}/${cred.id}`)).status).toBe(204);
      expect(
        (await ok<{ credentials: { revokedAt: string | null }[] }>(call(ana, "GET", creds))).credentials[0]
          ?.revokedAt,
      ).not.toBeNull();
      // Whoever used the credential goes back to the primary one, and the workspace is left without one.
      expect(
        (await ok<AgentDetail>(call(ana, "GET", agentPath(workspaceId, lia.id)))).credentialId,
      ).toBeNull();
      expect(
        (await ok<{ primaryCredentialId: string | null }>(call(ana, "GET", settings))).primaryCredentialId,
      ).toBeNull();
      expect(await answersWithTest({})).toBe(true);
      expect(
        (await call(ana, "PATCH", agentPath(workspaceId, lia.id), { credentialId: cred.id })).status,
      ).toBe(400);
      expect((await call(ana, "DELETE", `${creds}/${cred.id}?purge=true`)).status).toBe(204);
      expect((await ok<{ credentials: unknown[] }>(call(ana, "GET", creds))).credentials).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "import instructions from GitHub (github.com only)",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const path = `${ws(workspaceId)}/agent-imports/github`;
      const { files } = await ok<{ files: unknown[] }>(
        call(ana, "POST", path, { url: "https://github.com/acme/agents" }),
      );
      expect(files).toEqual([{ path: "AGENTS.md", text: "# Rules\nAnswer briefly." }]);
      const before = githubCalls;
      const ssrf = await call(ana, "POST", path, { url: "http://169.254.169.254/latest" });
      expect(ssrf.status).toBe(400);
      expect((await call(beto, "POST", path, { url: "https://github.com/acme/agents" })).status).toBe(403);
      expect(githubCalls).toBe(before);
    },
    SERVER_TEST_MS,
  );
});

describe("advisor", () => {
  test(
    "an invalid pair is rejected; switching to Opus turns the advisor off",
    async () => {
      const { workspaceId, ana, lia } = await team();
      const update = (body: Record<string, unknown>) =>
        call(ana, "PATCH", agentPath(workspaceId, lia.id), body);
      const err = await update({
        model: "claude-opus-5-5",
        advisor: { model: "claude-opus-5-5", maxUses: 1 },
      });
      expect(err.status).toBe(400);
      expect(err.body.error.params?.field).toBe("advisor");
      const sonnetAdvisingHaiku = await update({
        model: "claude-sonnet-5-5",
        advisor: { model: "claude-haiku-5-5", maxUses: 1 },
      });
      expect(sonnetAdvisingHaiku.status).toBe(400);
      expect((await update({ advisor: { model: "claude-opus-5-5", maxUses: 9 } })).status).toBe(400);

      await ok(update({ advisor: { model: "claude-opus-5-5", maxUses: 3 } }));
      const opus = await ok<Agent>(update({ model: "claude-opus-5-5" }));
      expect(opus.advisor).toBeNull();
      // In Vanr's catalog only Haiku takes an advisor (Opus): Sonnet with Opus is rejected too, and Haiku with
      // Opus holds again.
      expect(
        (await update({ model: "claude-sonnet-5-5", advisor: { model: "claude-opus-5-5", maxUses: 1 } }))
          .status,
      ).toBe(400);
      const haiku = await ok<Agent>(
        update({ model: "claude-haiku-5-5", advisor: { model: "claude-opus-5-5", maxUses: 1 } }),
      );
      expect(haiku.advisor).toEqual({ model: "claude-opus-5-5", maxUses: 1 });
    },
    SERVER_TEST_MS,
  );
});

describe("appearance", () => {
  test(
    "body, mouth and extra take only the contract's lists on create and edit; nothing is saved on a 400",
    async () => {
      const { workspaceId, ana, lia } = await team();
      const base = { color: "teal", eyes: "dots", adornment: "none" };
      const create = (appearance: unknown, handle: string) =>
        call(ana, "POST", `${ws(workspaceId)}/agents`, { name: "Rui", handle, role: "custom", appearance });
      for (const [i, bad] of [
        { ...base, body: "triangle" },
        { ...base, mouth: "fangs" },
        { ...base, extra: "crown" },
        { ...base, body: null },
        { ...base, accessory: "cap" },
      ].entries()) {
        const res = await create(bad, `rui${i}`);
        expect([res.status, res.body.error.code]).toEqual([400, "invalid_request"]);
      }
      // None of the rejected ones was created.
      expect(
        (await ok<{ agents: Agent[] }>(call(ana, "GET", `${ws(workspaceId)}/agents`))).agents,
      ).toHaveLength(1);
      const full: AgentAppearance = { ...base, body: "cloud", mouth: "grin", extra: "scarf" };
      expect((await ok<Agent>(create(full, "rui"), 201)).appearance).toEqual(full);

      const patch = (appearance: unknown) =>
        call(ana, "PATCH", agentPath(workspaceId, lia.id), { appearance });
      expect((await patch({ ...base, mouth: "fangs" })).status).toBe(400);
      expect((await ok<Agent>(call(ana, "GET", agentPath(workspaceId, lia.id)))).appearance).toEqual(base);
      expect((await ok<Agent>(patch({ ...base, body: "box" }))).appearance).toEqual({ ...base, body: "box" });
    },
    SERVER_TEST_MS,
  );

  test(
    "a stored value outside the lists (or null) is left out on read, in the list, the detail and the team",
    async () => {
      const { workspaceId, ana, lia } = await team();
      await server.deps.db
        .update(schema.agents)
        .set({
          appearance: JSON.parse(
            '{"color":"teal","eyes":"dots","adornment":"none","body":"triangle","mouth":null,"extra":"tie"}',
          ),
        })
        .where(eq(schema.agents.id, lia.id));
      const want: AgentAppearance = { color: "teal", eyes: "dots", adornment: "none", extra: "tie" };
      const list = await ok<{ agents: Agent[] }>(call(ana, "GET", `${ws(workspaceId)}/agents`));
      expect(list.agents[0]?.appearance).toEqual(want);
      expect((await ok<Agent>(call(ana, "GET", agentPath(workspaceId, lia.id)))).appearance).toEqual(want);
      const teamView = await ok<{ agents: { appearance: unknown }[] }>(
        call(ana, "GET", `${ws(workspaceId)}/team`),
      );
      expect(teamView.agents[0]?.appearance).toEqual(want);
    },
    SERVER_TEST_MS,
  );
});

describe("access", () => {
  test(
    "a member of another workspace gets 404 on every route of the agent, and their own id doesn't reach it",
    async () => {
      const { workspaceId, ana, lia } = await team();
      const eva = await signedIn(server, "Eva", email("eva"));
      const theirs = await ok<{ workspace: { id: string } }>(
        call(eva, "POST", "/api/v1/workspaces", { name: "Elsewhere" }),
        201,
      );
      const here = agentPath(workspaceId, lia.id);
      const probes: [string, string, unknown?][] = [
        ["GET", here],
        ["PATCH", here, { name: "Eva's" }],
        ["DELETE", here],
        ["GET", `${here}/channels`],
        ["PUT", `${here}/channels`, { channels: [] }],
        ["GET", `${here}/runtime`],
        ["PUT", `${here}/runtime`, { harness: "model" }],
        ["GET", `${here}/instruction-versions`],
        ["GET", `${here}/inbox`],
        ["GET", `${here}/skills`],
        ["PUT", `${here}/skills`, { skills: [] }],
        ["GET", `${here}/test-cases`],
        ["POST", `${here}/test-cases`, { input: "hi" }],
        ["GET", `${here}/evals`],
        ["GET", `${here}/memory-consolidations`],
        ["GET", `${ws(workspaceId)}/agents`],
        ["GET", `${ws(workspaceId)}/team`],
        ["GET", `${ws(workspaceId)}/runs`],
        ["GET", `${ws(workspaceId)}/active-runs`],
      ];
      for (const [method, path, payload] of probes) {
        const res = await call(eva, method, path, payload);
        expect([method, path, res.status]).toEqual([method, path, 404]);
      }
      // Through her own workspace, the agent's id is not found either.
      const mine = agentPath(theirs.workspace.id, lia.id);
      for (const [method, path, payload] of [
        ["GET", mine],
        ["PATCH", mine, { name: "Eva's" }],
        ["DELETE", mine],
        ["GET", `${mine}/test-cases`],
        ["POST", `${mine}/builder`, { description: "x" }],
      ] as [string, string, unknown?][]) {
        const res = await call(eva, method, path, payload);
        expect([method, path, res.status]).toEqual([method, path, 404]);
      }
      // Nothing changed.
      const after = await ok<Agent>(call(ana, "GET", here));
      expect([after.name, after.archivedAt]).toEqual(["Lia", null]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a run of a private channel stays out of the list and its detail answers 404 for whoever doesn't read it",
    async () => {
      const { workspaceId, general, ana, beto, lia } = await team();
      const secret = await seedChannel(server, workspaceId, {
        name: "secret",
        visibility: "private",
        members: [ana],
      });
      const run = async (channelId: string) => {
        const id = newId("run");
        await server.deps.db.insert(schema.runs).values({
          id,
          workspaceId,
          agentId: lia.id,
          channelId,
          status: "done",
          what: "Answered",
          model: "claude-haiku-5-5",
        });
        return id;
      };
      const open = await run(general);
      const hidden = await run(secret);
      const runs = `${ws(workspaceId)}/runs`;
      const ids = (body: { runs: { id: string }[] }) => body.runs.map((r) => r.id).sort();
      expect(ids(await ok(call(ana, "GET", runs)))).toEqual([open, hidden].sort());
      expect(ids(await ok(call(beto, "GET", runs)))).toEqual([open]);
      expect((await call(beto, "GET", `${runs}/${hidden}`)).status).toBe(404);
      expect((await call(beto, "POST", `${runs}/${hidden}/cancel`)).status).toBe(404);
      expect((await ok<{ run: { id: string } }>(call(beto, "GET", `${runs}/${open}`))).run.id).toBe(open);
      // Without the runtime no run is live: stopping one answers that it already ended.
      const stop = await call(ana, "POST", `${runs}/${open}/cancel`);
      expect([stop.status, stop.body.error.code]).toEqual([409, "run.already_ended"]);
      expect(
        (await ok<{ runs: unknown[] }>(call(beto, "GET", `${ws(workspaceId)}/active-runs`))).runs,
      ).toEqual([]);
      // The usage report is for whoever may see spending.
      expect((await call(beto, "GET", `${ws(workspaceId)}/usage`)).status).toBe(403);
      expect((await call(ana, "GET", `${ws(workspaceId)}/usage`)).status).toBe(200);
    },
    SERVER_TEST_MS,
  );
});
