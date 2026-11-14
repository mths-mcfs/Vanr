// Agents and what belongs to them: harness, channels, runs, credentials, memories, undoable actions,
// skills and reminders.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";
import { AgentSkill, AgentUsage, UndoAllResult } from "./shapes.ts";

export interface CreateAgentBody {
  name: string;
  handle: string;
  role: T.AgentRole;
  instructions?: string;
  model?: string;
  ownerUserId?: string;
  audience?: T.AgentAudience;
  credentialId?: string | null;
  budgetPerMonthUsd?: number | null;
  appearance?: T.AgentAppearance;
  channelIds?: string[];
  advisor?: T.AgentAdvisor | null;
}

export type UpdateAgentBody = Partial<Omit<CreateAgentBody, "channelIds" | "handle">> & {
  /** Why the instructions changed (kept with the version). */
  instructionsReason?: string;
};

export interface CreateSkillBody {
  name: string;
  description?: string;
  body: string;
  autoGrantNewAgents?: boolean;
  sourceRunId?: string;
  shareFromPrivate?: boolean;
}

const ImportedFiles = s.array(s.object({ path: s.string, text: s.string }));
const Memories = s.field("memories", s.array(C.Memory));

export const agents = {
  listAgents: e("GET", "/api/v1/workspaces/:workspaceId/agents", s.field("agents", s.array(C.Agent))),
  getTeam: e("GET", "/api/v1/workspaces/:workspaceId/team", C.Team),
  createAgent: e("POST", "/api/v1/workspaces/:workspaceId/agents", C.Agent).body<CreateAgentBody>(),
  getAgent: e("GET", "/api/v1/workspaces/:workspaceId/agents/:agentId", C.AgentDetail),
  updateAgent: e("PATCH", "/api/v1/workspaces/:workspaceId/agents/:agentId", C.Agent).body<UpdateAgentBody>(),
  deleteAgent: e("DELETE", "/api/v1/workspaces/:workspaceId/agents/:agentId", NOTHING),
  createAgentImportGithub: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agent-imports/github",
    s.field("files", ImportedFiles),
  ).body<{ url: string }>(),
  listAgentInstructionVersions: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/instruction-versions",
    s.field("versions", s.array(C.InstructionVersion)),
  ),
  restoreAgentInstructionVersion: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/instruction-versions/:instructionVersionId/restore",
    C.InstructionVersion,
  ).body<{ reason?: string }>(),
  listAgentChannels: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/channels",
    s.field("channels", s.array(C.AgentChannel)),
  ),
  setAgentChannels: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/channels",
    s.field("channels", s.array(C.AgentChannel)),
  ).body<{ channels: { channelId: string; autoAnswer: boolean }[] }>(),
  getAgentRuntime: e("GET", "/api/v1/workspaces/:workspaceId/agents/:agentId/runtime", C.AgentHarness),
  setAgentRuntime: e("PUT", "/api/v1/workspaces/:workspaceId/agents/:agentId/runtime", C.AgentHarness).body<{
    harness: T.HarnessKind;
    model?: string;
    fallback?: boolean;
    agreeToPlanTerms?: boolean;
  }>(),
  getAgentInbox: e("GET", "/api/v1/workspaces/:workspaceId/agents/:agentId/inbox", C.AgentInbox).query<{
    limit?: number;
  }>(),

  listModels: e("GET", "/api/v1/models", s.object({ models: s.array(C.Model), defaultModel: s.string })),
  listCredentials: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/credentials",
    s.field("credentials", s.array(C.Credential)),
  ),
  createCredential: e("POST", "/api/v1/workspaces/:workspaceId/credentials", C.Credential).body<{
    label: string;
    provider: T.Credential["provider"];
    apiKey: string;
    /** The provider-side account and project the key is scoped to, when the provider has them. */
    providerAccount?: string;
    providerProject?: string;
  }>(),
  rotateCredential: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/credentials/:credentialId/rotate",
    C.Credential,
  ).body<{ apiKey: string }>(),
  deleteCredential: e("DELETE", "/api/v1/workspaces/:workspaceId/credentials/:credentialId", NOTHING).query<{
    /** Also deletes what was stored with the key instead of only revoking it. */
    purge?: boolean;
  }>(),
  getCredentialPlatform: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/credentials/platform",
    s.field("available", s.boolean),
  ),

  listRuns: e("GET", "/api/v1/workspaces/:workspaceId/runs", s.field("runs", s.array(C.Run))).query<{
    agentId?: string;
    limit?: number;
  }>(),
  getRun: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/runs/:runId",
    s.object({ run: C.Run, steps: s.array(C.RunStep) }),
  ),
  cancelRun: e("POST", "/api/v1/workspaces/:workspaceId/runs/:runId/cancel", NOTHING),
  /** null when the channel is gone. */
  listChannelActiveRuns: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/channels/:channelId/active-runs",
    s.field("runs", s.array(C.ActiveRun)),
  ).orNullOn(404),
  /** null for someone who may not see spending. */
  getUsage: e("GET", "/api/v1/workspaces/:workspaceId/usage", s.field("usage", s.array(AgentUsage))).orNullOn(
    403,
  ),

  listAgentMemories: e("GET", "/api/v1/workspaces/:workspaceId/agents/:agentId/memories", Memories).query<{
    about?: string;
  }>(),
  getMemoryMine: e("GET", "/api/v1/workspaces/:workspaceId/memories/mine", Memories),
  getMemoryWorkspace: e("GET", "/api/v1/workspaces/:workspaceId/memories/workspace", Memories),
  createMemory: e("POST", "/api/v1/workspaces/:workspaceId/memories", C.Memory).body<{
    scope: "person" | "workspace";
    path: string;
    text: string;
    reason?: string;
  }>(),
  updateMemory: e("PATCH", "/api/v1/workspaces/:workspaceId/memories/:memoryId", C.Memory).body<{
    text?: string;
    path?: string;
    /** The version the edit is based on; a different current one fails with `memory.changed`. */
    expectedSha256?: string;
    reason?: string;
  }>(),
  updateMemoryText: e("PATCH", "/api/v1/workspaces/:workspaceId/memories/:memoryId", C.Memory).body<{
    text: string;
  }>(),
  setMemoryPinned: e("PATCH", "/api/v1/workspaces/:workspaceId/memories/:memoryId", C.Memory).body<{
    pinned: boolean;
  }>(),
  setMemoryArchived: e("PATCH", "/api/v1/workspaces/:workspaceId/memories/:memoryId", C.Memory).body<{
    archived: boolean;
  }>(),
  revertMemory: e("POST", "/api/v1/workspaces/:workspaceId/memories/:memoryId/revert", C.Memory),
  listMemoryVersions: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/memories/:memoryId/versions",
    s.field("versions", s.array(C.MemoryVersion)),
  ),
  restoreMemoryVersion: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/memories/:memoryId/versions/:versionId/restore",
    C.Memory,
  ).body<{ reason?: string }>(),
  listMemoryReviews: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/memory-reviews",
    s.field("reviews", s.array(C.MemoryReview)),
  ).query<{ agentId?: string }>(),
  approveMemoryReview: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/memory-reviews/:memoryReviewId/approve",
    C.MemoryReview,
  ),
  rejectMemoryReview: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/memory-reviews/:memoryReviewId/reject",
    C.MemoryReview,
  ).body<{ note?: string }>(),

  undoAction: e("POST", "/api/v1/workspaces/:workspaceId/actions/:actionId/undo", C.AgentAction),
  redoAction: e("POST", "/api/v1/workspaces/:workspaceId/actions/:actionId/redo", C.AgentAction),
  undoMessageAction: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/messages/:messageId/actions/undo",
    UndoAllResult,
  ),

  listSkills: e("GET", "/api/v1/workspaces/:workspaceId/skills", s.field("skills", s.array(C.Skill))),
  getSkill: e("GET", "/api/v1/workspaces/:workspaceId/skills/:skillId", C.SkillDetail),
  createSkill: e("POST", "/api/v1/workspaces/:workspaceId/skills", C.SkillDetail).body<CreateSkillBody>(),
  importSkill: e("POST", "/api/v1/workspaces/:workspaceId/skills/import", C.SkillDetail).body<{
    url: string;
  }>(),
  updateSkill: e("PATCH", "/api/v1/workspaces/:workspaceId/skills/:skillId", C.SkillDetail).body<
    Partial<CreateSkillBody>
  >(),
  reimportSkill: e("POST", "/api/v1/workspaces/:workspaceId/skills/:skillId/reimport", C.SkillDetail),
  deleteSkill: e("DELETE", "/api/v1/workspaces/:workspaceId/skills/:skillId", NOTHING),
  getSkillSkillMd: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/skills/:skillId/skill-md",
    s.object({ name: s.string, markdown: s.string, files: ImportedFiles }),
  ),
  listAgentSkills: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/skills",
    s.field("skills", s.array(AgentSkill)),
  ),
  setAgentSkills: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/skills",
    s.field("skills", s.array(AgentSkill)),
  ).body<{ skills: { id: string; enabled: boolean }[] }>(),

  listReminders: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/reminders",
    s.field("reminders", s.array(C.Reminder)),
  ),
  createReminder: e("POST", "/api/v1/workspaces/:workspaceId/reminders", C.Reminder).body<{
    channelId: string;
    threadId?: string;
    agentId?: string;
    text: string;
    at: string;
  }>(),
  deleteReminder: e("DELETE", "/api/v1/workspaces/:workspaceId/reminders/:reminderId", C.Reminder),
};
