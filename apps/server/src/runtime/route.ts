// Who answers a person's message. Pure rule, tested without a database.
//
// 1. Mentions of agents rule: each mentioned agent answers (if it is in the channel or the DM).
// 2. No mention: in a DM with an agent, it answers; in a thread, the agents that already spoke
//    in it answer (the conversation goes on); otherwise, the channel's agents with `autoAnswer`.
// 3. Visibility filters at the end: whoever is outside it gets the `run.agent_unavailable` notice, for them alone.
//    An agent whose harness runs on a personal plan (Claude Code/Codex on a paired runner) only talks to
//    whoever paired the runner, whatever the visibility: the subscription is for personal use.

export interface RouteAgent {
  id: string;
  ownerUserId: string;
  visibilityMode: "everyone" | "people" | "owner";
  audienceUserIds: string[];
  /** Who paired the runner of the agent whose harness runs on the plan (null: it runs through the API). */
  planOwnerUserId: string | null;
}

export interface RouteInput {
  authorUserId: string;
  /** Agents mentioned by @handle, archived ones already removed. */
  mentioned: RouteAgent[];
  /** Agent members of the channel (or of the DM), with `autoAnswer`. */
  inChannel: { agent: RouteAgent; autoAnswer: boolean }[];
  isDm: boolean;
  /** Agents that already wrote in this message's thread (empty outside a thread). */
  threadAgentIds: string[];
}

export type BlockReason = TalkBlock | "not_in_channel";

export interface RouteResult {
  targets: RouteAgent[];
  blocked: { agent: RouteAgent; reason: BlockReason }[];
}

export type TalkBlock = "personal_plan" | "audience";

function inAudience(agent: RouteAgent, userId: string): boolean {
  switch (agent.visibilityMode) {
    case "everyone":
      return true;
    case "owner":
      return agent.ownerUserId === userId;
    case "people":
      return agent.ownerUserId === userId || agent.audienceUserIds.includes(userId);
    default: {
      const _exhaustive: never = agent.visibilityMode;
      return _exhaustive;
    }
  }
}

/** Why the person does not talk to the agent (null: they do). The personal plan wins over the visibility. */
export function talkBlock(agent: RouteAgent, userId: string): TalkBlock | null {
  if (agent.planOwnerUserId !== null) return agent.planOwnerUserId === userId ? null : "personal_plan";
  return inAudience(agent, userId) ? null : "audience";
}

export const canTalkTo = (agent: RouteAgent, userId: string): boolean => talkBlock(agent, userId) === null;

export function route(input: RouteInput): RouteResult {
  const members = new Map(input.inChannel.map((m) => [m.agent.id, m]));
  const blocked: RouteResult["blocked"] = [];
  let candidates: RouteAgent[];
  if (input.mentioned.length > 0) {
    candidates = [];
    for (const agent of input.mentioned) {
      if (members.has(agent.id)) candidates.push(agent);
      else blocked.push({ agent, reason: "not_in_channel" });
    }
  } else if (input.isDm) {
    candidates = input.inChannel.map((m) => m.agent);
  } else if (input.threadAgentIds.length > 0) {
    candidates = input.threadAgentIds.flatMap((id) => {
      const m = members.get(id);
      return m ? [m.agent] : [];
    });
  } else {
    candidates = input.inChannel.filter((m) => m.autoAnswer).map((m) => m.agent);
  }
  const targets: RouteAgent[] = [];
  const seen = new Set<string>();
  for (const agent of candidates) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    const block = talkBlock(agent, input.authorUserId);
    if (block) blocked.push({ agent, reason: block });
    else targets.push(agent);
  }
  return { targets, blocked };
}

/** "pare", "stop", "cancela"... alone in the message (mentions aside) stop the run instead of joining it (Portuguese and English words). */
const STOP_RE = /^(?:para|pare|parar|stop|cancel|cancela|cancelar|chega)[\s.!]*$/i;

export function isStopRequest(body: string): boolean {
  const withoutMentions = body.replace(/@[a-z0-9][a-z0-9_-]{1,31}/gi, "").trim();
  return STOP_RE.test(withoutMentions);
}
