// The control center's pure text: the line diff of a proposal, the server's codes in the interface
// language with the server's own text when a code is unknown, and the time left to decide.
import { describe, expect, test } from "bun:test";
import type { Approval } from "@vanr/contract";
import { formatMessage } from "../../i18n/format.ts";
import en from "../../messages/control/en.ts";
import {
  allowanceFor,
  approvalTitle,
  type Lookup,
  lineDiff,
  ruleText,
  timeLeft,
  trailText,
} from "./format.ts";

const lookup: Lookup = (key, params) => {
  const message = (en as Record<string, Parameters<typeof formatMessage>[0]>)[key];
  return message === undefined ? undefined : formatMessage(message, params, "en");
};

describe("the line diff", () => {
  test("keeps the common lines and marks what went out and what came in", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });

  test("an empty side is all added or all removed", () => {
    expect(lineDiff("", "x\ny")).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
    expect(lineDiff("x", "")).toEqual([{ kind: "del", text: "x" }]);
    expect(lineDiff("", "")).toEqual([]);
  });

  test("a text too long to compare line by line is all out, then all in", () => {
    // A line both sides share: compared line by line it would stay "same".
    const before = ["shared", ...Array.from({ length: 600 }, (_, i) => `old ${i}`)].join("\n");
    const after = ["shared", ...Array.from({ length: 600 }, (_, i) => `new ${i}`)].join("\n");
    const diff = lineDiff(before, after);
    expect(diff.length).toBe(1202);
    expect(diff[0]).toEqual({ kind: "del", text: "shared" });
    expect(diff[601]).toEqual({ kind: "add", text: "shared" });
    expect(diff.some((line) => line.kind === "same")).toBe(false);
  });
});

describe("text from the server's codes", () => {
  const approval = (tool: string, params: Record<string, unknown>) =>
    ({ tool, params, title: "Server title" }) as unknown as Approval;

  test("a known tool gets its own title, with a list of addresses joined", () => {
    expect(approvalTitle(approval("post_message", { channel: "#sales" }), lookup)).toBe("Post in #sales");
    expect(approvalTitle(approval("send_email", { to: ["a@x.example", "b@x.example"] }), lookup)).toBe(
      "Server title",
    );
  });

  test("the rule of a known tool, and of any other one", () => {
    expect(ruleText("post_message", "#sales", lookup)).toBe("Posts in #sales");
    expect(ruleText("run_command", "npm test", lookup)).toBe("run_command: npm test");
  });

  test("a trail step reads in the interface language; an unknown code keeps the server's text", () => {
    expect(
      trailText({ at: "", code: "approved", params: { name: "Ana" }, text: "x" }, "approval", lookup),
    ).toBe("Approved by Ana");
    expect(trailText({ at: "", text: "Something new" }, "proposal", lookup)).toBe("Something new");
  });

  test("the approve button says what happens", () => {
    expect(allowanceFor("post_message")).toBe("send");
    expect(allowanceFor("send_email")).toBe("send");
    expect(allowanceFor("github_merge")).toBe("merge");
    expect(allowanceFor("vercel_deploy")).toBe("ship");
    expect(allowanceFor("run_command")).toBe("anything");
  });

  test("time left: hours above one, whole minutes under it, never zero", () => {
    const now = Date.UTC(2026, 10, 14, 12);
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(timeLeft(at(3 * 3_600_000 + 5), now, "en")).toBe("3 hr");
    expect(timeLeft(at(12 * 60_000 - 1), now, "en")).toBe("12 min");
    expect(timeLeft(at(-5), now, "en")).toBe("1 min");
  });
});
