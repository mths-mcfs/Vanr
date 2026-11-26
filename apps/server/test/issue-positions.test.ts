// Where issues land on the board at volume: thousands of moves to the same spot use up the halves between two
// positions many times over, and the column is renumbered each time without losing the order. It has a file of its
// own so the CI shards balance it by its time.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { asc, eq } from "drizzle-orm";
import { columnsOf, createIssue, issueById, updateIssue } from "../src/issues";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

const { issues } = schema;
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

test("2,000 issues dropped on the same spot get positions that all differ, in the order they were dropped", async () => {
  const owner = await signedIn(server, "Ana", "ana@spot.test");
  const { workspaceId: ws } = await seedWorkspace(server, owner, "Spot");
  const cols = await columnsOf(server.deps.db, ws);
  const todo = cols.find((c) => c.stage === "todo")?.id ?? "";
  const done = cols.find((c) => c.stage === "done")?.id ?? "";
  const by = { type: "person" as const, id: owner.user.id };
  await createIssue(server.deps, { workspaceId: ws, title: "Right", columnId: done, author: by });
  const left = await createIssue(server.deps, { workspaceId: ws, title: "Left", columnId: done, author: by });
  const n = 2000;
  // The cards waiting in "todo" are rows straight in the database: what is under test is where each one lands,
  // every time right under "Left".
  const waiting = Array.from({ length: n }, (_, i) => ({
    id: newId("iss"),
    workspaceId: ws,
    number: 100 + i,
    title: `Card ${i}`,
    columnId: todo,
    boardPosition: i,
    createdBy: by,
  }));
  for (let i = 0; i < n; i += 500) await server.deps.db.insert(issues).values(waiting.slice(i, i + 500));
  for (const card of waiting) {
    const row = await issueById(server.deps.db, ws, card.id);
    await updateIssue(server.deps, row, { columnId: done, after: left.id }, by);
  }
  const rows = await server.deps.db
    .select({ title: issues.title, position: issues.boardPosition })
    .from(issues)
    .where(eq(issues.columnId, done))
    .orderBy(asc(issues.boardPosition));
  expect(new Set(rows.map((r) => r.position)).size).toBe(n + 2);
  expect(rows.map((r) => r.title)).toEqual(["Left", ...waiting.map((c) => c.title).reverse(), "Right"]);
}, 300_000);
