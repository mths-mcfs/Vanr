// Who is at work: the agents with a run in progress. The list of runs is the client's
// `listActiveRuns`, which the run events keep fresh; the names come from `listAgents`.
import type { Agent, WorkingRun } from "@vanr/contract";

/** The agents that have a run in progress, in the order of the agent list; archived ones left out. */
export function agentsAtWork(agents: readonly Agent[], runs: readonly WorkingRun[]): Agent[] {
  const busy = new Set(runs.map((run) => run.agentId));
  return agents.filter((agent) => busy.has(agent.id) && agent.archivedAt === null);
}
