// The chat area: the conversations in the sidebar, and a channel or a direct message with a person or
// an agent, with the agents' runs drawn live and the control center's cards in place.
import "../../styles/chat.css";
import type { AreaModule } from "../../app/areas.ts";
import { ChannelScreen, DmAgentScreen, DmPersonScreen } from "./Conversation.tsx";
import { ChannelList } from "./Sidebar.tsx";

export const screens: AreaModule<"chat">["screens"] = {
  channel: ChannelScreen,
  dmPerson: DmPersonScreen,
  dmAgent: DmAgentScreen,
};

export const sidebarChannels = ChannelList;
