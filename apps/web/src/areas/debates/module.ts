// The debates area: the list of debates with their numbers, and starting one.
import "../../styles/debates.css";
import type { AreaModule } from "../../app/areas.ts";
import { DebatesScreen } from "./Debates.tsx";

export const screens: AreaModule<"debates">["screens"] = {
  debates: DebatesScreen,
};
