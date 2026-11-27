// The agent using the runner lent to it, end to end with the real runner (sandbox off): commands and files,
// the workspace's command timeout, and a secret request delivered sealed from the card. The agent's runtime
// (the model loop) comes with a later module, so each tool call goes through `runTool` with the tools the runtime
// would pick for the agent (`environmentToolsFor`), as the person who asked; the people's side goes over HTTP.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealSecret } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { RunnerClient } from "@vanr/runner/client";
import { type DeviceStart, pair } from "@vanr/runner/pair";
import { sandboxOff } from "@vanr/runner/sandbox";
import { eq } from "drizzle-orm";
import { environmentToolsFor } from "../src/runners/agent-tools";
import type { ApprovalOutcome, ApprovalRequest, ToolContext } from "../src/runtime/tools";
import type { RunningServer } from "../src/server";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";
import { seedAgent, toolRun } from "./tool-run";

let server: RunningServer;
const clients: RunnerClient[] = [];
const homes: string[] = [];
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(async () => {
  for (const c of clients) await c.stop();
  await server.stop();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@runner-tools.test`;

async function api(who: Person, method: string, path: string, payload?: unknown) {
  const res = await who.browser.json(path, method, payload);
  return { status: res.status, body: res.status === 204 ? null : await body(res) };
}

/** Ana owns the workspace and pairs a real runner; Beto asks Lia (Ana's agent, lent that runner) for tools. */
async function setup() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const ws = `/api/v1/workspaces/${workspaceId}`;
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await seedAgent(server, workspaceId, ana, { name: "Lia", channels: [general] });
  const home = mkdtempSync(join(tmpdir(), "runner-"));
  homes.push(home);
  let confirmed: Promise<unknown> = Promise.resolve();
  const config = await pair({
    server: server.url,
    home,
    workDir: join(home, "work"),
    print: () => {},
    onCode: (start: DeviceStart) => {
      confirmed = api(ana, "POST", `${ws}/runner-pairings/${start.userCode}/confirm`, {});
    },
    sleep: async () => {
      await confirmed;
    },
  });
  const runner = new RunnerClient({
    sandbox: sandboxOff(),
    home,
    executors: [],
    browser: null,
    backoffBaseMs: 50,
  });
  clients.push(runner);
  runner.start();
  await runner.ready();
  const lent = await api(ana, "PUT", `${ws}/agents/${lia.id}/environment/target`, {
    runnerId: config.runnerId,
  });
  expect(lent.status).toBe(200);

  /** Beto asks Lia for one tool, with the tools the runtime would give her now. */
  const ask = async (tool: string, input: unknown, over: Partial<ToolContext> = {}) => {
    const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, lia.id));
    if (!agent) throw new Error("agent gone");
    const tools = await environmentToolsFor({ deps: server.deps, agent });
    const run = await toolRun(server, { workspaceId, agent, channelId: general, asker: beto, tools });
    const out = await run.call(tool, input, over);
    return { result: out.content, isError: out.isError, cards: run.cards };
  };
  return { workspaceId, ws, general, ana, beto, lia, home, config, ask };
}

const approve =
  (asked: ApprovalRequest[]) =>
  async (req: ApprovalRequest): Promise<ApprovalOutcome> => {
    asked.push(req);
    return {
      id: "apv_test",
      decision: "approved",
      reason: null,
      byName: "Ana",
      payloadHash: req.payloadHash,
    };
  };

describe("the agent's runner", () => {
  test(
    "commands and files through the tools, with the live output",
    async () => {
      const t = await setup();
      const live: string[] = [];
      const ran = await t.ask(
        "execute_code",
        { command: "echo hello-from-runner && pwd" },
        { toolOutput: (text) => live.push(text) },
      );
      expect(ran.isError).toBe(false);
      expect(ran.result).toContain("exit code: 0");
      expect(ran.result).toContain("hello-from-runner");
      expect(ran.result).toContain(`${t.lia.handle}-${t.lia.id.slice(-8)}`);
      expect(live.join("")).toContain("hello-from-runner");

      const failed = await t.ask("execute_code", { command: "echo failed >&2; exit 3" });
      expect(failed.isError).toBe(true);
      expect(failed.result).toContain("exit code: 3");

      expect(
        (await t.ask("write_file", { path: "notes/plan.md", content: "# Plan\n- test" })).result,
      ).toContain("Wrote");
      expect((await t.ask("read_file", { path: "notes/plan.md" })).result).toContain("- test");
      expect((await t.ask("list_files", { path: "notes" })).result).toContain("plan.md");
      expect((await t.ask("read_file", { path: "/etc/hostname" })).isError).toBe(true);
      const exported = await t.ask("export_file", { path: "notes/plan.md" });
      expect(exported.result).toContain("Saved notes/plan.md to the Drive");
      const fileId = /\((file_[^)]+)\)/.exec(exported.result)?.[1] as string;
      expect((await t.ask("import_file", { fileId, path: "copy.md" })).result).toContain("Copied");
      expect((await t.ask("read_file", { path: "copy.md" })).result).toContain("# Plan");

      expect((await t.ask("environment_status", {})).result).toContain("online");
      expect((await t.ask("environment_stop", {})).result).toBe("Your runner is stopped.");
      expect((await t.ask("execute_code", { command: "echo x" })).result).toContain("environment_start");
      expect((await t.ask("environment_start", {})).result).toBe("Your runner is ready.");

      // A workspace that requires approval for commands: the call waits for the person's decision.
      const asked: ApprovalRequest[] = [];
      expect((await api(t.ana, "PUT", `${t.ws}/sandbox-settings`, { requireApproval: true })).status).toBe(
        200,
      );
      const approved = await t.ask(
        "execute_code",
        { command: "echo approved" },
        { requestApproval: approve(asked) },
      );
      expect(asked[0]?.preview.title).toBe("Run a command on the runner");
      expect(approved.result).toContain("approved");

      // Without a runner, the tools leave the agent. The notice goes out in the shape of every `environment.updated`.
      const sent = spyOn(server.deps.hub, "toWorkspace");
      expect(
        (await api(t.ana, "PUT", `${t.ws}/agents/${t.lia.id}/environment/target`, { runnerId: null })).status,
      ).toBe(200);
      expect(sent.mock.calls.map(([, e]) => e).find((e) => e.type === "environment.updated")).toMatchObject({
        agentId: t.lia.id,
        environment: { status: "none", target: null },
      });
      sent.mockRestore();
      expect((await t.ask("execute_code", { command: "echo x" })).result).toContain(
        "Unknown tool execute_code",
      );
    },
    2 * SERVER_TEST_MS,
  );

  test(
    "the workspace's maximum time is the command's default and its ceiling",
    async () => {
      const t = await setup();
      expect((await api(t.ana, "PUT", `${t.ws}/sandbox-settings`, { commandTimeoutSec: 30 })).status).toBe(
        200,
      );
      const calls = spyOn(server.deps.runners, "call");
      const sent = () =>
        calls.mock.calls
          .filter(([, op]) => op === "exec")
          .map(([, , args]) => (args as { timeoutSeconds: number }).timeoutSeconds);
      expect((await t.ask("execute_code", { command: "echo a" })).isError).toBe(false);
      expect((await t.ask("execute_code", { command: "echo b", timeoutSeconds: 600 })).isError).toBe(false);
      expect((await t.ask("execute_code", { command: "echo c", timeoutSeconds: 10 })).isError).toBe(false);
      expect(sent()).toEqual([30, 30, 10]);
      calls.mockRestore();
    },
    SERVER_TEST_MS,
  );

  test(
    "a secret request: the card carries the key, the person delivers it sealed and the command gets it",
    async () => {
      const t = await setup();
      const asked = await t.ask("request_secret", { name: "API_TOKEN", purpose: "To call the shop's API" });
      expect(asked.result).toContain("Asked for API_TOKEN");
      const request = asked.cards.find((c) => (c.meta as { secretRequest?: unknown }).secretRequest)
        ?.meta as {
        secretRequest: { id: string; publicKey: string; name: string; status: string; targetUserId: string };
      };
      expect(request.secretRequest).toMatchObject({
        name: "API_TOKEN",
        status: "pending",
        targetUserId: t.beto.user.id,
      });
      const { id, publicKey } = request.secretRequest;

      const value = "tok-shop-secret-42";
      const box = await sealSecret(publicKey, value, {
        requestId: id,
        workspaceId: t.workspaceId,
        name: "API_TOKEN",
        target: "env",
      });
      const deliver = (who: Person, requestId: string, sealed: unknown) =>
        api(who, "POST", `${t.ws}/secret-requests/${requestId}/deliver`, { box: sealed });
      expect((await deliver(t.ana, id, box)).status).toBe(403);
      const delivered = await deliver(t.beto, id, box);
      expect(delivered.status).toBe(200);
      expect(delivered.body.status).toBe("delivered");
      expect((await deliver(t.beto, id, box)).body.error.code).toBe("secret.closed");

      // An expired request: its own code, so the screen doesn't say someone answered.
      const late = (
        await t.ask("request_secret", { name: "OTHER_TOKEN", purpose: "For the other shop" })
      ).cards
        .map((c) => (c.meta as { secretRequest?: { id: string; publicKey: string } }).secretRequest)
        .find(Boolean);
      if (!late) throw new Error("no second card");
      await server.deps.db
        .update(schema.secretPrompts)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.secretPrompts.id, late.id));
      const lateBox = await sealSecret(late.publicKey, "x", {
        requestId: late.id,
        workspaceId: t.workspaceId,
        name: "OTHER_TOKEN",
        target: "env",
      });
      expect((await deliver(t.beto, late.id, lateBox)).body.error.code).toBe("secret_request.expired");
      expect(
        (await api(t.beto, "POST", `${t.ws}/secret-requests/${late.id}/decline`, {})).body.error.code,
      ).toBe("secret_request.expired");

      const list = await api(t.ana, "GET", `${t.ws}/agents/${t.lia.id}/secrets`);
      expect(list.body.secrets).toMatchObject([
        { name: "API_TOKEN", runnerId: t.config.runnerId, target: { kind: "env" } },
      ]);
      const used = await t.ask("execute_code", {
        command: `test "$API_TOKEN" = ${value} && echo matches; echo "$API_TOKEN"`,
      });
      expect(used.result).toContain("matches");
      expect(used.result).toContain("[secret:API_TOKEN]");
      expect(used.result).not.toContain(value);

      // Declining another request; a file as the target. A lowercase name fails at the boundary.
      const second = (
        await t.ask("request_secret", { name: "SSH_KEY", purpose: "Deploy", file: ".ssh/id" })
      ).cards
        .map((c) => (c.meta as { secretRequest?: { id: string; target: unknown } }).secretRequest)
        .find(Boolean);
      expect(second?.target).toEqual({ kind: "file", path: ".ssh/id" });
      expect(
        (await api(t.beto, "POST", `${t.ws}/secret-requests/${second?.id}/decline`, {})).body.status,
      ).toBe("declined");
      expect((await t.ask("request_secret", { name: "lowercase", purpose: "x" })).isError).toBe(true);
      expect((await t.ask("request_secret", { name: "KEY", purpose: "x", file: "../outside" })).isError).toBe(
        true,
      );

      const remove = (who: Person) =>
        api(who, "DELETE", `${t.ws}/agents/${t.lia.id}/secrets/API_TOKEN?runnerId=${t.config.runnerId}`);
      expect((await remove(t.beto)).status).toBe(403);
      expect((await remove(t.ana)).status).toBeLessThan(300);
      expect((await api(t.ana, "GET", `${t.ws}/agents/${t.lia.id}/secrets`)).body.secrets).toEqual([]);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's expansion, not JS's.
      const gone = await t.ask("execute_code", { command: 'echo "[${API_TOKEN:-empty}]"' });
      expect(gone.result).toContain("[empty]");
    },
    2 * SERVER_TEST_MS,
  );
});
