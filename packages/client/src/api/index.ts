// Every endpoint of the API, by area. The method names come from the route table (`test/route-table.json`):
// verb plus resource, as the route's operationId.
import type { AnyEndpoint } from "../endpoint.ts";
import { account } from "./account.ts";
import { agentLab } from "./agent-lab.ts";
import { agents } from "./agents.ts";
import { assignments } from "./assignments.ts";
import { bases } from "./bases.ts";
import { chat } from "./chat.ts";
import { control } from "./control.ts";
import { debates } from "./debates.ts";
import { files } from "./files.ts";
import { integrations } from "./integrations.ts";
import { runners } from "./runners.ts";
import { wiki } from "./wiki.ts";
import { work } from "./work.ts";
import { workspaces } from "./workspaces.ts";

export const AREAS = {
  account,
  workspaces,
  chat,
  agents,
  agentLab,
  control,
  integrations,
  runners,
  files,
  wiki,
  debates,
  bases,
  assignments,
  work,
} as const;

export type Area = keyof typeof AREAS;

export const endpoints = {
  ...account,
  ...workspaces,
  ...chat,
  ...agents,
  ...agentLab,
  ...control,
  ...integrations,
  ...runners,
  ...files,
  ...wiki,
  ...debates,
  ...bases,
  ...assignments,
  ...work,
};

export type Endpoints = typeof endpoints;
export type MethodName = keyof Endpoints;

// Every entry is an endpoint (a typo in a builder chain would otherwise widen silently).
endpoints satisfies Record<string, AnyEndpoint>;
