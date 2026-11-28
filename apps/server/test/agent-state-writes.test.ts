// Every place in the server that writes an agent's own state (its row, its memory and instructions, its environment,
// its grants, its standing rules, its accounts), found by what it writes, not by the route it sits under. Each one says
// how an archived agent is kept from it. A new write anywhere (a helper, a route in any family) fails this test until
// it is placed here, so the router test's families aren't the only net.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");
const TABLES = [
  "agents",
  "memories",
  "memoryVersions",
  "instructionVersions",
  "agentEnvironments",
  "agentGrants",
  "approvalRules",
  "connections",
];
const WRITE = new RegExp(`\\.(update|insert|delete)\\(\\s*(?:schema\\.)?(${TABLES.join("|")})\\s*\\)`, "g");
/**
 * What a write sits in: a top-level function or const, a class method, and inside a `register*` function a route
 * (method and path) or a helper arrow next to the routes (`const setStatus = async (`).
 */
const TOP: { re: RegExp; name: (m: RegExpExecArray) => string }[] = [
  { re: /^(?:export )?(?:async )?function (\w+)/, name: (m) => m[1] ?? "" },
  { re: /^const (\w+) = /, name: (m) => m[1] ?? "" },
  { re: /^ {2}(?:private |public )?(?:async )?(\w+)\(.*\{$/, name: (m) => m[1] ?? "" },
];
const IN_REGISTER: { re: RegExp; name: (m: RegExpExecArray) => string }[] = [
  {
    re: /^\s*app\.(get|post|put|patch|delete)\(\s*`\$\{WORKSPACE\}([^`]*)`/,
    name: (m) => `${(m[1] ?? "").toUpperCase()} ${m[2]}`,
  },
  { re: /^ {2}const (\w+) = (?:async )?\(\s*$/, name: (m) => m[1] ?? "" },
];

function writesInSource(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts"))
        files.push(path);
    }
  };
  walk(SRC);
  const found = new Set<string>();
  for (const file of files) {
    let top = "(module)";
    let owner = top;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const ownerIn = (list: typeof TOP) => {
        for (const { re, name } of list) {
          const m = re.exec(line);
          if (m) return name(m);
        }
        return null;
      };
      const t = ownerIn(TOP);
      if (t) top = owner = t;
      else if (top.startsWith("register")) owner = ownerIn(IN_REGISTER) ?? owner;
      for (const m of line.matchAll(WRITE)) found.add(`${relative(SRC, file)} ${owner}: ${m[1]}(${m[2]})`);
    }
  }
  return [...found].sort();
}

/**
 * `locked`: under the agent's row lock, refusing an archived agent (`lockActiveAgent`, or the archive itself).
 * `guarded`: under `/agents/:agentId`, which refuses an archived agent before the route runs (agent-guards).
 * `ends`: only takes away or stops, open on purpose. `creates`: a new agent. `books`: counters and bookkeeping.
 */
type How =
  | { locked: string }
  | { guarded: string }
  | { ends: string }
  | { creates: string }
  | { books: string };

const WRITES: Record<string, How> = {
  "agent-memory.ts changeMemory: update(memories)": { locked: "lockActiveAgent for an agent's store" },
  "agent-memory.ts createMemory: insert(memories)": { locked: "lockActiveAgent for an agent's store" },
  "agent-memory.ts insertVersion: insert(memoryVersions)": {
    locked: "only from createMemory and changeMemory",
  },
  "agent-memory.ts initialInstructions: insert(instructionVersions)": {
    creates: "the first version of a new agent",
  },
  "agent-memory.ts writeInstructions: insert(instructionVersions)": {
    locked: "agent row FOR UPDATE, archived refused",
  },
  "agent-memory.ts writeInstructions: update(agents)": { locked: "agent row FOR UPDATE, archived refused" },
  "agent-memory.ts memoryPrompt: update(memories)": { books: "use counters of the memories a run read" },
  "control.ts archiveAgent: update(agents)": { locked: "the archive itself, agent row FOR UPDATE" },
  "memory-consolidation.ts applyConsolidation: update(memories)": { locked: "lockActiveAgent first" },
  "integrations/access.ts replaceGrants: delete(agentGrants)": {
    guarded: "PUT /agents/:agentId/scopes and creation",
  },
  "integrations/access.ts replaceGrants: insert(agentGrants)": {
    guarded: "PUT /agents/:agentId/scopes and creation",
  },
  "integrations/connectors.ts connectCustom: delete(connections)": {
    books: "a workspace connector's failed setup",
  },
  "integrations/connectors.ts connectCustom: insert(connections)": { books: "a workspace connector" },
  "integrations/connectors.ts connectWithKey: insert(connections)": {
    guarded: "an agent's account only from POST /agents/:agentId/identity/connections",
  },
  "integrations/connectors.ts disconnectAll: delete(agentGrants)": { ends: "disconnects" },
  "integrations/connectors.ts disconnectAll: update(connections)": { ends: "disconnects" },
  "integrations/connectors.ts finishOAuth: delete(connections)": { ends: "drops an unfinished account" },
  "integrations/connectors.ts finishOAuth: update(connections)": {
    locked: "an agent's account is refused when its owner is archived (connectors.ts)",
  },
  "integrations/connectors.ts liveSecret: update(connections)": { books: "a refreshed token" },
  "integrations/connectors.ts markNeedsReconnect: update(connections)": { ends: "marks a broken account" },
  "integrations/connectors.ts pendingConnection: insert(connections)": {
    guarded: "an agent's account only from POST /agents/:agentId/identity/connections",
  },
  "integrations/connectors.ts requestScope: update(connections)": { books: "a workspace connection's scope" },
  "integrations/connectors.ts saveCustomTools: update(connections)": {
    books: "a workspace connector's tools",
  },
  "integrations/connectors.ts saveDiscoveredTools: update(connections)": {
    books: "a workspace connector's tools",
  },
  "integrations/connectors.ts startCatalogOAuth: delete(connections)": {
    ends: "drops an unfinished account",
  },
  "routes/agents.ts DELETE /credentials/:credentialId: update(agents)": {
    ends: "takes a revoked credential away",
  },
  "routes/agents.ts PATCH /agents/:agentId: update(agents)": { guarded: "the archived-agent guard" },
  "routes/agents.ts POST /agents: insert(agentGrants)": { creates: "a new agent's grants" },
  "routes/agents.ts POST /agents: insert(agents)": { creates: "a new agent" },
  "routes/agents.ts PUT /agents/:agentId/runtime: update(agents)": { guarded: "the archived-agent guard" },
  "routes/assignments.ts PUT /agents/:agentId/assignment-command-approval: update(agents)": {
    guarded: "the archived-agent guard",
  },
  "routes/connectors.ts PUT /agents/:agentId/repositories: update(agents)": {
    guarded: "the archived-agent guard",
  },
  "routes/memories.ts POST /messages/:messageId/feedback: delete(memories)": {
    locked: "drops the lesson it just wrote through createMemory",
  },
  "routes/memories.ts POST /messages/:messageId/feedback: update(memories)": {
    locked: "the lesson it just wrote through createMemory",
  },
  "routes/runners.ts DELETE /runners/:runnerId: update(agents)": { ends: "takes a removed runner away" },
  "routes/runners.ts POST /runners/:runnerId/move-agents: update(agents)": {
    guarded: "moves only active agents",
  },
  "routes/runners.ts setAgentRunner: insert(agentEnvironments)": {
    locked: "agent row lock, lending refused",
  },
  "routes/runners.ts setAgentRunner: update(agents)": { locked: "agent row lock, lending refused" },
  "routes/runners.ts setStatus: insert(agentEnvironments)": { locked: "starting reads the agent FOR SHARE" },
  "runners/agent-tools.ts setEnvironment: insert(agentEnvironments)": { locked: "lockActiveAgent to start" },
  "runners/agent-tools.ts touch: update(agentEnvironments)": {
    books: "last use, from a tool runTool let through",
  },
  "runtime/runtime.ts notifyBudget: update(agents)": { books: "the month's budget notice" },
  "standing-rules.ts matchRule: update(approvalRules)": { books: "a rule's use counter" },
  "standing-rules.ts rememberRule: insert(approvalRules)": { locked: "inside the approval's agent lock" },
  "standing-rules.ts revokeRule: update(approvalRules)": { ends: "revokes" },
};

describe("writes to an agent's own state", () => {
  test("each one, found by what it writes, says how an archived agent is kept from it", () => {
    const found = writesInSource();
    expect(found.filter((k) => !(k in WRITES))).toEqual([]);
    expect(Object.keys(WRITES).filter((k) => !found.includes(k))).toEqual([]);
  });
});
