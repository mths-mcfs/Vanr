// Tokens of the tool definitions: what goes over the wire to the API and how much it weighs in the
// prompt. The measurement uses the fake provider, which counts the way the API does: a deferred tool
// (`defer_loading`) stays out of the prompt until search finds it; the search tool is always in.
//
// Without a key there is no Claude tokenizer here: the estimate is the fake provider's (4 characters per
// token). The real number comes from the API's `count_tokens`, which needs a key.
import type { ModelMessage, ToolSpec } from "./types";

/** Anthropic's tool search tool (BM25: a natural-language query). Never deferred. */
export const TOOL_SEARCH_TOOL = {
  type: "tool_search_tool_bm25_20251119",
  name: "tool_search_tool_bm25",
} as const;

/** The definition as the Anthropic provider sends it. */
export function wireTool(t: ToolSpec): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    ...(t.deferLoading ? { defer_loading: true } : {}),
  };
}

/** Estimate without a tokenizer: 4 characters per token (the fake provider's rule). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Tool names the model has already called in the history (search has already loaded the definition). */
export function usedTools(messages: readonly ModelMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) for (const c of m.content) if (c.type === "tool_use") out.add(c.name);
  return out;
}

/**
 * What the definitions take up in the prompt of a call: the loaded ones (not deferred, or already found)
 * and, when any is deferred, the search tool.
 */
export function toolPromptChars(tools: readonly ToolSpec[], loaded: ReadonlySet<string>): number {
  const inPrompt = tools.filter((t) => !t.deferLoading || loaded.has(t.name)).map(wireTool);
  const search = tools.some((t) => t.deferLoading) ? [TOOL_SEARCH_TOOL] : [];
  return JSON.stringify([...inPrompt, ...search]).length;
}
