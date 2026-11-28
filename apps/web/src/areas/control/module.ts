// The control center: the approvals agents ask for, with the "always allow" rules and the gate's
// numbers, and the proposals they make to their instructions and the workspace's memory. The cards
// the conversation shows (a question, a missing connector permission, the receipt of what an agent
// changed) are in cards.ts. The settings sections it fills are the workspace's connections.
import "../../styles/control.css";
import "../../styles/connections.css";
import type { AreaModule } from "../../app/areas.ts";
import { ApprovalsScreen } from "./approvals/Approvals.tsx";
import { ConnectorsSection } from "./connections/Connectors.tsx";
import { ProposalsScreen } from "./proposals/Proposals.tsx";

export const screens: AreaModule<"control">["screens"] = {
  approvals: ApprovalsScreen,
  proposals: ProposalsScreen,
};

export const settings: AreaModule<"control">["settings"] = {
  connectors: ConnectorsSection,
};
