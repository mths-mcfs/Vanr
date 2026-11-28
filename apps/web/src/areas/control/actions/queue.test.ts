// What a receipt offers for one action: undo while the window is open, redo after an undo, nothing for a
// post canceled in the send queue, and only to whoever the server lets undo.
import { describe, expect, test } from "bun:test";
import type { AgentAction } from "@vanr/contract";
import { mayUndo, offer, queueOf } from "./queue.ts";

const NOW = Date.UTC(2026, 10, 14, 12);
const at = (ms: number) => new Date(NOW + ms).toISOString();
const action = (fields: Partial<AgentAction> = {}): AgentAction => ({
  id: "act_1",
  agentId: "agt_scout",
  createdAt: at(-1000),
  kind: "message_posted",
  messageId: "msg_1",
  params: {},
  requesterUserId: "usr_iris",
  revertedAt: null,
  reverterUserId: null,
  revertibleUntil: at(3_600_000),
  target: { id: "msg_2", title: "#sales", type: "message" },
  ...fields,
});
const queued = (fields: Partial<AgentAction> = {}) =>
  action({
    target: { id: "out_1", title: "#sales", type: "outbox" },
    params: { sendAt: at(20_000) },
    ...fields,
  });

describe("the send queue", () => {
  test("a post waiting for its window counts down; once due it is sending", () => {
    expect(queueOf(queued(), NOW)).toMatchObject({ queued: true, sending: false, canceled: false });
    expect(queueOf(queued(), NOW + 21_000)).toMatchObject({ queued: false, sending: true });
    expect(queueOf(action(), NOW)).toBeNull();
  });

  test("undone in the window is canceled; a failed send says why", () => {
    expect(queueOf(queued({ revertedAt: at(0) }), NOW)).toMatchObject({ canceled: true, queued: false });
    expect(queueOf(queued({ params: { sendAt: at(-1), failed: "quota" } }), NOW)).toMatchObject({
      failed: "quota",
      sending: false,
    });
  });
});

describe("what the receipt offers", () => {
  test("undo while open, redo after an undo, nothing once the window closed", () => {
    expect(offer(action(), NOW, true)).toBe("undo");
    expect(offer(action({ revertedAt: at(0) }), NOW, true)).toBe("redo");
    expect(offer(action({ revertibleUntil: at(-1) }), NOW, true)).toBeNull();
    expect(offer(action({ revertibleUntil: null }), NOW, true)).toBeNull();
  });

  test("a post canceled in the queue has nothing to redo", () => {
    expect(offer(queued(), NOW, true)).toBe("undo");
    expect(offer(queued({ revertedAt: at(0) }), NOW, true)).toBeNull();
  });

  test("only whoever asked, the agent's owner or someone who manages agents", () => {
    expect(mayUndo(action(), { userId: "usr_iris", role: "member" }, "usr_ana")).toBe(true);
    expect(mayUndo(action(), { userId: "usr_ana", role: "member" }, "usr_ana")).toBe(true);
    expect(mayUndo(action(), { userId: "usr_jonas", role: "admin" }, "usr_ana")).toBe(true);
    expect(mayUndo(action(), { userId: "usr_tomas", role: "member" }, "usr_ana")).toBe(false);
    expect(offer(action(), NOW, false)).toBeNull();
  });
});
