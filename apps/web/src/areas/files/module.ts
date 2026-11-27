// The files area: the Drive (with the trash and the preview of each file) and the workspace's search.
import "../../styles/files.css";
import type { AreaModule } from "../../app/areas.ts";
import { DriveScreen } from "./drive/Drive.tsx";
import { SearchScreen } from "./search/Search.tsx";

export const screens: AreaModule<"files">["screens"] = {
  files: DriveScreen,
  search: SearchScreen,
};
