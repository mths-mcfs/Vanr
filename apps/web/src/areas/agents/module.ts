// The agents area: the team, the creation of an agent, its profile and memory, the workspace's skills,
// the runners (a settings section and a page each) and the pairing of a runner by code.
import "../../styles/agents.css";
import type { AreaModule } from "../../app/areas.ts";
import { MemoryScreen } from "./Memory.tsx";
import { NewAgentScreen } from "./NewAgent.tsx";
import { PairingScreen } from "./Pairing.tsx";
import { ProfileScreen } from "./Profile.tsx";
import { RunnerScreen, RunnersSection } from "./Runners.tsx";
import { SkillsScreen } from "./Skills.tsx";
import { TeamScreen } from "./Team.tsx";

export const screens: AreaModule<"agents">["screens"] = {
  agents: TeamScreen,
  agentNew: NewAgentScreen,
  agent: ProfileScreen,
  skills: SkillsScreen,
  agentMemory: MemoryScreen,
  runner: RunnerScreen,
  runnerPairing: PairingScreen,
};

export const settings: AreaModule<"agents">["settings"] = {
  runners: RunnersSection,
};
