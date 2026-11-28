// The work area: the issues (a board and a list) and one issue's page, the weekly calendar and the
// routines.
import "../../styles/work.css";
import type { AreaModule } from "../../app/areas.ts";
import { CalendarScreen } from "./calendar/Calendar.tsx";
import { IssueScreen } from "./issues/Issue.tsx";
import { IssuesScreen } from "./issues/Issues.tsx";
import { RoutinesScreen } from "./routines/Routines.tsx";

export const screens: AreaModule<"work">["screens"] = {
  issues: IssuesScreen,
  issue: IssueScreen,
  calendar: CalendarScreen,
  routines: RoutinesScreen,
};
