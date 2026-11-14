// Contract between the agent runtime and whatever generates the answers (a real model or the fake one).
// The runtime knows only these types; each provider translates them to its own API.

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the input. */
  inputSchema: Record<string, unknown>;
  /**
   * Out of the prompt until tool search finds it (the API's `defer_loading`). With any deferred tool,
   * the provider adds the search tool.
   */
  deferLoading?: boolean;
  /**
   * A tool with its own type in the API (the handler is still ours): the real provider sends only the
   * type and the name, which the model knows from training. `memory_20250818` is the memory tool (name
   * `memory`).
   */
  builtin?: "memory_20250818";
}

/** A search result the model can cite (the API's `search_result` block, with native citations). */
export interface SearchResultBlock {
  type: "search_result";
  /** Where it came from (the source's path in the app): the citation returns it unchanged. */
  source: string;
  title: string;
  /** Each text is a citable block. */
  texts: string[];
}

/** Native citation: the part of the search result that supports the answer text. */
export interface Citation {
  /** Position of the result among all the `search_result` blocks of the request (0, 1, 2...). */
  searchResultIndex: number;
  source: string;
  title: string | null;
  citedText: string;
}

export type ModelContent =
  | { type: "text"; text: string; citations?: Citation[] }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
      /** Search results that go along with the text (the `search` tool). */
      searchResults?: SearchResultBlock[];
    }
  | SearchResultBlock;

export interface ModelMessage {
  role: "user" | "assistant";
  content: ModelContent[];
  /**
   * The assistant content as the provider returned it (with thinking blocks), to send back untouched in
   * the following turns of the same run.
   */
  raw?: unknown;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  signal: AbortSignal;
  /**
   * Advisor: the executor (`model`) consults a more capable model in the middle of the answer, through
   * the API's server tool. The pair has to be in `ADVISOR_PAIRS`.
   */
  advisor?: AdvisorSpec;
}

export interface AdvisorSpec {
  model: string;
  /** Advisor calls allowed in one request; past that, the API returns a usage error to the executor. */
  maxUses: number;
  /** Maximum output (thinking + text) of each advisor call. */
  maxTokens: number;
}

export interface Usage {
  inputTokens: number;
  cachedTokens: number;
  /** Cache writes (5 min + 1 h). */
  cacheWriteTokens: number;
  outputTokens: number;
  /** Part of `cacheWriteTokens` written to the 1 h cache (costs 2x the input, against 1.25x for 5 min). */
  cacheWrite1hTokens?: number;
  /** `fast`: fast mode (higher price). */
  speed?: "standard" | "fast";
  /** Where inference ran (`us` costs 1.1x). */
  inferenceGeo?: string;
  serviceTier?: string;
  /**
   * Each sampling of the call, when the API splits them (advisor, compaction, fallback). The top-level
   * `usage` covers only the executor; the ledger writes one line per iteration.
   */
  iterations?: UsageIteration[];
}

export interface UsageIteration {
  /** `message` (executor), `advisor_message` (advisor), `compaction`, `fallback_message`... */
  type: string;
  /** Model of this iteration; without it, the call's model. */
  model?: string;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** `pause`: the API stopped in the middle of one of its own tools (tool search) and the turn goes on. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause" | "other";

export type ModelEvent =
  | { type: "thinking" }
  | { type: "text"; text: string }
  /** End of the turn: the full content, the stop reason and the usage. Always the last event. */
  | { type: "turn"; content: ModelContent[]; raw: unknown; stop: StopReason; usage: Usage };

export interface ModelProvider {
  readonly kind: "fake" | "anthropic";
  stream(req: ModelRequest): AsyncIterable<ModelEvent>;
}

export type ModelErrorCode =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "bad_request"
  | "network"
  | "invalid_tool_input"
  | "fake_failure";

/** A provider failure with a stable code that the run records in `errorCode`. */
export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
});

/** Sum of tokens (for the run total). With iterations, counts the iterations, not the top level. */
export function addUsage(a: Usage, b: Usage): Usage {
  const t = totalTokens(b);
  return {
    inputTokens: a.inputTokens + t.inputTokens,
    cachedTokens: a.cachedTokens + t.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + t.cacheWriteTokens,
    outputTokens: a.outputTokens + t.outputTokens,
  };
}

/** Tokens of a call: the sum of the iterations when there are any (the top level covers only the executor). */
function totalTokens(
  u: Usage,
): Pick<Usage, "inputTokens" | "cachedTokens" | "cacheWriteTokens" | "outputTokens"> {
  if (!u.iterations?.length)
    return {
      inputTokens: u.inputTokens,
      cachedTokens: u.cachedTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      outputTokens: u.outputTokens,
    };
  const sum = { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  for (const it of u.iterations) {
    sum.inputTokens += it.inputTokens;
    sum.cachedTokens += it.cachedTokens;
    sum.cacheWriteTokens += it.cacheWriteTokens;
    sum.outputTokens += it.outputTokens;
  }
  return sum;
}
