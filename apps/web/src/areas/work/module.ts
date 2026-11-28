// The work area: the issues (a board and a list) and one issue's page.
import "../../styles/work.css";
import type { AreaModule } from "../../app/areas.ts";
import { IssueScreen } from "./issues/Issue.tsx";
import { IssuesScreen } from "./issues/Issues.tsx";

export const screens: AreaModule<"work">["screens"] = {
  issues: IssuesScreen,
  issue: IssueScreen,
};
