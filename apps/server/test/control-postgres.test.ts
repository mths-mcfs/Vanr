// Undo at the same time as another undo, a person's edit and the send, on a real Postgres, where the server's pool
// runs them on several connections. Undoing checks, changes the content and marks the action in one transaction
// with the action's row locked (FOR UPDATE) and the content's row locked before the comparison.
//
// The "forced" tests don't count on the scheduler: the database double of lock-double.ts holds the first
// transaction at the point where the lock matters until the second one is seen waiting on that lock (or done).
// With VANR_TEST_DROP_LOCKS=1 the same double leaves the locks out: the CI postgres job runs that mode too and
// expects these tests to fail on their outcome, which proves they catch a missing lock. These run only there.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { channelInWorkspace } from "../src/channels";
import type { AppDeps, WorkspaceMember } from "../src/context";
import { type ActionRow, applyUndo, UNDO_WINDOW_MS } from "../src/control";
import { HttpError } from "../src/http";
import { columnsOf, createIssue, issueById, updateIssue } from "../src/issues";
import { postMessage } from "../src/messages";
import { deliverDue } from "../src/outbox";
import type { RunningServer } from "../src/server";
import { signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { memberOf, seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 10;
const { agents, reversibleActions, messages, outbox } = schema;

interface Ctx {
  workspaceId: string;
  general: string;
  agentId: string;
  /** Carla asked the agent: she may undo its actions. */
  carla: WorkspaceMember;
  betoId: string;
}

async function withServer(
  prefix: string,
  run: (server: RunningServer, admin: postgres.Sql, ctx: Ctx) => Promise<void>,
) {
  const url = await testDatabaseUrl(prefix);
  const server = await startTestServer({ env: { DATABASE_URL: url } });
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const tag = prefix.replaceAll("_", "-");
    const ana = await signedIn(server, "Ana", `ana@${tag}.test`);
    const { workspaceId, general } = await seedWorkspace(server, ana, "Undo");
    const beto = await memberOf(server, workspaceId, "Beto", `beto@${tag}.test`);
    const carla = await memberOf(server, workspaceId, "Carla", `carla@${tag}.test`);
    const agentId = newId("agt");
    await server.deps.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: "Lia",
      handle: "lia",
      model: "claude-haiku-5-5",
      ownerUserId: beto.user.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    });
    await columnsOf(server.deps.db, workspaceId);
    await run(server, admin, {
      workspaceId,
      general,
      agentId,
      carla: { workspaceId, userId: carla.user.id, role: "member", handle: "carla" },
      betoId: beto.user.id,
    });
  } finally {
    await server.stop();
    await admin.end({ timeout: 5 });
  }
}

const withDb = (deps: AppDeps, hooks: Parameters<typeof instrumented>[1]): AppDeps => ({
  ...deps,
  db: instrumented(deps.db, hooks),
});

async function seedAction(
  server: RunningServer,
  ctx: Ctx,
  kind: string,
  target: { type: string; id: string },
  params: Record<string, unknown> = {},
  revertibleUntil = new Date(Date.now() + UNDO_WINDOW_MS),
): Promise<ActionRow> {
  const [row] = await server.deps.db
    .insert(reversibleActions)
    .values({
      id: newId("act"),
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      requesterUserId: ctx.carla.userId,
      kind,
      target,
      params,
      revertibleUntil,
    })
    .returning();
  if (!row) throw new Error("no action");
  return row;
}

async function agentPost(server: RunningServer, ctx: Ctx, text: string) {
  const channel = await channelInWorkspace(server.deps.db, ctx.workspaceId, ctx.general);
  if (!channel) throw new Error("no channel");
  const { message } = await postMessage(server.deps, {
    workspaceId: ctx.workspaceId,
    channel,
    author: { type: "agent", id: ctx.agentId },
    body: text,
    clientId: null,
  });
  return message;
}

/** The undo's result as a label: ok, or the error code it answered. */
const undoing = (deps: AppDeps, me: WorkspaceMember, row: ActionRow) =>
  applyUndo(deps, me, row, "undo").then(
    () => "ok",
    (err: unknown) => {
      if (err instanceof HttpError) return err.code;
      throw err;
    },
  );

/** An issue the agent renamed, with the receipt that undoes it. */
async function renamed(server: RunningServer, ctx: Ctx, i: number) {
  const agent = { type: "agent" as const, id: ctx.agentId };
  const issue = await createIssue(server.deps, {
    workspaceId: ctx.workspaceId,
    title: `Draft ${i}`,
    author: agent,
  });
  await updateIssue(server.deps, issue, { title: `Agent ${i}` }, agent);
  const action = await seedAction(
    server,
    ctx,
    "issue_edited",
    { type: "issue", id: issue.id },
    {
      previous: { title: `Draft ${i}` },
      change: { title: `Agent ${i}` },
    },
  );
  return { issue, action };
}

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("undo at the same time on Postgres"), () => {
  test("N undos of one action at once: one undoes, the others find it undone", async () => {
    await withServer("undo_n", async (server, _admin, ctx) => {
      const posted = await agentPost(server, ctx, "Posted once");
      const action = await seedAction(server, ctx, "message_posted", { type: "message", id: posted.id });
      const results = await Promise.all(
        Array.from({ length: N }, () => undoing(server.deps, ctx.carla, action)),
      );
      expect(results.filter((r) => r === "ok").length).toBe(1);
      expect(results.filter((r) => r === "action.already_undone").length).toBe(N - 1);
    });
  }, 60_000);

  test("undo against a person's edit of the same issue, N times: the person's title always stays", async () => {
    await withServer("undo_edit", async (server, _admin, ctx) => {
      const person = { type: "person" as const, id: ctx.betoId };
      for (let i = 0; i < N; i++) {
        const { issue, action } = await renamed(server, ctx, i);
        const [undo] = await Promise.all([
          undoing(server.deps, ctx.carla, action),
          updateIssue(server.deps, issue, { title: `Beto ${i}` }, person),
        ]);
        expect(["ok", "action.changed_since"]).toContain(undo);
        expect((await issueById(server.deps.db, ctx.workspaceId, issue.id)).title).toBe(`Beto ${i}`);
      }
    });
  }, 60_000);

  test("undo against the send at the deadline, N times: each post is canceled or sent, never both", async () => {
    await withServer("undo_send", async (server, _admin, ctx) => {
      const sendAt = new Date(Date.now() + 60_000);
      const items: { id: string; action: ActionRow }[] = [];
      for (let i = 0; i < N; i++) {
        const id = newId("out");
        await server.deps.db.insert(outbox).values({
          id,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          runId: null,
          kind: "post",
          payload: { channelId: ctx.general, text: `post ${i}`, clientId: `c-${i}` },
          sendAt,
        });
        const action = await seedAction(
          server,
          ctx,
          "message_posted",
          { type: "outbox", id },
          { outboxId: id },
        );
        items.push({ id, action });
      }
      // The sweep sees the deadline passed; the undos are still inside their window.
      const sweep = { ...server.deps, now: () => sendAt };
      const results = await Promise.all([
        ...items.map((it) => undoing(server.deps, ctx.carla, it.action)),
        deliverDue(sweep),
        deliverDue(sweep),
      ]);
      for (const [i, it] of items.entries()) {
        const [row] = await server.deps.db.select().from(outbox).where(eq(outbox.id, it.id));
        const posted = await server.deps.db
          .select()
          .from(messages)
          .where(eq(messages.body, `post ${i}`));
        const [action] = await server.deps.db
          .select()
          .from(reversibleActions)
          .where(eq(reversibleActions.id, it.action.id));
        if (results[i] === "ok") {
          expect(row?.status).toBe("canceled");
          expect(posted).toEqual([]);
          expect(action?.revertedAt).not.toBeNull();
        } else {
          expect(results[i]).toBe("action.changed_since");
          expect(row?.status).toBe("sent");
          expect(posted.length).toBe(1);
          expect(action?.revertedAt).toBeNull();
        }
      }
    });
  }, 60_000);

  test("forced: the second undo of one action waits on its row lock and finds it undone", async () => {
    await withServer("undo_twice", async (server, admin, ctx) => {
      const posted = await agentPost(server, ctx, "Retract me");
      const action = await seedAction(server, ctx, "message_posted", { type: "message", id: posted.id });
      // A holds right after locking the action. With the lock B waits and then sees it undone; without it, B reads
      // it still open and retracts the message a second time.
      const run = await forcedPair(admin, "undo-twice", "select", (side, hooks) =>
        undoing(withDb(server.deps, hooks), ctx.carla, action).then((r) => `${side}:${r}`),
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      outcome("undo-twice", [run.a, run.b], ["A:ok", "B:action.already_undone"]);
    });
  }, 60_000);

  test("forced: an undo against a person's edit waits on the issue's lock and declines after it", async () => {
    await withServer("undo_vs_edit", async (server, admin, ctx) => {
      const { issue, action } = await renamed(server, ctx, 0);
      const person = { type: "person" as const, id: ctx.betoId };
      // A is the person's edit, held right after locking the issue. With the lock the undo waits, then sees the
      // person's title and declines; without it, the undo compares with the agent's title, writes the old one and
      // reports success while the person's edit lands over it.
      const run = await forcedPair(
        admin,
        "undo-vs-edit",
        "select",
        (side, hooks) =>
          side === "A"
            ? updateIssue(withDb(server.deps, hooks), issue, { title: "Beto's" }, person).then(
                () => "A:edited",
              )
            : undoing(withDb(server.deps, hooks), ctx.carla, action).then((r) => `B:${r}`),
        { bKind: "update" },
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      const title = (await issueById(server.deps.db, ctx.workspaceId, issue.id)).title;
      outcome("undo-vs-edit", [run.a, run.b, title], ["A:edited", "B:action.changed_since", "Beto's"]);
    });
  }, 60_000);

  test("forced: the send at the deadline waits on the undo's lock of the queued item and finds it canceled", async () => {
    await withServer("undo_vs_send", async (server, admin, ctx) => {
      const sendAt = new Date(Date.now() + 60_000);
      const id = newId("out");
      await server.deps.db.insert(outbox).values({
        id,
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        runId: null,
        kind: "post",
        payload: { channelId: ctx.general, text: "Flash sale", clientId: "c-forced" },
        sendAt,
      });
      const action = await seedAction(
        server,
        ctx,
        "message_posted",
        { type: "outbox", id },
        { outboxId: id },
      );
      // A is the undo, held right after locking the queued item (its `select "id" ... for update`, not the access check's read of the payload). With the
      // lock the sweep's claim waits, then finds it canceled; without it, the sweep claims and posts it, and the
      // undo that got there first finds it gone out.
      const run = await forcedPair(
        admin,
        "undo-vs-send",
        "select",
        (side, hooks) =>
          side === "A"
            ? undoing(withDb(server.deps, hooks), ctx.carla, action).then((r) => `A:${r}`)
            : instrumented(server.deps.db, hooks)
                .transaction((tx) => deliverDue({ ...server.deps, db: tx, now: () => sendAt }))
                .then((sent) => `B:${sent}`),
        { match: 'select "id" from "outbox"', bKind: "update" },
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      const [row] = await server.deps.db.select().from(outbox).where(eq(outbox.id, id));
      const posted = await server.deps.db.select().from(messages).where(eq(messages.body, "Flash sale"));
      outcome("undo-vs-send", [run.a, run.b, row?.status, posted.length], ["A:ok", "B:0", "canceled", 0]);
    });
  }, 60_000);
});
