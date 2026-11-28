// The receipts a live run writes inside a transaction of its own (the engine's fake model calling the tool):
// an approved post with the undo window on (the send queue's transaction), a reminder, an issue comment and base rows
// (each with its receipt). The runtime's `recordAction` must write in the transaction it is given: on the
// single connection of PGlite a write beside it waits on it forever. The rest of the tests run with the
// window off (harness.ts), so this file is the one that takes the runtime through `queueSend`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { replaceGrants } from "../src/integrations/access";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, settle, signedIn, startTestServer, waitFor } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import type { Person } from "./seed";
import { seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ env: { UNDO_SEND_SECONDS: "30" } });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

test(
  "approving queues the post and the answer carries its receipt, which can be undone",
  async () => {
    const ana = await signedIn(server, "Ana", "ana@undo-window.test");
    const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
    const sales = await seedChannel(server, workspaceId, { name: "sales", members: [ana] });
    await seedAgent(server, workspaceId, ana, "liawindow", [general, sales]);
    const w = ws(workspaceId);
    const directive = '[[tool:post_message {"channel":"#sales","text":"The part arrived"}]]';
    expect(
      (
        await call(ana, "POST", `${w}/channels/${general}/messages`, {
          body: `@liawindow ${directive}`,
          clientId: "w1",
        })
      ).status,
    ).toBe(201);
    let approval: { id: string; payloadHash: string } | undefined;
    await waitFor(async () => {
      approval = (await call(ana, "GET", `${w}/approvals?status=pending`)).body.approvals[0];
      return approval !== undefined;
    });
    if (approval === undefined) throw new Error("no approval");
    const approved = await call(ana, "POST", `${w}/approvals/${approval.id}/approve`, {
      payloadHash: approval.payloadHash,
    });
    expect(approved.status).toBe(200);
    await settle(server);

    // The server still answers (the receipt was written in the queue's transaction, not beside it).
    const done = (await call(ana, "GET", `${w}/approvals/${approval.id}`)).body;
    expect(done.result).toMatchObject({ ok: true });
    const messages = (await call(ana, "GET", `${w}/channels/${general}/messages`)).body.messages as {
      id: string;
      runId: string | null;
      actions: { id: string; kind: string; target: { type: string }; params: { sendAt?: string } }[];
    }[];
    const answer = messages.find((message) => message.actions.length > 0);
    expect(answer?.actions).toMatchObject([{ kind: "message_posted", target: { type: "outbox" } }]);
    expect(typeof answer?.actions[0]?.params.sendAt).toBe("string");
    // Nothing went out yet, and undoing inside the window cancels it.
    expect((await call(ana, "GET", `${w}/channels/${sales}/messages`)).body.messages).toEqual([]);
    const undone = await call(ana, "POST", `${w}/actions/${answer?.actions[0]?.id}/undo`, {});
    expect(undone.status).toBe(200);
    expect(undone.body.revertedAt).not.toBeNull();
  },
  SERVER_TEST_MS,
);

/** Ana's workspace with Lia in #general; `ask` posts to Lia and waits until her run ends. */
async function withLia(who: string) {
  const ana: Person = await signedIn(server, "Ana", `${who}@undo-window.test`);
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const lia = await seedAgent(server, workspaceId, ana, `lia${who}`, [general]);
  // Every area of the workspace, so the reminder and issue tools are hers.
  await replaceGrants(server.deps.db, workspaceId, lia.id, [{ connectionId: "", scope: "*" }]);
  const w = ws(workspaceId);
  const ask = async (directive: string) => {
    const posted = await call(ana, "POST", `${w}/channels/${general}/messages`, {
      body: `@lia${who} ${directive}`,
      clientId: `${who}-1`,
    });
    expect(posted.status).toBe(201);
    await settle(server);
  };
  const receipts = async () =>
    (
      (await call(ana, "GET", `${w}/channels/${general}/messages`)).body.messages as {
        body: string;
        actions: { kind: string }[];
      }[]
    )
      .flatMap((message) => message.actions)
      .map((action) => action.kind);
  return { ana, w, ask, receipts };
}

test(
  "a reminder and its receipt are written together",
  async () => {
    const { ask, receipts } = await withLia("reminder");
    const at = new Date(Date.now() + 86_400_000).toISOString();
    await ask(`[[tool:schedule_reminder {"text":"Order paper","at":"${at}"}]]`);
    expect(await receipts()).toEqual(["reminder_created"]);
  },
  SERVER_TEST_MS,
);

test(
  "an issue comment and its receipt are written together",
  async () => {
    const { ana, w, ask, receipts } = await withLia("comment");
    const issue = await call(ana, "POST", `${w}/issues`, { title: "Paper jam" });
    expect(issue.status).toBe(201);
    await ask(`[[tool:comment_issue {"number":${issue.body.number},"text":"Cleared the tray."}]]`);
    expect(await receipts()).toEqual(["issue_commented"]);
  },
  SERVER_TEST_MS,
);

test(
  "base rows and their receipt are written together",
  async () => {
    const { ana, w, ask, receipts } = await withLia("rows");
    const base = await call(ana, "POST", `${w}/bases`, { title: "Orders", titleName: "Name" });
    expect(base.status).toBe(201);
    await ask('[[tool:upsert_base_rows {"base":"Orders","rows":[{"values":{"Name":"Paper"}}]}]]');
    expect(await receipts()).toEqual(["base_rows_upserted"]);
  },
  SERVER_TEST_MS,
);
