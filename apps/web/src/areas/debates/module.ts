// The debates area: the list of debates with their numbers, starting one, and one debate's page.
import "../../styles/debates.css";
import type { AreaModule } from "../../app/areas.ts";
import { DebateScreen } from "./Debate.tsx";
import { DebatesScreen } from "./Debates.tsx";

export const screens: AreaModule<"debates">["screens"] = {
  debates: DebatesScreen,
  debate: DebateScreen,
};
