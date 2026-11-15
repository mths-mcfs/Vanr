// How the router finds an area's screens. Each area is one module, fetched on the first visit to
// any of its routes, so each area is its own chunk.
import type { ComponentType } from "react";
import type { Area, RouteId, RouteIdOf, SettingsSection } from "../routes.ts";
import { ROUTES, SETTINGS_SECTIONS } from "../routes.ts";

/** The screens an area has built, by route id. A route left out shows the "not in this build" screen. */
export type AreaScreens<A extends Area> = { readonly [Id in RouteIdOf<A>]?: ComponentType };

/** What `areas/<area>/module.ts` exports. */
export type AreaModule<A extends Area> = {
  readonly screens: AreaScreens<A>;
  /** Chat only: the list of channels and direct messages in the sidebar. */
  readonly sidebarChannels?: ComponentType;
  /** The settings sections the area fills (see SETTINGS_SECTIONS in src/routes.ts). */
  readonly settings?: { readonly [Section in SettingsSection]?: ComponentType };
};

const MODULES: { readonly [A in Area]: () => Promise<AreaModule<A>> } = {
  account: () => import("../areas/account/module.ts"),
  shell: () => import("../areas/shell/module.ts"),
  chat: () => import("../areas/chat/module.ts"),
  agents: () => import("../areas/agents/module.ts"),
  wiki: () => import("../areas/wiki/module.ts"),
  files: () => import("../areas/files/module.ts"),
  work: () => import("../areas/work/module.ts"),
  debates: () => import("../areas/debates/module.ts"),
  control: () => import("../areas/control/module.ts"),
};

/** The screen an area built for a route, or undefined when it has none yet. */
export async function loadScreen(id: RouteId): Promise<ComponentType | undefined> {
  const module: AreaModule<Area> = await MODULES[ROUTES[id].area]();
  const screens: Readonly<Partial<Record<RouteId, ComponentType>>> = module.screens;
  return screens[id];
}

/** The chat area's channel list, or undefined while chat has not built one. */
export async function loadSidebarChannels(): Promise<ComponentType | undefined> {
  return (await MODULES.chat()).sidebarChannels;
}

/** The content an area built for a settings section, or undefined when it has none yet. */
export async function loadSettingsSection(section: SettingsSection): Promise<ComponentType | undefined> {
  const module: AreaModule<Area> = await MODULES[SETTINGS_SECTIONS[section]]();
  return module.settings?.[section];
}
