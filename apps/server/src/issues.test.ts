// The issues domain without its routes (routes/issues comes with the routines and the messages): the board's
// columns, the number and the position of a new issue, the timeline, the notices, the API shape and the end of
// an agent's work, called the way the routes and the runtime call them, over a real server's database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, asc, eq } from "drizzle-orm";
import { SERVER_TEST_MS, signedIn, startTestServer } from "../test/harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "../test/seed";
import { HttpError } from "./http";
import {
  columnsOf,
  createIssue,
  issueById,
  issueByNumber,
  notifyComment,
  STAGES,
  saveColumnOrder,
  settleIssueWork,
  toIssue,
  toIssues,
  updateIssue,
} from "./issues";
import type { RunningServer } from "./server";

const { issues, issueTimeline, notifications, debates, messages } = schema;

let server: RunningServer;
let ana: Person;
let beto: Person;
let caio: Person;
let workspaceId: string;
let general: string;
const person = (p: Person) => ({ type: "person" as const, id: p.user.id });

beforeAll(async () => {
  server = await startTestServer();
  ana = await memberOfNew("Ana", "ana@issues.test");
  ({ workspaceId, general } = await seedWorkspace(server, ana, "Issues"));
  beto = await memberOf(server, workspaceId, "Beto", "beto@issues.test");
  caio = await memberOf(server, workspaceId, "Caio", "caio@issues.test");
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const memberOfNew = (name: string, email: string): Promise<Person> => signedIn(server, name, email);

async function freshWorkspace(name: string) {
  const owner = await memberOfNew(name, `${name.toLowerCase()}@issues.test`);
  return { owner, ...(await seedWorkspace(server, owner, name)) };
}

async function newAgent(ws: string, handle: string, archived = false): Promise<string> {
  const id = newId("agt");
  await server.deps.db.insert(schema.agents).values({
    id,
    workspaceId: ws,
    name: handle,
    handle,
    role: "support",
    instructions: "",
    model: "claude-haiku-5-5",
    ownerUserId: ana.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
    archivedAt: archived ? new Date() : null,
  });
  return id;
}

const timeline = (issueId: string) =>
  server.deps.db
    .select()
    .from(issueTimeline)
    .where(eq(issueTimeline.issueId, issueId))
    .orderBy(asc(issueTimeline.seq));

const noticesOf = (userId: string, groupKey: string) =>
  server.deps.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.groupKey, groupKey)));

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("expected an HttpError");
};

describe("board columns", () => {
  test("a new workspace gets one column per stage, once, even when asked for them at the same time", async () => {
    const { workspaceId: ws } = await freshWorkspace("Cols");
    const lists = await Promise.all(Array.from({ length: 6 }, () => columnsOf(server.deps.db, ws)));
    for (const cols of lists) {
      expect(cols.map((c) => c.stage)).toEqual([...STAGES]);
      expect(cols.map((c) => c.position)).toEqual([0, 1, 2, 3, 4]);
      expect(cols.every((c) => c.name === "")).toBe(true);
    }
    const all = await server.deps.db
      .select()
      .from(schema.boardColumns)
      .where(eq(schema.boardColumns.workspaceId, ws));
    expect(all.length).toBe(STAGES.length);
  });

  test("saving an order renumbers the columns and keeps them grouped by stage", async () => {
    const { workspaceId: ws } = await freshWorkspace("Order");
    const cols = await columnsOf(server.deps.db, ws);
    const [todo] = cols;
    if (!todo) throw new Error("no todo column");
    const [extra] = await server.deps.db
      .insert(schema.boardColumns)
      .values({ id: newId("col"), workspaceId: ws, name: "Backlog", stage: "todo", position: 9 })
      .returning();
    if (!extra) throw new Error("no extra column");
    // The person dragged "Backlog" to the end and "done" to the front: the stages still lead.
    const dragged = [
      ...cols.filter((c) => c.stage === "done"),
      ...cols.filter((c) => c.stage !== "done"),
      extra,
    ];
    await saveColumnOrder(server.deps.db, dragged);
    const after = await columnsOf(server.deps.db, ws);
    expect(after.map((c) => [c.stage, c.name])).toEqual([
      ["todo", ""],
      ["todo", "Backlog"],
      ["in_progress", ""],
      ["reviewing", ""],
      ["done", ""],
      ["canceled", ""],
    ]);
    expect(after.map((c) => c.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("creating an issue", () => {
  test("issues created at the same time get the next numbers without a repeat or a hole, each on top of its column", async () => {
    const { owner, workspaceId: ws } = await freshWorkspace("Burst");
    const n = 20;
    const rows = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        createIssue(server.deps, { workspaceId: ws, title: `Issue ${i}`, author: person(owner) }),
      ),
    );
    expect(rows.map((r) => r.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: n }, (_, i) => i + 1),
    );
    // Each new one goes above every one before it: the first at 0, then one less each time.
    const byNumber = [...rows].sort((a, b) => a.number - b.number);
    expect(byNumber.map((r) => r.boardPosition)).toEqual(
      Array.from({ length: n }, (_, i) => (i === 0 ? 0 : -i)),
    );
    // Another workspace counts on its own.
    const { owner: other, workspaceId: ws2 } = await freshWorkspace("Other");
    const first = await createIssue(server.deps, { workspaceId: ws2, title: "First", author: person(other) });
    expect(first.number).toBe(1);
    expect((await issueByNumber(server.deps.db, ws, 7)).title).toMatch(/^Issue /);
  });

  test("a new issue starts in todo with its criteria, the created event and a notice to its assignee", async () => {
    const row = await createIssue(server.deps, {
      workspaceId,
      title: "Ship the board",
      description: "All of it",
      criteria: ["Columns", "Drag"],
      assignee: person(beto),
      priority: "high",
      labels: ["web"],
      author: person(ana),
    });
    const issue = await toIssue(server.deps.db, row);
    expect(issue).toMatchObject({
      title: "Ship the board",
      status: "todo",
      priority: "high",
      labels: ["web"],
      assignee: person(beto),
      createdBy: person(ana),
      subIssues: [],
      debates: [],
      files: [],
      work: null,
      source: null,
    });
    expect(issue.criteria.map((c) => [c.text, c.done])).toEqual([
      ["Columns", false],
      ["Drag", false],
    ]);
    expect(issue.criteria.every((c) => c.id.startsWith("crit_"))).toBe(true);
    const events = await timeline(row.id);
    expect(events.map((e) => [e.kind, e.event, e.textKey, e.text])).toEqual([
      ["event", "created", "issues.activity.created", "created the issue"],
    ]);
    const [notice, ...more] = await noticesOf(beto.user.id, `issue_ownership:${row.id}`);
    expect(more).toEqual([]);
    expect(notice).toMatchObject({
      kind: "issue_ownership",
      source: { issueId: row.id, issueSeq: row.number, label: `#${row.number}` },
      latest: { title: "Ship the board" },
    });
  });

  test("assigning yourself or an agent sends no notice", async () => {
    const mine = await createIssue(server.deps, {
      workspaceId,
      title: "Mine",
      assignee: person(ana),
      author: person(ana),
    });
    const agents = await createIssue(server.deps, {
      workspaceId,
      title: "The agent's",
      assignee: { type: "agent", id: await newAgent(workspaceId, "rex") },
      author: person(ana),
    });
    expect(await noticesOf(ana.user.id, `issue_ownership:${mine.id}`)).toEqual([]);
    expect(
      await server.deps.db
        .select()
        .from(notifications)
        .where(eq(notifications.groupKey, `issue_ownership:${agents.id}`)),
    ).toEqual([]);
  });

  test("a column of another workspace is not found and nothing is written", async () => {
    const { workspaceId: ws } = await freshWorkspace("Foreign");
    const [foreign] = await columnsOf(server.deps.db, ws);
    const before = await server.deps.db.select().from(issues).where(eq(issues.workspaceId, workspaceId));
    expect(
      await failure(
        createIssue(server.deps, { workspaceId, title: "Lost", columnId: foreign?.id, author: person(ana) }),
      ),
    ).toEqual({ status: 404, code: "not_found" });
    expect(
      (await server.deps.db.select().from(issues).where(eq(issues.workspaceId, workspaceId))).length,
    ).toBe(before.length);
  });

  test("an issue is found by id or number only inside its workspace", async () => {
    const row = await createIssue(server.deps, { workspaceId, title: "Here", author: person(ana) });
    const { workspaceId: ws } = await freshWorkspace("Elsewhere");
    expect((await issueById(server.deps.db, workspaceId, row.id)).id).toBe(row.id);
    expect(await failure(issueById(server.deps.db, ws, row.id))).toEqual({ status: 404, code: "not_found" });
    expect(await failure(issueByNumber(server.deps.db, ws, row.number))).toEqual({
      status: 404,
      code: "not_found",
    });
  });
});

describe("changing an issue", () => {
  test("each field that changed becomes one event, and whoever follows the issue hears of the move and the assignment", async () => {
    const cols = await columnsOf(server.deps.db, workspaceId);
    const stage = (s: string) => cols.find((c) => c.stage === s)?.id ?? "";
    const row = await createIssue(server.deps, {
      workspaceId,
      title: "Old title",
      assignee: person(beto),
      author: person(ana),
    });
    // Caio changes it: Ana (who opened it) and Beto (assigned) follow it; Caio hears nothing of his own change.
    const changed = await updateIssue(
      server.deps,
      row,
      {
        title: "New title",
        description: "Now with a description",
        columnId: stage("in_progress"),
        assignee: person(caio),
        priority: "urgent",
        dueDate: "2026-12-01",
        labels: ["api", "web"],
      },
      person(caio),
    );
    expect(changed.title).toBe("New title");
    const events = (await timeline(row.id)).slice(1);
    expect(events.map((e) => [e.event, e.textKey, e.textVars])).toEqual([
      ["title", "issues.activity.title", { from: "Old title", to: "New title" }],
      ["description", "issues.activity.description", null],
      ["status", "issues.activity.status", { from: "todo", to: "in_progress" }],
      ["assigned", "issues.activity.assigned", { type: "person", id: caio.user.id }],
      ["priority", "issues.activity.priority", { from: "none", to: "urgent" }],
      ["due", "issues.activity.due", { date: "2026-12-01" }],
      ["labels", "issues.activity.labels", { labels: "api, web" }],
    ]);
    expect(events.every((e) => e.author.id === caio.user.id && e.kind === "event")).toBe(true);
    // After the change the new assignee (Caio) and whoever opened it (Ana) follow it; Caio made the change.
    expect(await noticesOf(caio.user.id, `issue_progress:${row.id}`)).toEqual([]);
    const [moved, ...again] = await noticesOf(ana.user.id, `issue_progress:${row.id}`);
    expect(again).toEqual([]);
    expect(moved?.latest).toEqual({ title: "New title", previousStatus: "todo", newStatus: "in_progress" });
    expect(await noticesOf(caio.user.id, `issue_ownership:${row.id}`)).toEqual([]);

    // The same values again: nothing new on the timeline.
    await updateIssue(
      server.deps,
      changed,
      { title: "New title", priority: "urgent", labels: ["api", "web"], columnId: stage("in_progress") },
      person(ana),
    );
    expect((await timeline(row.id)).length).toBe(events.length + 1);

    // A column of the same stage is a column move, not a status change; removing the assignee and the date.
    const [extra] = await server.deps.db
      .insert(schema.boardColumns)
      .values({ id: newId("col"), workspaceId, name: "Doing now", stage: "in_progress", position: 9 })
      .returning();
    await updateIssue(
      server.deps,
      changed,
      { columnId: extra?.id, assignee: null, dueDate: null },
      person(ana),
    );
    const last = (await timeline(row.id)).slice(events.length + 1);
    expect(last.map((e) => [e.event, e.textVars])).toEqual([
      ["column", { column: "Doing now" }],
      ["unassigned", null],
      ["due", { date: "" }],
    ]);
  });

  test("two moves at once are each compared with the issue as the other one left it", async () => {
    const cols = await columnsOf(server.deps.db, workspaceId);
    const stage = (s: string) => cols.find((c) => c.stage === s)?.id ?? "";
    const row = await createIssue(server.deps, { workspaceId, title: "Raced", author: person(ana) });
    // Both callers read the issue in "todo" before either wrote.
    await Promise.all([
      updateIssue(server.deps, row, { columnId: stage("in_progress") }, person(ana)),
      updateIssue(server.deps, row, { columnId: stage("done") }, person(beto)),
    ]);
    const moves = (await timeline(row.id)).filter((e) => e.event === "status").map((e) => e.textVars);
    expect(moves).toEqual([
      { from: "todo", to: "in_progress" },
      { from: "in_progress", to: "done" },
    ]);
    expect((await toIssue(server.deps.db, await issueById(server.deps.db, workspaceId, row.id))).status).toBe(
      "done",
    );
  });

  test("a column that isn't on the board is not found and nothing changes", async () => {
    const row = await createIssue(server.deps, { workspaceId, title: "Stay", author: person(ana) });
    expect(await failure(updateIssue(server.deps, row, { columnId: "col_nope" }, person(ana)))).toEqual({
      status: 404,
      code: "not_found",
    });
    expect((await issueById(server.deps.db, workspaceId, row.id)).columnId).toBe(row.columnId);
    expect((await timeline(row.id)).length).toBe(1);
  });

  test("a comment notice goes to the assignee and the creator, not the commenter, cut to 160 characters", async () => {
    const row = await createIssue(server.deps, {
      workspaceId,
      title: "Talk",
      assignee: person(beto),
      author: person(ana),
    });
    const long = "x".repeat(200);
    await notifyComment(server.deps, row, person(caio), long);
    for (const who of [ana, beto]) {
      const [n] = await noticesOf(who.user.id, `issue_discussion:${row.id}`);
      expect(n?.kind).toBe("issue_discussion");
      expect(n?.latest).toEqual({ title: "Talk", text: `${"x".repeat(159)}…` });
    }
    expect(await noticesOf(caio.user.id, `issue_discussion:${row.id}`)).toEqual([]);
    await notifyComment(server.deps, row, person(beto), "short");
    const [toAna] = await noticesOf(ana.user.id, `issue_discussion:${row.id}`);
    expect(toAna?.latest).toEqual({ title: "Talk", text: "short" });
  });
});

describe("the API shape", () => {
  test("sub-issues, the linked debates of public places only, and saved fields of a shape it doesn't know", async () => {
    const cols = await columnsOf(server.deps.db, workspaceId);
    const parent = await createIssue(server.deps, { workspaceId, title: "Parent", author: person(ana) });
    const child = await createIssue(server.deps, {
      workspaceId,
      title: "Child",
      parentId: parent.id,
      columnId: cols.find((c) => c.stage === "reviewing")?.id,
      author: person(ana),
    });
    const secret = await seedChannel(server, workspaceId, {
      name: "secret",
      visibility: "private",
      members: [ana],
    });
    const debate = (title: string, extra: Partial<typeof debates.$inferInsert>) =>
      server.deps.db.insert(debates).values({
        id: newId("deb"),
        workspaceId,
        title,
        goal: "",
        createdBy: person(ana),
        ...extra,
      });
    await debate("Linked", { issueIds: [parent.id] });
    await debate("Opened from it", { origin: { issueId: parent.id } });
    await debate("In general", { issueIds: [parent.id], channelId: general });
    await debate("Hidden", { issueIds: [parent.id], channelId: secret });
    await debate("Unrelated", { issueIds: [child.id] });
    // A work or a source saved in a shape the contract doesn't have doesn't reach the API.
    await server.deps.db
      .update(issues)
      .set({ work: { state: "dreaming", reason: null, runId: null }, source: { kind: "email" } })
      .where(eq(issues.id, child.id));
    const [p, c] = await toIssues(server.deps.db, workspaceId, [
      parent,
      await issueById(server.deps.db, workspaceId, child.id),
    ]);
    expect(p?.subIssues).toEqual([
      { id: child.id, number: child.number, title: "Child", status: "reviewing" },
    ]);
    expect(p?.debates.map((d) => d.title).sort()).toEqual(["In general", "Linked", "Opened from it"]);
    expect(c?.debates.map((d) => d.title)).toEqual(["Unrelated"]);
    expect(c?.work).toBeNull();
    expect(c?.source).toBeNull();
    expect(await toIssues(server.deps.db, workspaceId, [])).toEqual([]);
  });
});

describe("the end of an agent's work", () => {
  test("only an issue still working for the same message is settled", async () => {
    const message = async (meta: Record<string, unknown>) => {
      const id = newId("msg");
      await server.deps.db.insert(messages).values({
        id,
        workspaceId,
        channelId: general,
        authorKind: "person",
        authorId: ana.user.id,
        body: "Can you do it?",
        meta,
      });
      return id;
    };
    const working = await createIssue(server.deps, { workspaceId, title: "Working", author: person(ana) });
    const askedAgain = await createIssue(server.deps, {
      workspaceId,
      title: "Asked again",
      author: person(ana),
    });
    const idle = await createIssue(server.deps, { workspaceId, title: "Idle", author: person(ana) });
    const m1 = await message({ workedIssue: { issueId: working.id, number: working.number } });
    const m2 = await message({ workedIssue: { issueId: askedAgain.id, number: askedAgain.number } });
    const m3 = await message({ workedIssue: { issueId: idle.id, number: idle.number } });
    const plain = await message({ other: true });
    const set = (id: string, work: (typeof issues.$inferInsert)["work"]) =>
      server.deps.db.update(issues).set({ work }).where(eq(issues.id, id));
    await set(working.id, { state: "working", reason: null, runId: null, messageId: m1 });
    // Asked again of another agent: the newer message owns the work now.
    await set(askedAgain.id, { state: "working", reason: null, runId: null, messageId: "msg_newer" });
    await set(idle.id, { state: "idle", reason: null, runId: "run_old", messageId: m3 });

    await settleIssueWork(server.deps.db, workspaceId, [m1, m2, m3, plain], {
      state: "blocked",
      reason: "budget",
      runId: "run_1",
    });
    const work = async (id: string) => (await issueById(server.deps.db, workspaceId, id)).work;
    expect(await work(working.id)).toEqual({
      state: "blocked",
      reason: "budget",
      runId: "run_1",
      messageId: m1,
    });
    expect(await work(askedAgain.id)).toEqual({
      state: "working",
      reason: null,
      runId: null,
      messageId: "msg_newer",
    });
    expect(await work(idle.id)).toEqual({ state: "idle", reason: null, runId: "run_old", messageId: m3 });
    // Another workspace's messages don't reach this one's issues.
    const { workspaceId: ws } = await freshWorkspace("Away");
    await set(working.id, { state: "working", reason: null, runId: null, messageId: m1 });
    await settleIssueWork(server.deps.db, ws, [m1], { state: "idle", reason: null, runId: "run_2" });
    expect((await work(working.id))?.state).toBe("working");
  });
});

/** The error's status, code and message (the message names the kind that wasn't found). */
const notFoundOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected an HttpError");
};

describe("what an issue points to", () => {
  test("creating with a channel, parent, column, assignee or source of another workspace is not found, and takes no number", async () => {
    const { owner: other, workspaceId: away, general: awayGeneral } = await freshWorkspace("Away2");
    const foreignIssue = await createIssue(server.deps, {
      workspaceId: away,
      title: "Theirs",
      author: person(other),
    });
    const [foreignColumn] = await columnsOf(server.deps.db, away);
    const foreignAgent = await newAgent(away, "theirs");
    const archived = await newAgent(workspaceId, "retired", true);
    const foreignDebate = newId("deb");
    await server.deps.db
      .insert(debates)
      .values({ id: foreignDebate, workspaceId: away, title: "Theirs", goal: "", createdBy: person(other) });
    const foreignMessage = newId("msg");
    await server.deps.db.insert(messages).values({
      id: foreignMessage,
      workspaceId: away,
      channelId: awayGeneral,
      authorKind: "person",
      authorId: other.user.id,
      body: "hi",
    });
    const base = { workspaceId, title: "Linked", author: person(ana) };
    const before = await createIssue(server.deps, { ...base, title: "Before" });
    const cases: [Parameters<typeof createIssue>[1], string][] = [
      [{ ...base, channelId: awayGeneral }, "Channel not found"],
      [{ ...base, parentId: foreignIssue.id }, "Issue not found"],
      [{ ...base, columnId: foreignColumn?.id }, "Column not found"],
      [{ ...base, assignee: person(other) }, "Member not found"],
      [{ ...base, assignee: { type: "agent", id: foreignAgent } }, "Agent not found"],
      [{ ...base, assignee: { type: "agent", id: archived } }, "Agent not found"],
      [{ ...base, assignee: { type: "agent", id: "agt_missing" } }, "Agent not found"],
      [{ ...base, source: { kind: "debate", id: foreignDebate } }, "Debate not found"],
      [{ ...base, source: { kind: "message", id: foreignMessage } }, "Message not found"],
      [{ ...base, source: { kind: "agent", id: foreignAgent } }, "Agent not found"],
    ];
    for (const [input, message] of cases)
      expect(await notFoundOf(createIssue(server.deps, input))).toEqual({
        status: 404,
        code: "not_found",
        message,
      });
    // Nothing was written: the next issue takes the number right after the one before the attempts.
    const after = await createIssue(server.deps, { ...base, title: "After" });
    expect(after.number).toBe(before.number + 1);
    // The same links inside the workspace are taken.
    const own = await createIssue(server.deps, {
      ...base,
      channelId: general,
      parentId: before.id,
      assignee: { type: "agent", id: await newAgent(workspaceId, "own") },
      source: { kind: "message", id: await ownMessage() },
    });
    expect([own.channelId, own.parentId]).toEqual([general, before.id]);
  });

  test("changing to a column, assignee or file of another workspace is not found and changes nothing", async () => {
    const { owner: other, workspaceId: away } = await freshWorkspace("Away3");
    const [foreignColumn] = await columnsOf(server.deps.db, away);
    const file = async (ws: string, deleted = false) => {
      const id = newId("file");
      await server.deps.db.insert(schema.files).values({
        id,
        workspaceId: ws,
        title: "Notes",
        kind: "document",
        createdBy: person(ana),
        updatedBy: person(ana),
        deletedAt: deleted ? new Date() : null,
      });
      return id;
    };
    const row = await createIssue(server.deps, { workspaceId, title: "Edited", author: person(ana) });
    const cases: [Parameters<typeof updateIssue>[2], string][] = [
      [{ columnId: foreignColumn?.id }, "Column not found"],
      [{ assignee: person(other) }, "Member not found"],
      [{ assignee: { type: "agent", id: await newAgent(away, "far") } }, "Agent not found"],
      [{ assignee: { type: "agent", id: await newAgent(workspaceId, "gone", true) } }, "Agent not found"],
      [{ fileIds: [await file(workspaceId), await file(away)] }, "File not found"],
      [{ fileIds: [await file(workspaceId, true)] }, "File not found"],
    ];
    for (const [change, message] of cases)
      expect(
        await notFoundOf(updateIssue(server.deps, row, { title: "Changed", ...change }, person(ana))),
      ).toEqual({
        status: 404,
        code: "not_found",
        message,
      });
    const same = await issueById(server.deps.db, workspaceId, row.id);
    expect([same.title, same.columnId, same.assignee, same.fileIds]).toEqual([
      "Edited",
      row.columnId,
      null,
      [],
    ]);
    expect((await timeline(row.id)).length).toBe(1);
    const mine = await file(workspaceId);
    expect(
      (await updateIssue(server.deps, row, { fileIds: [mine], assignee: person(beto) }, person(ana))).fileIds,
    ).toEqual([mine]);
  });
});

async function ownMessage(): Promise<string> {
  const id = newId("msg");
  await server.deps.db.insert(messages).values({
    id,
    workspaceId,
    channelId: general,
    authorKind: "person",
    authorId: ana.user.id,
    body: "make it an issue",
  });
  return id;
}

describe("positions on the board", () => {
  /** The column's issues from top to bottom, and whether their positions are all different. */
  const columnOf = async (columnId: string) => {
    const rows = await server.deps.db
      .select({ title: issues.title, position: issues.boardPosition })
      .from(issues)
      .where(eq(issues.columnId, columnId))
      .orderBy(asc(issues.boardPosition));
    return {
      titles: rows.map((r) => r.title),
      unique: new Set(rows.map((r) => r.position)).size === rows.length,
    };
  };

  test("a move into a full column goes on top, at the end or between two, and no position repeats", async () => {
    const { owner, workspaceId: ws } = await freshWorkspace("Moves");
    const cols = await columnsOf(server.deps.db, ws);
    const done = cols.find((c) => c.stage === "done")?.id ?? "";
    const by = person(owner);
    const make = (title: string, columnId?: string) =>
      createIssue(server.deps, { workspaceId: ws, title, columnId, author: by });
    // In "done", top to bottom: C, B, A (each new one goes on top).
    const a = await make("A", done);
    const b = await make("B", done);
    await make("C", done);
    const top = await make("Top");
    await updateIssue(server.deps, top, { columnId: done }, by);
    expect(await columnOf(done)).toEqual({ titles: ["Top", "C", "B", "A"], unique: true });
    const end = await make("End");
    await updateIssue(server.deps, end, { columnId: done, boardPosition: a.boardPosition + 1 }, by);
    expect(await columnOf(done)).toEqual({ titles: ["Top", "C", "B", "A", "End"], unique: true });
    const mid = await make("Mid");
    await updateIssue(
      server.deps,
      mid,
      { columnId: done, boardPosition: (a.boardPosition + b.boardPosition) / 2 },
      by,
    );
    expect(await columnOf(done)).toEqual({ titles: ["Top", "C", "B", "Mid", "A", "End"], unique: true });
    // Asking for a neighbor's exact position puts it right before that neighbor.
    const same = await make("Same");
    await updateIssue(server.deps, same, { columnId: done, boardPosition: b.boardPosition }, by);
    expect(await columnOf(done)).toEqual({
      titles: ["Top", "C", "Same", "B", "Mid", "A", "End"],
      unique: true,
    });
    // Moving inside the column (no column change) follows the same rule.
    await updateIssue(server.deps, top, { boardPosition: a.boardPosition + 0.5 }, by);
    expect((await columnOf(done)).titles).toEqual(["C", "Same", "B", "Mid", "A", "Top", "End"]);
    // Or by the card it goes under: between two, at the end, back on top; an issue that isn't in the column isn't found.
    const under = await make("Under");
    await updateIssue(server.deps, under, { columnId: done, after: b.id }, by);
    const last = await make("Last");
    const end2 = await issueById(server.deps.db, ws, end.id);
    await updateIssue(server.deps, last, { columnId: done, after: end2.id }, by);
    await updateIssue(server.deps, top, { after: null }, by);
    expect(await columnOf(done)).toEqual({
      titles: ["Top", "C", "Same", "B", "Under", "Mid", "A", "End", "Last"],
      unique: true,
    });
    const stray = await make("Stray");
    expect(
      await notFoundOf(updateIssue(server.deps, stray, { columnId: done, after: stray.id }, by)),
    ).toEqual({
      status: 404,
      code: "not_found",
      message: "Issue not found",
    });
  });
});
