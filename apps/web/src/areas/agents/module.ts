// The agents area. Only the team list is built: it is the worked example of how an area fills a
// reserved route (see src/routes.ts). The other agent routes still show the "not in this build" screen.
import type { AreaModule } from "../../app/areas.ts";
import { TeamScreen } from "./Team.tsx";

export const screens: AreaModule<"agents">["screens"] = {
  agents: TeamScreen,
};
