// Anthropic provider: the Messages API streamed, with tools and caching of the prefix (tools + system).
import Anthropic from "@anthropic-ai/sdk";
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

function contentOf(message: Anthropic.Message): ModelContent[] {
  const out: ModelContent[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      const citations: Citation[] = [];
      for (const c of block.citations ?? [])
        if (c.type === "search_result_location")
          citations.push({
            searchResultIndex: c.search_result_index,
            source: c.source,
            title: c.title ?? null,
            citedText: c.cited_text,
          });
      out.push(
        citations.length ? { type: "text", text: block.text, citations } : { type: "text", text: block.text },
      );
    } else if (block.type === "tool_use")
      out.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
  }
  return out;
}

/** A raw `usage.iterations` entry (advisor, compaction, fallback); the stable SDK does not type it. */
interface RawIteration {
  type?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Each field is read with a type check below; a non-object entry reads as an empty one. */
const rawIteration = (v: unknown): RawIteration => (typeof v === "object" && v !== null ? v : {});

/** The response usage in the runtime's format: 1 h cache, speed, region and each iteration. */
export function usageOf(u: Anthropic.Usage): Usage {
  const raw: unknown = Reflect.get(u, "iterations");
  const iterations: UsageIteration[] = Array.isArray(raw)
    ? raw.map(rawIteration).map((it) => ({
        type: typeof it.type === "string" ? it.type : "message",
        ...(typeof it.model === "string" ? { model: it.model } : {}),
        inputTokens: num(it.input_tokens),
        cachedTokens: num(it.cache_read_input_tokens),
        cacheWriteTokens: num(it.cache_creation_input_tokens),
        outputTokens: num(it.output_tokens),
      }))
    : [];
  return {
    inputTokens: u.input_tokens,
    cachedTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens,
    ...(u.cache_creation?.ephemeral_1h_input_tokens
      ? { cacheWrite1hTokens: u.cache_creation.ephemeral_1h_input_tokens }
      : {}),
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
