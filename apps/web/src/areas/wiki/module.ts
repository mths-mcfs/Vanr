// The wiki area: the index of the workspace's pages (tree, search, import, export and trash) and each
// page, with its live editor, properties, links and versions.
import "../../styles/wiki.css";
import type { AreaModule } from "../../app/areas.ts";
import { WikiIndexScreen } from "./index/WikiIndex.tsx";
import { WikiPageScreen } from "./page/Page.tsx";

export const screens: AreaModule<"wiki">["screens"] = {
  wiki: WikiIndexScreen,
  wikiPage: WikiPageScreen,
};
