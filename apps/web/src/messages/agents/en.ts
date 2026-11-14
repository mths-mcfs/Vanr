import type { Catalog } from "../../i18n/format.ts";

/** Agents and runners. `area.purpose` is shown on the routes of the area that are not built yet. */
export default {
  "area.purpose": "The agents of this workspace: what each one does, where it works and what it may touch.",
  "team.count": { one: "{count} agent in this workspace.", other: "{count} agents in this workspace." },
  "team.list": "Agents",
  "team.working": "Working",
  "team.idle": "Idle",
  "team.empty.title": "No agents yet",
  "team.empty.body": "An agent takes a role, joins channels and works alongside people.",
  "team.empty.action": "Add an agent",
  "team.failed": "The agents could not be loaded",
  "error.agent.archived": "This agent is archived.",
} as const satisfies Catalog;
