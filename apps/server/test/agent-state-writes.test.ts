// The writes to an agent's own state (its row, its memory and instructions, its environment, its grants, its standing
// rules, its accounts) in the server and the packages, found by what they write, not by the route they sit under:
// Drizzle's update/insert/delete on those tables (on one line or several) and raw SQL on them. Each one says how an
// archived agent is kept from it, so a new one (a helper, a route in any family) fails until it is placed here. It
// doesn't see a table renamed into another variable or passed to a helper as a parameter; none exists today.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");
const REPO = join(import.meta.dir, "../../..");
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
/** The same tables by their SQL names, for a write in raw SQL. */
const SQL_TABLES = TABLES.map((t) => t.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
/** A Drizzle write, its arguments on one line or several. */
const WRITE = new RegExp(
  `\\.(update|insert|delete)\\(\\s*(?:schema\\.)?(${TABLES.join("|")})\\s*,?\\s*\\)`,
  "g",
);
/**
 * A write in raw SQL: `insert into | update | delete from` on one of the tables, named in the text (bare, quoted or
 * with a schema, as `public.agents`) or interpolated as Drizzle's table (`${agents}`, `${schema.agents}`), followed by
 * a space, `(`, `;` or the end of the template.
 */
const RAW = new RegExp(
  `\\b(insert\\s+into|update|delete\\s+from)\\s+(?:\\$\\{\\s*(?:schema\\.)?(${TABLES.join("|")})\\s*\\}|(?:"?\\w+"?\\.)?"?(${SQL_TABLES.join("|")})"?)(?=[\\s(;\`]|$)`,
  "gi",
);
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

/**
 * Comments go blank (same length, newlines kept), read the way the language reads them: `//` and `/*` inside a
 * string or a template's text aren't comments, and what a template interpolates (`${...}`) is code again.
 */
function blankComments(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // What encloses the cursor: code (with its open braces), a template's text.
  const stack: ("code" | "template")[] = ["code"];
  const braces: number[] = [0];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (stack.at(-1) === "template") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        stack.pop();
        i++;
      } else if (c === "$" && next === "{") {
        stack.push("code");
        braces.push(0);
        i += 2;
      } else i++;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "`") {
      stack.push("template");
      i++;
    } else if (c === "\\") i += 2;
    else if (c === "{") {
      braces[braces.length - 1] = (braces.at(-1) ?? 0) + 1;
      i++;
    } else if (c === "}") {
      if ((braces.at(-1) ?? 0) === 0 && stack.length > 1) {
        stack.pop();
        braces.pop();
      } else braces[braces.length - 1] = (braces.at(-1) ?? 0) - 1;
      i++;
    } else i++;
  }
  return out.join("");
}

/**
 * What it scans: every `.ts` under apps/server/src and packages/(name)/src but tests, comments left out. What it
 * finds: Drizzle's `.update|insert|delete(table)` on those tables, whatever the line breaks, and raw SQL on them
 * (`RAW`). What it doesn't see: a table renamed into another variable, or passed to a helper as a parameter.
 */
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
  for (const pkg of readdirSync(join(REPO, "packages"))) {
    const src = join(REPO, "packages", pkg, "src");
    if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) walk(src);
  }
  const found = new Set<string>();
  for (const file of files) {
    const text = blankComments(readFileSync(file, "utf8"));
    const lines = text.split("\n");
    // The owner of each line, by the last function, const, method or route above it.
    const owners: string[] = [];
    let top = "(module)";
    let owner = top;
    for (const line of lines) {
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
      owners.push(owner);
    }
    const where = file.startsWith(SRC) ? relative(SRC, file) : relative(REPO, file);
    const lineOf = (at: number) => text.slice(0, at).split("\n").length - 1;
    for (const m of text.matchAll(WRITE))
      found.add(`${where} ${owners[lineOf(m.index ?? 0)]}: ${m[1]}(${m[2]})`);
    for (const m of text.matchAll(RAW)) {
      const table = m[2] ?? TABLES[SQL_TABLES.indexOf((m[3] ?? "").toLowerCase())] ?? m[3];
      found.add(
        `${where} ${owners[lineOf(m.index ?? 0)]}: sql ${(m[1] ?? "").split(/\s/)[0]?.toLowerCase()}(${table})`,
      );
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
