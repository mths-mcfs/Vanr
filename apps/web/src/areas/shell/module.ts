// The screens the shell itself fills inside a workspace: the start, the inbox and its preferences,
// the settings frame and the contents of the shell's own settings sections.
import type { AreaModule } from "../../app/areas.ts";
import { HomeScreen } from "./Home.tsx";
import { InboxScreen } from "./inbox/Inbox.tsx";
import { PreferencesScreen } from "./inbox/Preferences.tsx";
import { SettingsScreen } from "./Settings.tsx";
import { GeneralSection } from "./settings/General.tsx";
import { MembersSection } from "./settings/Members.tsx";
import { ProfileSection } from "./settings/Profile.tsx";
import { StorageSection } from "./settings/Storage.tsx";

export const screens: AreaModule<"shell">["screens"] = {
  home: HomeScreen,
  notifications: InboxScreen,
  notificationSettings: PreferencesScreen,
  settings: SettingsScreen,
};

export const settings: AreaModule<"shell">["settings"] = {
  general: GeneralSection,
  profile: ProfileSection,
  members: MembersSection,
  storage: StorageSection,
};
