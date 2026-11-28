// The work area: the issues (a board and a list) and one issue's page, the weekly calendar, the routines,
// and the assignments with one assignment's page.
import "../../styles/work.css";
import type { AreaModule } from "../../app/areas.ts";
import { AssignmentScreen } from "./assignments/Assignment.tsx";
import { AssignmentsScreen } from "./assignments/Assignments.tsx";
import { CalendarScreen } from "./calendar/Calendar.tsx";
import { IssueScreen } from "./issues/Issue.tsx";
import { IssuesScreen } from "./issues/Issues.tsx";
import { RoutinesScreen } from "./routines/Routines.tsx";

export const screens: AreaModule<"work">["screens"] = {
  issues: IssuesScreen,
  issue: IssueScreen,
  calendar: CalendarScreen,
  routines: RoutinesScreen,
  assignments: AssignmentsScreen,
  assignment: AssignmentScreen,
};
