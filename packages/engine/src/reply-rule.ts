// Who answers a message in a conversation. A pure rule, so the server's routing and the composer's
// "who answers" hint can share it; it has no database or runtime dependency.
//
// An agent's mode in each channel: `mention` (the default) answers an @mention, in a DM and in a thread it
// already spoke in; `auto` also answers without a mention; `silent` does not speak in the channel, even when
// mentioned. In a thread, an agent muted there does not carry on without a mention (a mention still calls it).

export const ANSWER_MODES = ["mention", "auto", "silent"] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];

export interface AnswerInput {
  /** Mentioned agents, in the order of the text. */
  agentMentionIds: readonly string[];
  isDm: boolean;
  /** Agent members of the channel (or the DM), each with its mode. */
  members: readonly { id: string; mode: AnswerMode }[];
  /** Agents muted in the thread. */
  mutedAgentIds: readonly string[];
  /** Agents that already wrote in the thread (empty outside a thread). */
  threadAgentIds: readonly string[];
}

export interface AnswerPick {
  /** Who answers, without repeats, in order: the mentioned ones, else the thread's or the channel's. */
  ids: string[];
  /** Mentioned agents that are not in the conversation. */
  notInChannel: string[];
  /** Why they answer: a mention, a DM, a thread they already spoke in, or auto mode; null when nobody does. */
  reason: "auto" | "dm" | "mention" | "thread" | null;
  /** Mentioned agents that are silent in this channel. */
  silenced: string[];
}

export function whoAnswers(input: AnswerInput): AnswerPick {
  const modes = new Map(input.members.map((m) => [m.id, m.mode]));
  const muted = new Set(input.mutedAgentIds);
  const pick: AnswerPick = { ids: [], notInChannel: [], silenced: [], reason: null };
  const add = (id: string) => {
    if (!pick.ids.includes(id)) pick.ids.push(id);
  };
  const done = (reason: AnswerPick["reason"]): AnswerPick => {
    pick.reason = pick.ids.length > 0 ? reason : null;
    return pick;
  };
  if (input.agentMentionIds.length > 0) {
    for (const id of input.agentMentionIds) {
      const mode = modes.get(id);
      if (mode === undefined) pick.notInChannel.push(id);
      else if (mode === "silent" && !input.isDm) pick.silenced.push(id);
      else add(id);
    }
    return done("mention");
  }
  if (input.isDm) {
    for (const m of input.members) add(m.id);
    return done("dm");
  }
  const speaks = (id: string) => !muted.has(id) && modes.has(id) && modes.get(id) !== "silent";
  if (input.threadAgentIds.length > 0) {
    for (const id of input.threadAgentIds) if (speaks(id)) add(id);
    return done("thread");
  }
  for (const m of input.members) if (m.mode === "auto" && speaks(m.id)) add(m.id);
  return done("auto");
}
