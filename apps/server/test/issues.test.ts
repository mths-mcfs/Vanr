// The issue routes (routes/issues.ts): numbers per workspace, criteria, moving between stages, the timeline and
// the notices; the board's columns; who may call each route (a member of the workspace, never another one's);
// a short number of another workspace, missing or malformed answered the same; attachments the person can't
// open rejected; an agent assignee and "ask an agent" rejected at their entry while the runtime isn't there; and
// the routines subscribed to `issue.created` fired once per issue a person opens.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Issue, IssueActivity, IssueColumn } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { createFile } from "../src/drive";
import { columnsOf, createIssue } from "../src/issues";
import { BOARD_POSITION_MAX, COMMENT_FILES_MAX, ISSUE_LIST_LIMIT } from "../src/routes/issues";
import type { RunningServer } from "../src/server";
import {
  Browser,
  body,
  SERVER_TEST_MS,
  settle,
  signedIn,
  startTestServer,
  TestSocket,
  waitFor,
} from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@issues.test`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Board");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  return { workspaceId, general, ana, beto };
}

const call = async (
  who: Person | Browser,
  workspaceId: string,
  method: string,
  path: string,
  data?: unknown,
) => {
  const browser = who instanceof Browser ? who : who.browser;
  const res = await browser.json(`/api/v1/workspaces/${workspaceId}${path}`, method, data);
  return { status: res.status, json: await body(res) };
};
const ok = async <T>(p: ReturnType<typeof call>, status = 200): Promise<T> => {
  const res = await p;
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
};
const notices = async (who: Person, workspaceId: string) =>
  (
    await ok<{ items: { kind: string; source: unknown; latest: unknown }[] }>(
      call(who, workspaceId, "GET", "/notifications"),
    )
  ).items;

async function seedAgent(workspaceId: string, owner: Person, handle: string) {
  const id = newId("agt");
  await server.deps.db.insert(schema.agents).values({
    id,
    workspaceId,
    name: handle,
    handle,
    model: "claude-haiku-5-5",
    ownerUserId: owner.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  return id;
}

describe("issues", () => {
  test(
    "create with the workspace's number, criteria, move between stages, the timeline and the notices",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const cols = await ok<{ columns: IssueColumn[] }>(call(ana, workspaceId, "GET", "/issue-columns"));
      expect(cols.columns.map((c) => [c.stage, c.position, c.name])).toEqual([
        ["todo", 0, ""],
        ["in_progress", 1, ""],
        ["reviewing", 2, ""],
        ["done", 3, ""],
        ["canceled", 4, ""],
      ]);
      const one = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", {
          title: "Switch supplier",
          criteria: ["Get 3 quotes", "Approve with Ana"],
          priority: "high",
          assignee: { type: "person", id: beto.user.id },
          dueDate: "2026-11-01",
          labels: ["purchasing"],
        }),
        201,
      );
      const two = await ok<Issue>(
        call(beto, workspaceId, "POST", "/issues", { title: "Review contract" }),
        201,
      );
      expect([one.number, two.number]).toEqual([1, 2]);
      expect(one).toMatchObject({
        status: "todo",
        priority: "high",
        dueDate: "2026-11-01",
        criteria: [{ done: false }, { done: false }],
      });
      // Beto was made the assignee: a notice.
      await settle(server);
      const [assigned] = await notices(beto, workspaceId);
      expect(assigned).toMatchObject({ kind: "issue_ownership", source: { issueSeq: 1 } });

      const crit = one.criteria[0]?.id ?? "";
      const checked = await ok<Issue>(
        call(beto, workspaceId, "PUT", `/issues/${one.id}/criteria/${crit}`, { done: true }),
      );
      expect(checked.criteria[0]?.done).toBe(true);
      expect(
        (await call(beto, workspaceId, "PUT", `/issues/${one.id}/criteria/nope`, { done: true })).status,
      ).toBe(404);

      const doing = cols.columns.find((c) => c.stage === "in_progress")?.id ?? "";
      const moved = await ok<Issue>(
        call(beto, workspaceId, "PATCH", `/issues/${one.id}`, {
          columnId: doing,
          title: "Switch the parts supplier",
        }),
      );
      expect(moved).toMatchObject({ status: "in_progress", title: "Switch the parts supplier" });
      // Ana opened it: she gets the change of stage.
      await settle(server);
      const status = (await notices(ana, workspaceId)).find((x) => x.kind === "issue_progress");
      expect(status?.latest).toMatchObject({ previousStatus: "todo", newStatus: "in_progress" });

      const c1 = await ok<IssueActivity>(
        call(ana, workspaceId, "POST", `/issues/${one.id}/comments`, { text: "Two quotes in" }),
        201,
      );
      expect(c1).toMatchObject({ kind: "comment", text: "Two quotes in" });
      await settle(server);
      expect((await notices(beto, workspaceId)).some((x) => x.kind === "issue_discussion")).toBe(true);
      const { activity } = await ok<{ activity: IssueActivity[] }>(
        call(ana, workspaceId, "GET", `/issues/${one.id}/activity`),
      );
      expect(activity.map((a) => a.event ?? a.kind)).toEqual([
        "created",
        "criterion_done",
        "title",
        "status",
        "comment",
      ]);
      expect(activity[3]).toMatchObject({
        textKey: "issues.activity.status",
        textVars: { from: "todo", to: "in_progress" },
      });

      expect((await ok<Issue>(call(ana, workspaceId, "GET", "/issues/seq/2"))).id).toBe(two.id);
      expect((await call(ana, workspaceId, "GET", "/issues/seq/99")).status).toBe(404);
      const list = async (q?: string) =>
        (
          await ok<{ issues: Issue[] }>(
            call(ana, workspaceId, "GET", `/issues${q ? `?q=${encodeURIComponent(q)}` : ""}`),
          )
        ).issues.map((i) => i.number);
      expect(await list("contract")).toEqual([2]);
      expect(await list("#1")).toEqual([1]);
      expect((await list()).length).toBe(2);
    },
    SERVER_TEST_MS,
  );

  test(
    "columns: add to a stage, reorder, rename and delete moving the issues",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const ws = await TestSocket.open(beto.browser, workspaceId);
      try {
        const cols = (await ok<{ columns: IssueColumn[] }>(call(ana, workspaceId, "GET", "/issue-columns")))
          .columns;
        const todo = cols[0]?.id ?? "";
        const added = (
          await ok<{ columns: IssueColumn[] }>(
            call(ana, workspaceId, "POST", "/issue-columns", { name: "Blocked", stage: "in_progress" }),
          )
        ).columns;
        expect(added.map((c) => c.name || c.stage)).toEqual([
          "todo",
          "in_progress",
          "Blocked",
          "reviewing",
          "done",
          "canceled",
        ]);
        const frame = await ws.event("issue_column.list_updated");
        expect((frame.event.columns as unknown[]).length).toBe(6);
        const blocked = added[2]?.id ?? "";
        // A column can't go "after" one of another stage.
        const wrongStage = await call(ana, workspaceId, "POST", "/issue-columns", {
          name: "X",
          stage: "done",
          afterId: todo,
        });
        expect(wrongStage.json.error.code).toBe("issue.column_stage");
        const reordered = await ok<{ columns: IssueColumn[] }>(
          call(ana, workspaceId, "PATCH", `/issue-columns/${blocked}`, { index: 0, name: "Stuck" }),
        );
        // It only moves inside its stage: first of in_progress, not before todo.
        expect(reordered.columns.map((c) => c.name || c.stage)).toEqual([
          "todo",
          "Stuck",
          "in_progress",
          "reviewing",
          "done",
          "canceled",
        ]);

        const issue = await ok<Issue>(
          call(ana, workspaceId, "POST", "/issues", { title: "Waiting for a part", columnId: blocked }),
          201,
        );
        const del = (id: string, moveTo: string) =>
          call(ana, workspaceId, "DELETE", `/issue-columns/${id}?moveTo=${encodeURIComponent(moveTo)}`);
        expect((await del(todo, todo)).json.error.code).toBe("issue.column_move_to");
        expect((await del(todo, blocked)).json.error.code).toBe("issue.column_last_of_stage");
        const after = await ok<{ columns: IssueColumn[] }>(del(blocked, todo));
        expect(after.columns.length).toBe(5);
        expect((await ok<Issue>(call(ana, workspaceId, "GET", `/issues/seq/${issue.number}`))).status).toBe(
          "todo",
        );
      } finally {
        ws.ws.close();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "deleting a column puts its issues under the target's cards, in their order, with positions that don't repeat",
    async () => {
      const { workspaceId, ana } = await team();
      const cols = (await ok<{ columns: IssueColumn[] }>(call(ana, workspaceId, "GET", "/issue-columns")))
        .columns;
      const done = cols.find((c) => c.stage === "done")?.id ?? "";
      const extra = (
        await ok<{ columns: IssueColumn[] }>(
          call(ana, workspaceId, "POST", "/issue-columns", { name: "Shipped", stage: "done" }),
        )
      ).columns.find((c) => c.name === "Shipped")?.id;
      if (!extra) throw new Error("no column");
      const by = { type: "person" as const, id: ana.user.id };
      for (const title of ["D1", "D2"])
        await createIssue(server.deps, { workspaceId, title, columnId: done, author: by });
      for (const title of ["S1", "S2"])
        await createIssue(server.deps, { workspaceId, title, columnId: extra, author: by });
      await ok(call(ana, workspaceId, "DELETE", `/issue-columns/${extra}?moveTo=${done}`));
      const rows = await server.deps.db
        .select({ title: schema.issues.title, p: schema.issues.boardPosition })
        .from(schema.issues)
        .where(eq(schema.issues.columnId, done));
      rows.sort((a, b) => a.p - b.p);
      // Each creation lands on top of its column, so D2 is above D1 and S2 above S1.
      expect(rows.map((r) => r.title)).toEqual(["D2", "D1", "S2", "S1"]);
      expect(new Set(rows.map((r) => r.p)).size).toBe(4);
    },
    SERVER_TEST_MS,
  );

  test(
    "columns added at the same time all land, each with its own position",
    async () => {
      const { workspaceId, ana } = await team();
      await ok(call(ana, workspaceId, "GET", "/issue-columns"));
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          call(ana, workspaceId, "POST", "/issue-columns", { name: `Lane ${i}`, stage: "in_progress" }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array.from({ length: N }, () => 200));
      const cols = (await ok<{ columns: IssueColumn[] }>(call(ana, workspaceId, "GET", "/issue-columns")))
        .columns;
      expect(cols.length).toBe(5 + N);
      expect(cols.map((c) => c.position)).toEqual(Array.from({ length: 5 + N }, (_, i) => i));
    },
    SERVER_TEST_MS,
  );

  test(
    "two criteria checked at the same time both stay checked, with one event each",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const issue = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "Many", criteria: ["a", "b", "c", "d"] }),
        201,
      );
      await Promise.all(
        issue.criteria.map((c, i) =>
          ok(
            call(i % 2 ? beto : ana, workspaceId, "PUT", `/issues/${issue.id}/criteria/${c.id}`, {
              done: true,
            }),
          ),
        ),
      );
      const now = await ok<Issue>(call(ana, workspaceId, "GET", `/issues/seq/${issue.number}`));
      expect(now.criteria.map((c) => c.done)).toEqual([true, true, true, true]);
      const { activity } = await ok<{ activity: IssueActivity[] }>(
        call(ana, workspaceId, "GET", `/issues/${issue.id}/activity`),
      );
      expect(activity.filter((a) => a.event === "criterion_done")).toHaveLength(4);
      // Checking one already checked again changes nothing.
      await ok(
        call(ana, workspaceId, "PUT", `/issues/${issue.id}/criteria/${issue.criteria[0]?.id}`, {
          done: true,
        }),
      );
      const again = await ok<{ activity: IssueActivity[] }>(
        call(ana, workspaceId, "GET", `/issues/${issue.id}/activity`),
      );
      expect(again.activity.filter((a) => a.event === "criterion_done")).toHaveLength(4);
    },
    SERVER_TEST_MS,
  );
});

describe("board positions", () => {
  test(
    "a position past the bound is refused, so moved cards never round onto one another",
    async () => {
      const { workspaceId, ana } = await team();
      const issue = await ok<{ id: string; number: number }>(
        call(ana, workspaceId, "POST", "/issues", { title: "Far" }),
        201,
      );
      const far = await call(ana, workspaceId, "PATCH", `/issues/${issue.id}`, { boardPosition: 2 ** 53 });
      expect(far.status).toBe(400);
      await ok(call(ana, workspaceId, "PATCH", `/issues/${issue.id}`, { boardPosition: BOARD_POSITION_MAX }));
    },
    SERVER_TEST_MS,
  );
});

describe("the list's limit", () => {
  test(
    "the list answers at most ISSUE_LIST_LIMIT issues",
    async () => {
      const { workspaceId, ana } = await team();
      const [todo] = await columnsOf(server.deps.db, workspaceId);
      const by = { type: "person" as const, id: ana.user.id };
      await server.deps.db.insert(schema.issues).values(
        Array.from({ length: ISSUE_LIST_LIMIT + 1 }, (_, i) => ({
          id: newId("iss"),
          workspaceId,
          number: i + 1,
          title: `Card ${i}`,
          columnId: todo?.id ?? "",
          boardPosition: i,
          createdBy: by,
        })),
      );
      const { issues } = await ok<{ issues: Issue[] }>(call(ana, workspaceId, "GET", "/issues"));
      expect(issues).toHaveLength(ISSUE_LIST_LIMIT);
    },
    SERVER_TEST_MS,
  );
});

describe("who may call", () => {
  test(
    "without a session 401; a non-member and another workspace's member 404, on every route",
    async () => {
      const { workspaceId, ana } = await team();
      const issue = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "Ours", criteria: ["x"] }),
        201,
      );
      const cols = (await ok<{ columns: IssueColumn[] }>(call(ana, workspaceId, "GET", "/issue-columns")))
        .columns;
      const col = cols[1]?.id ?? "";
      const routes: [string, string, unknown?][] = [
        ["GET", "/issues"],
        ["GET", `/issues/seq/${issue.number}`],
        ["POST", "/issues", { title: "Theirs" }],
        ["PATCH", `/issues/${issue.id}`, { title: "Theirs" }],
        ["PUT", `/issues/${issue.id}/criteria/${issue.criteria[0]?.id}`, { done: true }],
        ["GET", `/issues/${issue.id}/activity`],
        ["POST", `/issues/${issue.id}/comments`, { text: "hi" }],
        ["GET", "/issue-columns"],
        ["POST", "/issue-columns", { name: "X", stage: "todo" }],
        ["PATCH", `/issue-columns/${col}`, { name: "X" }],
        ["DELETE", `/issue-columns/${col}?moveTo=${cols[0]?.id}`],
      ];
      const stranger = await signedIn(server, "Zed", email("zed"));
      await seedWorkspace(server, stranger, "Elsewhere");
      const anonymous = new Browser(server.url);
      for (const [method, path, data] of routes) {
        expect([path, (await call(anonymous, workspaceId, method, path, data)).status]).toEqual([path, 401]);
        const res = await call(stranger, workspaceId, method, path, data);
        expect([path, res.status, res.json.error.code]).toEqual([path, 404, "not_found"]);
      }
      // Nothing changed.
      const still = await ok<Issue>(call(ana, workspaceId, "GET", `/issues/seq/${issue.number}`));
      expect([still.title, still.criteria[0]?.done]).toEqual(["Ours", false]);
      expect((await ok<{ issues: Issue[] }>(call(ana, workspaceId, "GET", "/issues"))).issues).toHaveLength(
        1,
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "an issue of another workspace, by id or by number, is the same 404 as one that doesn't exist",
    async () => {
      const { workspaceId, ana } = await team();
      const other = await signedIn(server, "Olga", email("olga"));
      const { workspaceId: theirs } = await seedWorkspace(server, other, "Theirs");
      const foreign = await ok<Issue>(call(other, theirs, "POST", "/issues", { title: "Secret" }), 201);
      const missing = { error: { code: "not_found", message: "Issue not found" } };
      for (const seq of [
        String(foreign.number),
        "999999",
        "abc",
        "0",
        "-1",
        "1.5",
        "01",
        "1e3",
        "99999999999",
        // Ten digits pass the shape but are above the integer the number is stored in.
        "9999999999",
        "2147483648",
      ]) {
        const res = await call(ana, workspaceId, "GET", `/issues/seq/${seq}`);
        expect([seq, res.status, res.json]).toEqual([seq, 404, missing]);
      }
      for (const [method, path, data] of [
        ["PATCH", `/issues/${foreign.id}`, { title: "Mine" }],
        ["GET", `/issues/${foreign.id}/activity`],
        ["POST", `/issues/${foreign.id}/comments`, { text: "hi" }],
      ] as const) {
        const res = await call(ana, workspaceId, method, path, data);
        expect([path, res.status, res.json]).toEqual([path, 404, missing]);
      }
      expect((await ok<Issue>(call(other, theirs, "GET", `/issues/seq/${foreign.number}`))).title).toBe(
        "Secret",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "a column, assignee or channel of another workspace is rejected and creates nothing",
    async () => {
      const { workspaceId, ana } = await team();
      const other = await signedIn(server, "Olga", email("olga"));
      const { workspaceId: theirs, general: theirChannel } = await seedWorkspace(server, other, "Theirs");
      const [theirColumn] = (
        await ok<{ columns: IssueColumn[] }>(call(other, theirs, "GET", "/issue-columns"))
      ).columns;
      const rejected = [
        { title: "x", columnId: theirColumn?.id },
        { title: "x", assignee: { type: "person", id: other.user.id } },
        { title: "x", channelId: theirChannel },
      ];
      for (const data of rejected)
        expect((await call(ana, workspaceId, "POST", "/issues", data)).status).toBe(404);
      expect((await ok<{ issues: Issue[] }>(call(ana, workspaceId, "GET", "/issues"))).issues).toEqual([]);
      const mine = await ok<Issue>(call(ana, workspaceId, "POST", "/issues", { title: "Mine" }), 201);
      expect(
        (await call(ana, workspaceId, "PATCH", `/issues/${mine.id}`, { columnId: theirColumn?.id })).status,
      ).toBe(404);
    },
    SERVER_TEST_MS,
  );

  test(
    "a body with an unknown field or a wrong type is 400 and writes nothing",
    async () => {
      const { workspaceId, ana } = await team();
      for (const data of [
        { title: "" },
        { title: "x", rank: 1 },
        { title: "x", priority: "asap" },
        { title: 3 },
      ]) {
        expect((await call(ana, workspaceId, "POST", "/issues", data)).status).toBe(400);
      }
      expect((await ok<{ issues: Issue[] }>(call(ana, workspaceId, "GET", "/issues"))).issues).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("comment attachments", () => {
  test(
    "a file of another workspace, a missing one or one the person can't open is rejected and nothing is posted",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const issue = await ok<Issue>(call(ana, workspaceId, "POST", "/issues", { title: "With files" }), 201);
      const file = async (ws: string, owner: Person, title: string, channelId: string | null = null) =>
        (
          await createFile(server.deps, {
            workspaceId: ws,
            title,
            author: { type: "person", id: owner.user.id },
            channelId,
            content: { kind: "document", markdown: title },
          })
        ).row.id;
      const shared = await file(workspaceId, ana, "Shared");
      const other = await signedIn(server, "Olga", email("olga"));
      const { workspaceId: theirs } = await seedWorkspace(server, other, "Theirs");
      const foreign = await file(theirs, other, "Foreign");
      // A file of a private channel Beto isn't in.
      const room = await seedChannel(server, workspaceId, {
        name: "board-room",
        visibility: "private",
        members: [ana],
      });
      const anasOnly = await file(workspaceId, ana, "Private", room);
      for (const ids of [[foreign], ["file_missing"], [shared, anasOnly]]) {
        const res = await call(beto, workspaceId, "POST", `/issues/${issue.id}/comments`, {
          text: "see attached",
          attachedFileIds: ids,
        });
        expect([ids, res.status]).toEqual([ids, 404]);
      }
      expect(
        (
          await call(ana, workspaceId, "POST", `/issues/${issue.id}/comments`, {
            text: "too many",
            attachedFileIds: Array.from({ length: COMMENT_FILES_MAX + 1 }, (_, i) => `file_${i}`),
          })
        ).status,
      ).toBe(400);
      const posted = await ok<IssueActivity>(
        call(beto, workspaceId, "POST", `/issues/${issue.id}/comments`, {
          text: "see attached",
          attachedFileIds: [shared, shared],
        }),
        201,
      );
      expect(posted.attachments).toEqual([shared]);
      const { activity } = await ok<{ activity: IssueActivity[] }>(
        call(ana, workspaceId, "GET", `/issues/${issue.id}/activity`),
      );
      expect(activity.filter((a) => a.kind === "comment")).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );
});

describe("asking an agent", () => {
  const issueOf = (who: Person, workspaceId: string, number: number) =>
    ok<Issue>(call(who, workspaceId, "GET", `/issues/seq/${number}`));
  const dmWith = async (workspaceId: string, agentId: string) => {
    const [dm] = await server.deps.db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .innerJoin(schema.channelMemberships, eq(schema.channelMemberships.channelId, schema.channels.id))
      .where(
        and(
          eq(schema.channels.workspaceId, workspaceId),
          eq(schema.channels.kind, "dm"),
          eq(schema.channelMemberships.memberId, agentId),
        ),
      );
    if (!dm) throw new Error("no DM");
    return dm.id;
  };
  /** Waits until the agent has a run on the air. */
  const running = async (workspaceId: string, who: Person, agentId: string) => {
    await waitFor(async () => {
      const { runs } = await ok<{ runs: { agentId: string; status: string }[] }>(
        call(who, workspaceId, "GET", "/active-runs"),
      );
      return runs.some((r) => r.agentId === agentId && r.status === "running");
    });
  };

  test(
    "the agent becomes the assignee, the issue goes in progress and the request reaches its DM",
    async () => {
      const { workspaceId, ana } = await team();
      const lia = await seedAgent(workspaceId, ana, "lia");
      const issue = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "Write the FAQ", criteria: ["5 questions"] }),
        201,
      );
      const started = await ok<Issue>(
        call(ana, workspaceId, "POST", `/issues/${issue.id}/ask-agent`, { agentId: lia }),
      );
      expect(started).toMatchObject({
        status: "in_progress",
        assignee: { type: "agent", id: lia },
        work: { state: "working" },
      });
      await settle(server);
      const dm = await dmWith(workspaceId, lia);
      const msgs = await server.deps.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.channelId, dm))
        .orderBy(schema.messages.createdAt);
      expect(msgs[0]?.meta.workedIssue).toEqual({ issueId: issue.id, number: issue.number });
      expect([msgs.at(-1)?.authorKind, msgs.at(-1)?.authorId]).toEqual(["agent", lia]);
      // The run that served the request ended: the issue leaves "working" and keeps which run it was.
      const done = await issueOf(ana, workspaceId, issue.number);
      expect(done.work).toMatchObject({ state: "idle", reason: null });
      expect(done.work?.runId).toMatch(/^run_/);
      const nope = await call(ana, workspaceId, "POST", `/issues/${issue.id}/ask-agent`, {
        agentId: "agt_nope",
      });
      expect(nope.status).toBe(404);
    },
    SERVER_TEST_MS,
  );

  test(
    "an agent out of budget: the issue is blocked with the reason, not working",
    async () => {
      const { workspaceId, ana } = await team();
      const lia = await seedAgent(workspaceId, ana, "lia");
      await server.deps.db
        .update(schema.agents)
        .set({ budgetPerMonthUsd: 0 })
        .where(eq(schema.agents.id, lia));
      const issue = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "Write the FAQ" }),
        201,
      );
      // The answer already says it: the routing blocked the work before the route answered.
      expect(
        await ok<Issue>(call(ana, workspaceId, "POST", `/issues/${issue.id}/ask-agent`, { agentId: lia })),
      ).toMatchObject({ work: { state: "blocked", reason: "budget" } });
      await settle(server);
      expect((await issueOf(ana, workspaceId, issue.number)).work).toMatchObject({
        state: "blocked",
        reason: "budget",
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "asked work: a message mid-run, the request asked again of another agent and a server that fell",
    async () => {
      const { workspaceId, ana } = await team();
      const lia = await seedAgent(workspaceId, ana, `lia${n}`);
      const leo = await seedAgent(workspaceId, ana, `leo${n}`);
      const workOf = async (number: number) => (await issueOf(ana, workspaceId, number)).work;
      const ask = (id: string, agentId: string) =>
        ok<Issue>(call(ana, workspaceId, "POST", `/issues/${id}/ask-agent`, { agentId }));

      // A new message mid-run: the request was already answered and the issue leaves "working".
      const a = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "[[slow:400]] Write the FAQ" }),
        201,
      );
      await ask(a.id, lia);
      await running(workspaceId, ana, lia);
      const dm = await dmWith(workspaceId, lia);
      await ok(
        call(ana, workspaceId, "POST", `/channels/${dm}/messages`, {
          body: "and the returns too",
          clientId: "mid",
        }),
        201,
      );
      await settle(server);
      expect(await workOf(a.number)).toMatchObject({ state: "idle", reason: null });

      // Asked again of Leo while Lia still runs: the end of Lia's run doesn't close Leo's work.
      const b = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "[[slow:400]] Check the prices" }),
        201,
      );
      await ask(b.id, lia);
      await running(workspaceId, ana, lia);
      await ok(
        call(ana, workspaceId, "PATCH", `/issues/${b.id}`, { title: "[[slow:600]] Check the prices" }),
      );
      await ask(b.id, leo);
      await waitFor(async () => !server.deps.runtime.isBusy(lia));
      expect(await workOf(b.number)).toMatchObject({ state: "working" });
      await settle(server);
      const [leoRun] = await server.deps.db.select().from(schema.runs).where(eq(schema.runs.agentId, leo));
      expect(await workOf(b.number)).toEqual({ state: "idle", reason: null, runId: leoRun?.id ?? "" });

      // The server comes back with the run in the middle: the issue is blocked, not working forever.
      const c = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "[[slow:500]] Plan the week" }),
        201,
      );
      await ask(c.id, lia);
      await running(workspaceId, ana, lia);
      await server.runtime.start();
      expect(await workOf(c.number)).toMatchObject({ state: "blocked", reason: "interrupted" });
      await settle(server);
    },
    SERVER_TEST_MS,
  );

  test(
    "a boot that fails before it settles the fallen runs' work leaves those runs to the next boot",
    async () => {
      const { workspaceId, ana } = await team();
      const lia = await seedAgent(workspaceId, ana, `lia${n}`);
      const issue = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "[[slow:500]] Count the stock" }),
        201,
      );
      await ok<Issue>(call(ana, workspaceId, "POST", `/issues/${issue.id}/ask-agent`, { agentId: lia }));
      await running(workspaceId, ana, lia);
      // The server comes back with the run in the middle, and the first boot falls on the issue's write.
      const real = server.deps.db;
      server.deps.db = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "update") return typeof value === "function" ? value.bind(target) : value;
          return (table: unknown) => {
            if (table === schema.issues) throw new Error("boot fell");
            return target.update(table as typeof schema.issues);
          };
        },
      });
      try {
        await expect(server.runtime.start()).rejects.toThrow("boot fell");
      } finally {
        server.deps.db = real;
      }
      await server.runtime.start();
      expect((await issueOf(ana, workspaceId, issue.number)).work).toMatchObject({
        state: "blocked",
        reason: "interrupted",
      });
      await settle(server);
    },
    SERVER_TEST_MS,
  );

  test(
    "asked work whose routing fails after a run took the message: the run serves it, the issue isn't blocked",
    async () => {
      const own = await startTestServer({
        runtime: (port) => ({
          ...port,
          onPersonMessage: async (input) => {
            await port.onPersonMessage(input);
            throw new Error("routing fell after the run opened");
          },
        }),
      });
      try {
        const ana = await signedIn(own, "Ana", email("ana"));
        const { workspaceId } = await seedWorkspace(own, ana, "Board");
        const lia = newId("agt");
        await own.deps.db.insert(schema.agents).values({
          id: lia,
          workspaceId,
          name: "Lia",
          handle: "lia",
          model: "claude-haiku-5-5",
          ownerUserId: ana.user.id,
          appearance: { color: "blue", eyes: "dot", adornment: "none" },
        });
        const path = (p: string) => `/api/v1/workspaces/${workspaceId}${p}`;
        const issue = await body(await ana.browser.json(path("/issues"), "POST", { title: "Plan the week" }));
        const asked = await body(
          await ana.browser.json(path(`/issues/${issue.id}/ask-agent`), "POST", { agentId: lia }),
        );
        expect(asked.work.state === "blocked").toBe(false);
        await own.deps.runtime.settle();
        const [run] = await own.deps.db.select().from(schema.runs).where(eq(schema.runs.agentId, lia));
        const [row] = await own.deps.db.select().from(schema.issues).where(eq(schema.issues.id, issue.id));
        expect([run?.status, row?.work]).toMatchObject([
          "done",
          { state: "idle", reason: null, runId: run?.id ?? "" },
        ]);
      } finally {
        await own.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "asked work whose routing fails: the issue is blocked, not left working with no run",
    async () => {
      const own = await startTestServer({
        runtime: (port) => ({
          ...port,
          onPersonMessage: async () => {
            throw new Error("routing down");
          },
        }),
      });
      try {
        const ana = await signedIn(own, "Ana", email("ana"));
        const { workspaceId } = await seedWorkspace(own, ana, "Board");
        const lia = newId("agt");
        await own.deps.db.insert(schema.agents).values({
          id: lia,
          workspaceId,
          name: "Lia",
          handle: "lia",
          model: "claude-haiku-5-5",
          ownerUserId: ana.user.id,
          appearance: { color: "blue", eyes: "dot", adornment: "none" },
        });
        const path = (p: string) => `/api/v1/workspaces/${workspaceId}${p}`;
        const issue = await body(await ana.browser.json(path("/issues"), "POST", { title: "Plan the week" }));
        const asked = await body(
          await ana.browser.json(path(`/issues/${issue.id}/ask-agent`), "POST", { agentId: lia }),
        );
        // The answer and the stored issue both say it: blocked, no run.
        expect(asked.work).toMatchObject({ state: "blocked", reason: "interrupted", runId: null });
        const [row] = await own.deps.db.select().from(schema.issues).where(eq(schema.issues.id, issue.id));
        expect(row?.work).toMatchObject({ state: "blocked", reason: "interrupted", runId: null });
      } finally {
        await own.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "asked work and the server shutting down in the middle (a deploy): the issue is blocked",
    async () => {
      const own = await startTestServer();
      try {
        const ana = await signedIn(own, "Ana", email("ana"));
        const { workspaceId } = await seedWorkspace(own, ana, "Board");
        const lia = newId("agt");
        await own.deps.db.insert(schema.agents).values({
          id: lia,
          workspaceId,
          name: "Lia",
          handle: "lia",
          model: "claude-haiku-5-5",
          ownerUserId: ana.user.id,
          appearance: { color: "blue", eyes: "dot", adornment: "none" },
        });
        const path = (p: string) => `/api/v1/workspaces/${workspaceId}${p}`;
        const issue = await body(
          await ana.browser.json(path("/issues"), "POST", { title: "[[slow:400]] Plan the week" }),
        );
        await ana.browser.json(path(`/issues/${issue.id}/ask-agent`), "POST", { agentId: lia });
        await waitFor(async () => own.deps.runtime.isBusy(lia));
        await own.runtime.stop();
        const [row] = await own.deps.db.select().from(schema.issues).where(eq(schema.issues.id, issue.id));
        expect(row?.work).toMatchObject({ state: "blocked", reason: "interrupted" });
      } finally {
        await own.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "creating with an agent that doesn't talk to the creator is rejected without leaving the issue created",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const lia = await seedAgent(workspaceId, ana, "lia");
      await server.deps.db
        .update(schema.agents)
        .set({ visibilityMode: "owner" })
        .where(eq(schema.agents.id, lia));
      const refused = await call(beto, workspaceId, "POST", "/issues", {
        title: "Write the FAQ",
        assignee: { type: "agent", id: lia },
      });
      expect(refused.status).toBe(403);
      expect((await ok<{ issues: Issue[] }>(call(beto, workspaceId, "GET", "/issues"))).issues).toEqual([]);
      // Whoever talks to the agent creates it and the agent starts at once.
      const created = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "FAQ", assignee: { type: "agent", id: lia } }),
        201,
      );
      expect(created).toMatchObject({ assignee: { type: "agent", id: lia }, work: { state: "working" } });
      await settle(server);
    },
    SERVER_TEST_MS,
  );
});

describe("routines on issue.created", () => {
  async function subscribed(workspaceId: string, owner: Person) {
    const agentId = await seedAgent(workspaceId, owner, `bot${++n}`);
    const id = newId("rtn");
    await server.deps.db.insert(schema.routines).values({
      id,
      workspaceId,
      name: "Triage",
      prompt: "Triage the new issue",
      agentId,
      target: { kind: "debate", agentIds: [agentId], roundLimit: 1 },
      trigger: { kind: "event", event: "issue.created" },
      createdBy: owner.user.id,
    });
    const fires = async () => {
      await settle(server);
      return server.deps.db
        .select({ key: schema.routineExecutions.dedupeKey, payload: schema.routineExecutions.payload })
        .from(schema.routineExecutions)
        .where(eq(schema.routineExecutions.routineId, id));
    };
    const stop = () =>
      server.deps.db.update(schema.routines).set({ active: false }).where(eq(schema.routines.id, id));
    return { fires, stop };
  }

  test(
    "an issue a person opens fires the subscribed routine once, with the issue as its context",
    async () => {
      const { workspaceId, ana } = await team();
      const routine = await subscribed(workspaceId, ana);
      const issue = await ok<Issue>(
        call(ana, workspaceId, "POST", "/issues", { title: "Broken login", description: "Since Monday" }),
        201,
      );
      expect(await routine.fires()).toEqual([
        {
          key: `event:issue.created:${issue.id}`,
          payload: { text: "Issue #1: Broken login\n\nSince Monday" },
        },
      ]);
      await routine.stop();
    },
    SERVER_TEST_MS,
  );

  test(
    "an issue an agent opens doesn't fire; a creation that fails doesn't fire; two at once fire twice",
    async () => {
      const { workspaceId, ana } = await team();
      const routine = await subscribed(workspaceId, ana);
      const bot = await seedAgent(workspaceId, ana, `maker${++n}`);
      await createIssue(server.deps, {
        workspaceId,
        title: "From an agent",
        author: { type: "agent", id: bot },
      });
      expect(await routine.fires()).toEqual([]);
      const failed = await call(ana, workspaceId, "POST", "/issues", {
        title: "Bad",
        columnId: "col_missing",
      });
      expect(failed.status).toBe(404);
      expect(await routine.fires()).toEqual([]);
      const [a, b] = await Promise.all([
        ok<Issue>(call(ana, workspaceId, "POST", "/issues", { title: "A" }), 201),
        ok<Issue>(call(ana, workspaceId, "POST", "/issues", { title: "B" }), 201),
      ]);
      const keys = (await routine.fires()).map((f) => f.key).sort();
      expect(keys).toEqual([`event:issue.created:${a.id}`, `event:issue.created:${b.id}`].sort());
      await routine.stop();
    },
    SERVER_TEST_MS,
  );
});
