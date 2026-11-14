// Runners (the paired hosts agents work on), their pairing, the agent's environment and its network requests.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";
import { DesktopRelease, RunnerOutages } from "./shapes.ts";

export type ReduceRunnerAccessBody =
  | { removeFolder: { path: string; agentId?: string } }
  | { disableTool: "browser" | "claude" | "codex" | "commands" };

export const runners = {
  listRunners: e("GET", "/api/v1/workspaces/:workspaceId/runners", s.field("runners", s.array(C.Runner))),
  updateRunner: e(
    "PATCH",
    "/api/v1/workspaces/:workspaceId/runners/:runnerId",
    s.object({ id: s.string, name: s.string }),
  ).body<{ name: string }>(),
  deleteRunner: e("DELETE", "/api/v1/workspaces/:workspaceId/runners/:runnerId", NOTHING),
  revokeRunner: e("POST", "/api/v1/workspaces/:workspaceId/runners/:runnerId/revoke", C.Runner),
  reduceRunnerAccess: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/runners/:runnerId/access/reduce",
    // Older servers wrap it in `{ access }`; both come out as the access itself.
    s.union(s.field("access", C.RunnerAccess), C.RunnerAccess),
  ).body<ReduceRunnerAccessBody>(),
  moveRunnerAgents: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/runners/:runnerId/move-agents",
    C.MoveAgentsResult,
  ).body<{ toRunnerId: string; agentIds?: string[] }>(),
  listRunnerOutages: e("GET", "/api/v1/workspaces/:workspaceId/runners/outages", RunnerOutages),
  getRunnerPairing: e("GET", "/api/v1/runner-pairings/:pairingCode", C.RunnerPairing),
  confirmRunnerPairing: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/runner-pairings/:pairingCode/confirm",
    C.Runner,
  ).body<{ name?: string }>(),
  denyRunnerPairing: e("POST", "/api/v1/runner-pairings/:pairingCode/deny", NOTHING),
  /** null when there is no build for that target and architecture. */
  getDesktopReleaseLatest: e("GET", "/api/v1/desktop/releases/latest", DesktopRelease)
    .query<{ target: string; arch: string }>()
    .orNullOn(404),

  listSandboxSettings: e("GET", "/api/v1/workspaces/:workspaceId/sandbox-settings", C.SandboxSettings),
  setSandboxSettings: e("PUT", "/api/v1/workspaces/:workspaceId/sandbox-settings", C.SandboxSettings).body<
    Partial<T.SandboxSettings>
  >(),
  getAgentEnvironment: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/environment",
    C.AgentEnvironment,
  ),
  startAgentEnvironment: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/environment/start",
    C.AgentEnvironment,
  ),
  stopAgentEnvironment: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/environment/stop",
    C.AgentEnvironment,
  ),
  deleteAgentEnvironment: e("DELETE", "/api/v1/workspaces/:workspaceId/agents/:agentId/environment", NOTHING),
  /** `runnerId: null` moves the agent to the cloud sandbox. */
  setAgentEnvironmentTarget: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/environment/target",
    C.EnvironmentTarget,
  ).body<{ runnerId: string | null }>(),
  listAgentEnvironmentDomains: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/environment/domains",
    s.field("domains", s.array(C.NetworkRequest)),
  ),
  allowNetworkRequest: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/network-requests/:networkRequestId/allow",
    C.NetworkRequest,
  ),
  denyNetworkRequest: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/network-requests/:networkRequestId/deny",
    C.NetworkRequest,
  ),
  deleteNetworkRequest: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/network-requests/:networkRequestId",
    C.NetworkRequest,
  ),
};
