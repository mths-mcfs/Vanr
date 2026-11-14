// Anthropic provider: the Messages API streamed, with tools and caching of the prefix (tools + system).
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { TOOL_SEARCH_TOOL } from "./tool-tokens";
import {
  type AdvisorSpec,
  type Citation,
  type ModelContent,
  ModelError,
  type ModelEvent,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type SearchResultBlock,
  type StopReason,
  type Usage,
  type UsageIteration,
} from "./types";

const JSON_RETRIES = 2;
/** Beta of the advisor tool. */
export const ADVISOR_BETA = "advisor-tool-2026-03-01";

function searchResultParam(r: SearchResultBlock): Anthropic.SearchResultBlockParam {
  return {
    type: "search_result",
    source: r.source,
    title: r.title,
    content: r.texts.map((text) => ({ type: "text", text })),
    citations: { enabled: true },
  };
}

function toParam(m: ModelMessage): Anthropic.MessageParam {
  // The assistant's raw content goes back unchanged (thinking blocks must return untouched).
  if (m.role === "assistant" && Array.isArray(m.raw)) {
    return { role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] };
  }
  const content: Anthropic.ContentBlockParam[] = m.content.map((c) => {
    switch (c.type) {
      case "text":
        return { type: "text", text: c.text };
      case "tool_use":
        return { type: "tool_use", id: c.id, name: c.name, input: c.input };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: c.toolUseId,
          content: c.searchResults?.length
            ? [{ type: "text", text: c.content }, ...c.searchResults.map(searchResultParam)]
            : c.content,
          is_error: c.isError,
        };
      case "search_result":
        return searchResultParam(c);
      default: {
        const _exhaustive: never = c;
        return _exhaustive;
      }
    }
  });
  return { role: m.role, content };
}

function stopOf(reason: Anthropic.Message["stop_reason"]): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause";
    default:
      return "other";
  }
}

// The response is outside data: it is checked here, once, and converted to the runtime's types. What
// does not fit is an invalid response (the turn fails with a ModelError), never a guess.

/** A token count: a non-negative integer. A negative one would turn a call into credit. */
const tokenCount = z.number().int().nonnegative();
const optionalCount = tokenCount.nullish();

const ApiCitation = z.object({
  search_result_index: tokenCount,
  source: z.string(),
  title: z.string().nullish(),
  cited_text: z.string(),
});
const ApiText = z.object({
  text: z.string(),
  citations: z.array(z.looseObject({ type: z.string() })).nullish(),
});
/** A tool block needs an id: without it the result cannot be matched back to the call. */
const ApiToolUse = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown().optional(),
});

const ApiUsage = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_input_tokens: optionalCount,
  cache_creation_input_tokens: optionalCount,
  cache_creation: z
    .object({ ephemeral_5m_input_tokens: optionalCount, ephemeral_1h_input_tokens: optionalCount })
    .nullish(),
  speed: z.enum(["standard", "fast"]).nullish(),
  inference_geo: z.string().nullish(),
  service_tier: z.string().nullish(),
  iterations: z.unknown().optional(),
});

const isNumber = z.custom<number>((v) => typeof v === "number");
/** Has the shape of an iteration (a type and the two counts); anything else in the list is dropped. */
const IterationShape = z.object({ type: z.string(), input_tokens: isNumber, output_tokens: isNumber });
/** An iteration with that shape whose counts are valid; invalid counts are an invalid response. */
const ApiIteration = z.object({
  type: z.string(),
  model: z.unknown().optional(),
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_input_tokens: optionalCount,
  cache_creation_input_tokens: optionalCount,
});

function invalid(what: string, error: z.ZodError): ModelError {
  const issue = error.issues[0];
  return new ModelError(
    "invalid_tool_input",
    `Invalid ${what} in the response: ${issue?.path.join(".")} ${issue?.message}`,
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(what, r.error);
  return r.data;
}

function contentOf(message: Anthropic.Message): ModelContent[] {
  const out: ModelContent[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      const text = parse(ApiText, block, "text block");
      const citations: Citation[] = [];
      for (const c of text.citations ?? []) {
        if (c.type !== "search_result_location") continue;
        const cite = parse(ApiCitation, c, "citation");
        citations.push({
          searchResultIndex: cite.search_result_index,
          source: cite.source,
          title: cite.title ?? null,
          citedText: cite.cited_text,
        });
      }
      out.push(
        citations.length ? { type: "text", text: text.text, citations } : { type: "text", text: text.text },
      );
    } else if (block.type === "tool_use") {
      const tool = parse(ApiToolUse, block, "tool block");
      out.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
    }
  }
  return out;
}

/** The iterations of `usage.iterations` (advisor, compaction, fallback), which the stable SDK does not type. */
function iterationsOf(raw: unknown): UsageIteration[] {
  if (!Array.isArray(raw)) return [];
  const out: UsageIteration[] = [];
  for (const item of raw) {
    if (!IterationShape.safeParse(item).success) continue;
    const it = parse(ApiIteration, item, "usage iteration");
    out.push({
      type: it.type,
      ...(typeof it.model === "string" ? { model: it.model } : {}),
      inputTokens: it.input_tokens,
      cachedTokens: it.cache_read_input_tokens ?? 0,
      cacheWriteTokens: it.cache_creation_input_tokens ?? 0,
      outputTokens: it.output_tokens,
    });
  }
  return out;
}

/**
 * The response usage in the runtime's format: 1 h cache, speed, region and each iteration. With no
 * well-formed iteration, the top-level usage is the whole call.
 */
export function usageOf(raw: Anthropic.Usage): Usage {
  const u = parse(ApiUsage, raw, "usage");
  const iterations = iterationsOf(u.iterations);
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens;
  return {
    inputTokens: u.input_tokens,
    cachedTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens,
    ...(write1h ? { cacheWrite1hTokens: write1h } : {}),
    ...(u.speed ? { speed: u.speed } : {}),
    ...(u.inference_geo ? { inferenceGeo: u.inference_geo } : {}),
    ...(u.service_tier ? { serviceTier: u.service_tier } : {}),
    ...(iterations.length ? { iterations } : {}),
  };
}

function mapError(err: unknown): unknown {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ModelError("auth", err.message);
  }
  if (err instanceof Anthropic.RateLimitError) return new ModelError("rate_limit", err.message);
  if (err instanceof Anthropic.BadRequestError) return new ModelError("bad_request", err.message);
  if (err instanceof Anthropic.APIConnectionError) return new ModelError("network", err.message);
  if (err instanceof Anthropic.APIError) {
    return err.status === 529
      ? new ModelError("overloaded", err.message)
      : new ModelError("network", err.message);
  }
  return err;
}

/** The tool definition as it goes over the wire. */
function advisorTool(a: AdvisorSpec) {
  return {
    type: "advisor_20260301",
    name: "advisor",
    model: a.model,
    max_uses: a.maxUses,
    max_tokens: a.maxTokens,
    // The advisor rereads the conversation on every call: with caching, the second one reads the prefix.
    caching: { type: "ephemeral" },
  } as const;
}

/** `fetch` only in tests: checks what goes over the wire without a network. */
export function anthropicProvider(apiKey: string, opts: { fetch?: typeof fetch } = {}): ModelProvider {
  const client = new Anthropic({ apiKey, maxRetries: 2, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  return {
    kind: "anthropic",
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const tools: Anthropic.ToolUnion[] = req.tools.map((t) =>
        t.builtin === "memory_20250818"
          ? { type: "memory_20250818", name: "memory" }
          : {
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
              eager_input_streaming: true,
              ...(t.deferLoading ? { defer_loading: true } : {}),
            },
      );
      // On-demand loading: with deferred tools, the API's search finds and loads them.
      if (req.tools.some((t) => t.deferLoading)) tools.push({ ...TOOL_SEARCH_TOOL });
      // Advisor: a server tool in beta, outside the SDK's stable types. Its result (`advisor_tool_result`,
      // encrypted on Opus 5.5) comes back in `raw` and is repeated unchanged in the following turns of the
      // run; its cost comes in `usage.iterations` (advisor_message).
      if (req.advisor) tools.push(advisorTool(req.advisor) as unknown as Anthropic.ToolUnion);
      const options = {
        signal: req.signal,
        ...(req.advisor ? { headers: { "anthropic-beta": ADVISOR_BETA } } : {}),
      };
      const params: Anthropic.MessageStreamParams = {
        model: req.model,
        max_tokens: req.maxTokens,
        // Tools come before the system prompt: the cache point on the system prompt covers both.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools,
        messages: req.messages.map(toParam),
        // And the conversation history, on the last block.
        cache_control: { type: "ephemeral" },
      };
      for (let attempt = 0; ; attempt++) {
        const stream = client.messages.stream(params, options);
        const pending: ModelEvent[] = [];
        let streamed = false;
        // The SDK's stable stream does not copy `usage.iterations` from `message_delta` into the final
        // message; without this, the advisor's cost would vanish from the ledger.
        let iterations: unknown;
        stream.on("text", (delta) => pending.push({ type: "text", text: delta }));
        try {
          for await (const event of stream) {
            if (event.type === "message_delta") {
              const it: unknown = Reflect.get(event.usage, "iterations");
              if (it != null) iterations = it;
            }
            if (event.type === "content_block_start" && event.content_block.type === "thinking") {
              yield { type: "thinking" };
            }
            while (pending.length) {
              streamed = true;
              yield pending.shift() as ModelEvent;
            }
          }
          const message = await stream.finalMessage();
          while (pending.length) yield pending.shift() as ModelEvent;
          const usage = iterations == null ? message.usage : { ...message.usage, iterations };
          const stop = stopOf(message.stop_reason);
          const content = contentOf(message);
          // Tool input cut at the token limit does not run.
          if (stop === "max_tokens" && content.some((c) => c.type === "tool_use")) {
            throw new ModelError("invalid_tool_input", "Tool input was cut at max_tokens");
          }
          yield { type: "turn", content, raw: message.content, stop, usage: usageOf(usage) };
          return;
        } catch (err) {
          if (req.signal.aborted || err instanceof ModelError) throw err;
          if (err instanceof Anthropic.APIError) throw mapError(err);
          // With eager_input_streaming, an input that does not parse as JSON rejects the turn. Retries a
          // few times, only if nothing was shown yet (otherwise the streamed text would come out twice).
          if (!streamed && attempt < JSON_RETRIES) continue;
          throw new ModelError("invalid_tool_input", err instanceof Error ? err.message : String(err));
        }
      }
    },
  };
}
