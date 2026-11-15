// The screens the shell itself fills inside a workspace. The inbox, its preferences and the
// contents of the shell's own settings sections are not built yet.
import type { AreaModule } from "../../app/areas.ts";
import { HomeScreen } from "./Home.tsx";
import { SettingsScreen } from "./Settings.tsx";

export const screens: AreaModule<"shell">["screens"] = {
  home: HomeScreen,
  settings: SettingsScreen,
};
