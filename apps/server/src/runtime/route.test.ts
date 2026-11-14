import { describe, expect, test } from "bun:test";
import { canTalkTo, isStopRequest, type RouteAgent, route } from "./route";

const agent = (id: string, over: Partial<RouteAgent> = {}): RouteAgent => ({
  id,
  ownerUserId: "owner",
  visibilityMode: "everyone",
  audienceUserIds: [],
  planOwnerUserId: null,
  ...over,
});
const lia = agent("lia");
const theo = agent("theo", { visibilityMode: "owner" });
const rui = agent("rui");
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("routing", () => {
  test("a mention rules; an agent outside the channel is blocked", () => {
    const r = route({
      authorUserId: "ana",
      mentioned: [lia, rui],
      inChannel: [{ agent: lia, autoAnswer: false }],
      isDm: false,
      threadAgentIds: [],
    });
    expect(ids(r.targets)).toEqual(["lia"]);
    expect(r.blocked.map((b) => [b.agent.id, b.reason])).toEqual([["rui", "not_in_channel"]]);
  });

  test("no mention: autoAnswer in the channel, follow-up in the thread, DM with an agent", () => {
    const inChannel = [
      { agent: lia, autoAnswer: true },
      { agent: rui, autoAnswer: false },
    ];
    const base = { authorUserId: "ana", mentioned: [], inChannel, isDm: false, threadAgentIds: [] };
    expect(ids(route(base).targets)).toEqual(["lia"]);
    expect(ids(route({ ...base, threadAgentIds: ["rui"] }).targets)).toEqual(["rui"]);
    expect(
      ids(route({ ...base, isDm: true, inChannel: [{ agent: rui, autoAnswer: false }] }).targets),
    ).toEqual(["rui"]);
  });

  test("visibility: owner and list of people", () => {
    const inChannel = [{ agent: theo, autoAnswer: false }];
    const r = route({ authorUserId: "ana", mentioned: [theo], inChannel, isDm: false, threadAgentIds: [] });
    expect(r.targets).toEqual([]);
    expect(r.blocked[0]?.reason).toBe("audience");
    const ok = route({
      authorUserId: "owner",
      mentioned: [theo],
      inChannel,
      isDm: false,
      threadAgentIds: [],
    });
    expect(ids(ok.targets)).toEqual(["theo"]);
    const people = agent("p", { visibilityMode: "people", audienceUserIds: ["ana"] });
    const r2 = route({
      authorUserId: "ana",
      mentioned: [people],
      inChannel: [{ agent: people, autoAnswer: false }],
      isDm: false,
      threadAgentIds: [],
    });
    expect(ids(r2.targets)).toEqual(["p"]);
  });

  test("personal plan: only whoever paired talks to the agent, whatever the visibility", () => {
    // Open visibility, but the agent's harness runs on Bia's plan: Ana is left out, even the agent's owner.
    const plan = agent("plan", { planOwnerUserId: "bia" });
    const inChannel = [{ agent: plan, autoAnswer: true }];
    const base = { mentioned: [plan], inChannel, isDm: false, threadAgentIds: [] };
    const ana = route({ ...base, authorUserId: "ana" });
    expect(ana.targets).toEqual([]);
    expect(ana.blocked.map((b) => [b.agent.id, b.reason])).toEqual([["plan", "personal_plan"]]);
    expect(route({ ...base, authorUserId: "owner" }).blocked[0]?.reason).toBe("personal_plan");
    expect(ids(route({ ...base, authorUserId: "bia" }).targets)).toEqual(["plan"]);
    // Without a mention (autoAnswer, DM, thread) the same applies.
    expect(route({ ...base, mentioned: [], authorUserId: "ana" }).blocked[0]?.reason).toBe("personal_plan");
    expect(route({ ...base, mentioned: [], isDm: true, authorUserId: "ana" }).targets).toEqual([]);
    // The plan also wins over a closed visibility: Bia talks even outside the list.
    const closed = agent("closed", { visibilityMode: "owner", planOwnerUserId: "bia" });
    expect(canTalkTo(closed, "bia")).toBe(true);
    expect(canTalkTo(closed, "owner")).toBe(false);
  });

  test("a repeated mention counts once", () => {
    const r = route({
      authorUserId: "ana",
      mentioned: [lia, lia],
      inChannel: [{ agent: lia, autoAnswer: true }],
      isDm: false,
      threadAgentIds: [],
    });
    expect(ids(r.targets)).toEqual(["lia"]);
  });

  test("stop request", () => {
    expect(isStopRequest("@lia pare")).toBe(true);
    expect(isStopRequest("stop!")).toBe(true);
    expect(isStopRequest("pare de usar vírgula")).toBe(false);
    expect(isStopRequest("@lia")).toBe(false);
  });
});
