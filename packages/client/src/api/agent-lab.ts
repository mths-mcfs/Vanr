// The agent lab: test cases, evaluations, drafts from a description and memory consolidation.
import * as C from "../contract-schemas.ts";
import { endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";

export interface TestCaseBody {
  input: string;
  mustInclude?: string[];
  mustNotInclude?: string[];
}

export const agentLab = {
  listAgentTestCases: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/test-cases",
    s.field("cases", s.array(C.AgentTestCase)),
  ),
  createAgentTestCase: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/test-cases",
    C.AgentTestCase,
  ).body<TestCaseBody>(),
  updateAgentTestCase: e(
    "PATCH",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/test-cases/:testCaseId",
    C.AgentTestCase,
  ).body<TestCaseBody>(),
  deleteAgentTestCase: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/test-cases/:testCaseId",
    NOTHING,
  ),
  createAgentEval: e("POST", "/api/v1/workspaces/:workspaceId/agents/:agentId/evals", C.AgentEval).body<
    { proposalId: string } | { instructions: string }
  >(),
  listAgentEvals: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/evals",
    s.field("evals", s.array(C.AgentEval)),
  ).query<{ proposalId?: string }>(),
  getAgentEval: e("GET", "/api/v1/workspaces/:workspaceId/agents/:agentId/evals/:evalId", C.AgentEval),
  createAgentDraft: e("POST", "/api/v1/workspaces/:workspaceId/agent-drafts", C.AgentDraft).body<{
    description: string;
  }>(),
  createAgentBuilder: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/builder",
    C.BuilderResult,
  ).body<{ description: string }>(),
  listAgentMemoryConsolidations: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/memory-consolidations",
    s.field("consolidations", s.array(C.MemoryConsolidation)),
  ),
  createAgentMemoryConsolidation: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/memory-consolidations",
    C.MemoryConsolidation,
  ),
  applyAgentMemoryConsolidation: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/memory-consolidations/:memoryConsolidationId/apply",
    C.MemoryConsolidation,
  ),
  discardAgentMemoryConsolidation: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/memory-consolidations/:memoryConsolidationId/discard",
    C.MemoryConsolidation,
  ),
  createRunSkillDraft: e("POST", "/api/v1/workspaces/:workspaceId/runs/:runId/skill-draft", C.SkillDraft),
};
