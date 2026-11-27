// The files area: the Drive (with the trash and the preview of each file), the workspace's search and
// the bases, with each base's views and rows.
import "../../styles/files.css";
import type { AreaModule } from "../../app/areas.ts";
import { BaseScreen } from "./bases/Base.tsx";
import { BasesScreen } from "./bases/Bases.tsx";
import { RowScreen } from "./bases/Row.tsx";
import { DriveScreen } from "./drive/Drive.tsx";
import { SearchScreen } from "./search/Search.tsx";

export const screens: AreaModule<"files">["screens"] = {
  files: DriveScreen,
  search: SearchScreen,
  bases: BasesScreen,
  base: BaseScreen,
  baseRow: RowScreen,
};
