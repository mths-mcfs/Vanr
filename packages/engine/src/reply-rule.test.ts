import { describe, expect, test } from "bun:test";
import { type AnswerInput, whoAnswers } from "./reply-rule";

const base: AnswerInput = {
  agentMentionIds: [],
  members: [
    { id: "lia", mode: "auto" },
    { id: "rui", mode: "mention" },
    { id: "eva", mode: "silent" },
  ],
  isDm: false,
  threadAgentIds: [],
  mutedAgentIds: [],
};

describe("who answers", () => {
  test("in a channel without a mention only the auto agent answers; with mentions, the mentioned ones minus the silent", () => {
    expect(whoAnswers(base)).toEqual({ ids: ["lia"], notInChannel: [], silenced: [], reason: "auto" });
    expect(whoAnswers({ ...base, agentMentionIds: ["rui", "eva", "zoe", "rui"] })).toEqual({
      ids: ["rui"],
      notInChannel: ["zoe"],
      silenced: ["eva"],
      reason: "mention",
    });
    expect(whoAnswers({ ...base, members: base.members.slice(1) }).reason).toBeNull();
  });

  test("in a thread, agents that already spoke carry on, except the ones muted there or silent in the channel", () => {
    const t = { ...base, threadAgentIds: ["rui", "eva", "lia"] };
    expect(whoAnswers(t)).toMatchObject({ ids: ["rui", "lia"], reason: "thread" });
    expect(whoAnswers({ ...t, mutedAgentIds: ["rui", "lia"] })).toMatchObject({ ids: [], reason: null });
    expect(whoAnswers({ ...t, mutedAgentIds: ["rui"], agentMentionIds: ["rui"] })).toMatchObject({
      ids: ["rui"],
      reason: "mention",
    });
  });

  test("in a DM the agent answers whatever its mode", () => {
    expect(whoAnswers({ ...base, isDm: true, members: [{ id: "eva", mode: "silent" }] })).toMatchObject({
      ids: ["eva"],
      reason: "dm",
    });
    // Silence is a channel setting: a mention in a DM still calls a silent agent.
    expect(
      whoAnswers({ ...base, isDm: true, members: [{ id: "eva", mode: "silent" }], agentMentionIds: ["eva"] }),
    ).toMatchObject({ ids: ["eva"], silenced: [], reason: "mention" });
  });
});
