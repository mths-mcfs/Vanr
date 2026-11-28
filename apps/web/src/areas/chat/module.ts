// The chat area: the conversations in the sidebar, and a channel or a direct message with a person or
// an agent, with the agents' runs drawn live and the control center's cards in place; threads beside a
// channel or on their own page, and the list of every thread.
import "../../styles/chat.css";
import type { AreaModule } from "../../app/areas.ts";
import { ChannelScreen, DmAgentScreen, DmPersonScreen } from "./Conversation.tsx";
import { ChannelList } from "./Sidebar.tsx";
import { ThreadScreen } from "./Thread.tsx";
import { ThreadsScreen } from "./Threads.tsx";

export const screens: AreaModule<"chat">["screens"] = {
  channel: ChannelScreen,
  dmPerson: DmPersonScreen,
  dmAgent: DmAgentScreen,
  threads: ThreadsScreen,
  thread: ThreadScreen,
};

export const sidebarChannels = ChannelList;
