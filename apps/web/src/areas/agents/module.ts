// The agents area: the team, the creation of an agent, its profile and the workspace's skills. The
// memory page, the runners and the pairing of a runner come with the runners part of the area.
import "../../styles/agents.css";
import type { AreaModule } from "../../app/areas.ts";
import { NewAgentScreen } from "./NewAgent.tsx";
import { ProfileScreen } from "./Profile.tsx";
import { SkillsScreen } from "./Skills.tsx";
import { TeamScreen } from "./Team.tsx";

export const screens: AreaModule<"agents">["screens"] = {
  agents: TeamScreen,
  agentNew: NewAgentScreen,
  agent: ProfileScreen,
  skills: SkillsScreen,
};
