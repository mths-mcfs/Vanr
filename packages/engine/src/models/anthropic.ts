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

/** The stop reason as text: a value this version does not know reads as `other`. */
function stopOf(reason: string | null): StopReason {
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
  /** Any text: a new value must not break every agent (usage.ts charges it as the dearest known mode). */
  speed: z.string().nullish(),
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
    "invalid_response",
    `Invalid ${what} in the response: ${issue?.path.join(".")} ${issue?.message}`,
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(what, r.error);
  return r.data;
}

/** The runtime's content from the assembled blocks (each one already checked when it arrived). */
function contentOf(blocks: readonly Block[]): ModelContent[] {
  const out: ModelContent[] = [];
  for (const block of blocks) {
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
export function usageOf(raw: unknown): Usage {
  const u = parse(ApiUsage, raw, "usage");
  const iterations = iterationsOf(u.iterations);
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens;
  return {
    inputTokens: u.input_tokens,
    cachedTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens,
    ...(write1h ? { cacheWrite1hTokens: write1h } : {}),
    ...(u.speed != null ? { speed: u.speed } : {}),
    ...(u.inference_geo ? { inferenceGeo: u.inference_geo } : {}),
    ...(u.service_tier ? { serviceTier: u.service_tier } : {}),
    ...(iterations.length ? { iterations } : {}),
  };
}

// ---- The stream, one event at a time ----

/** A content block as it arrived (fields the SDK may add are kept: the block goes back unchanged). */
type Block = { type: string } & Record<string, unknown>;
const AnyBlock = z.looseObject({ type: z.string() });
const ApiThinking = z.object({ thinking: z.string(), signature: z.string().optional() });
/** Block types whose input arrives as JSON pieces (`input_json_delta`). */
const TOOL_INPUT_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

const BlockEvent = z.object({ index: z.number().int().nonnegative() });
const BlockStart = BlockEvent.extend({ content_block: AnyBlock });
const BlockDelta = BlockEvent.extend({ delta: AnyBlock });
const MessageStart = z.object({ message: z.object({ content: z.array(AnyBlock), usage: z.unknown() }) });
const MessageDelta = z.object({
  delta: z.object({ stop_reason: z.string().nullish() }),
  usage: z.object({
    input_tokens: optionalCount,
    output_tokens: tokenCount,
    cache_read_input_tokens: optionalCount,
    cache_creation_input_tokens: optionalCount,
    iterations: z.unknown().optional(),
  }),
});
const TextDelta = z.object({ text: z.string() });
const CitationsDelta = z.object({ citation: AnyBlock });
const JsonDelta = z.object({ partial_json: z.string() });
const ThinkingDelta = z.object({ thinking: z.string() });
const SignatureDelta = z.object({ signature: z.string() });

/** Tool input that is not JSON once its block closes: the one failure worth a fresh request. */
class ToolInputJsonError extends Error {}

function malformed(message: string): ModelError {
  return new ModelError("invalid_response", `Invalid stream: ${message}`);
}

/** Counts the stream carries as totals: a later total never lowers one already seen (the budget errs up). */
const COUNTERS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

/**
 * The stream as a small automaton: `message_start` once, then blocks opened, filled and closed one
 * at a time in index order, then `message_delta`s and `message_stop`. Every event is checked against
 * the state and its schema when it arrives, before anything is accumulated or handed on; what does not
 * fit is an invalid response. Unknown event and delta types are skipped, as the SDK skips them.
 */
class StreamAssembler {
  private phase: "before" | "message" | "stopped" = "before";
  private readonly blocks: Block[] = [];
  private open: { index: number; json: string | null } | null = null;
  private readonly toolIds = new Set<string>();
  private usage: Record<string, unknown> = {};
  private iterations: unknown;
  endedWith: string | null = null;

  /** Checks one event and returns what the consumer sees now (text pieces, the thinking signal). */
  push(raw: unknown): ModelEvent[] {
    const event = parse(AnyBlock, raw, "stream event");
    switch (event.type) {
      case "message_start": {
        if (this.phase !== "before") throw malformed("a second message_start");
        const { message } = parse(MessageStart, event, "message_start");
        this.usage = { ...parse(ApiUsage, message.usage, "usage") };
        this.phase = "message";
        const out: ModelEvent[] = [];
        for (const block of message.content) out.push(...this.addBlock(block));
        return out;
      }
      case "content_block_start": {
        this.inMessage(event.type);
        const { index, content_block } = parse(BlockStart, event, "content_block_start");
        if (this.open) throw malformed(`block ${index} opened while block ${this.open.index} is open`);
        if (index !== this.blocks.length)
          throw malformed(`block ${index} opened where block ${this.blocks.length} was due`);
        const out = this.addBlock(content_block);
        this.open = { index, json: TOOL_INPUT_BLOCKS.has(content_block.type) ? "" : null };
        return out;
      }
      case "content_block_delta": {
        this.inMessage(event.type);
        const { index, delta } = parse(BlockDelta, event, "content_block_delta");
        const block = this.openBlock(index, event.type);
        return this.applyDelta(block, delta);
      }
      case "content_block_stop": {
        this.inMessage(event.type);
        const { index } = parse(BlockEvent, event, "content_block_stop");
        const block = this.openBlock(index, event.type);
        const json = this.open?.json;
        if (json) {
          try {
            block.input = JSON.parse(json);
          } catch {
            throw new ToolInputJsonError(`Tool input of block ${index} is not JSON`);
          }
        }
        this.open = null;
        return [];
      }
      case "message_delta": {
        this.inMessage(event.type);
        if (this.open) throw malformed(`message_delta while block ${this.open.index} is open`);
        const d = parse(MessageDelta, event, "message_delta");
        for (const key of COUNTERS) {
          const value = d.usage[key];
          const seen = this.usage[key];
          if (value != null) this.usage[key] = typeof seen === "number" ? Math.max(seen, value) : value;
        }
        if (d.usage.iterations != null) this.iterations = d.usage.iterations;
        if (d.delta.stop_reason != null) this.endedWith = d.delta.stop_reason;
        return [];
      }
      case "message_stop": {
        this.inMessage(event.type);
        if (this.open) throw malformed(`message_stop while block ${this.open.index} is open`);
        this.phase = "stopped";
        return [];
      }
      default:
        if (this.phase === "stopped") throw malformed(`${event.type} after message_stop`);
        return [];
    }
  }

  /** The finished message: its blocks as they go back to the API, and its usage. */
  finish(): { blocks: Block[]; usage: Usage } {
    if (this.phase !== "stopped") throw malformed("the stream ended before message_stop");
    const usage = this.iterations == null ? this.usage : { ...this.usage, iterations: this.iterations };
    return { blocks: this.blocks, usage: usageOf(usage) };
  }

  private inMessage(type: string) {
    if (this.phase === "before") throw malformed(`${type} before message_start`);
    if (this.phase === "stopped") throw malformed(`${type} after message_stop`);
  }

  private openBlock(index: number, type: string): Block {
    const block = this.blocks[index];
    if (!this.open || this.open.index !== index || !block)
      throw malformed(`${type} for block ${index}, which is not open`);
    return block;
  }

  private addBlock(source: Block): ModelEvent[] {
    const block: Block = { ...source };
    const out: ModelEvent[] = [];
    if (block.type === "text") {
      const text = parse(ApiText, block, "text block");
      for (const c of text.citations ?? [])
        if (c.type === "search_result_location") parse(ApiCitation, c, "citation");
      if (text.text) out.push({ type: "text", text: text.text });
    } else if (block.type === "tool_use") {
      const tool = parse(ApiToolUse, block, "tool block");
      if (this.toolIds.has(tool.id)) throw malformed(`tool id ${tool.id} used twice`);
      this.toolIds.add(tool.id);
    } else if (block.type === "thinking") {
      parse(ApiThinking, block, "thinking block");
      out.push({ type: "thinking" });
    }
    this.blocks.push(block);
    return out;
  }

  private applyDelta(block: Block, delta: Block): ModelEvent[] {
    const on = (types: readonly string[]) => {
      if (!types.includes(block.type)) throw malformed(`${delta.type} on a ${block.type} block`);
    };
    switch (delta.type) {
      case "text_delta": {
        on(["text"]);
        const { text } = parse(TextDelta, delta, "text_delta");
        block.text = `${typeof block.text === "string" ? block.text : ""}${text}`;
        return [{ type: "text", text }];
      }
      case "citations_delta": {
        on(["text"]);
        const { citation } = parse(CitationsDelta, delta, "citations_delta");
        if (citation.type === "search_result_location") parse(ApiCitation, citation, "citation");
        block.citations = [...(Array.isArray(block.citations) ? block.citations : []), citation];
        return [];
      }
      case "input_json_delta": {
        if (!this.open || this.open.json === null)
          throw malformed(`input_json_delta on a ${block.type} block`);
        this.open.json += parse(JsonDelta, delta, "input_json_delta").partial_json;
        return [];
      }
      case "thinking_delta": {
        on(["thinking"]);
        block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${parse(ThinkingDelta, delta, "thinking_delta").thinking}`;
        return [];
      }
      case "signature_delta": {
        on(["thinking"]);
        block.signature = parse(SignatureDelta, delta, "signature_delta").signature;
        return [];
      }
      default:
        return [];
    }
  }
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
      const params: Anthropic.MessageCreateParamsStreaming = {
        stream: true,
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
        const assembler = new StreamAssembler();
        let streamed = false;
        try {
          // The raw event stream: the SDK's accumulator would merge events before they could be checked.
          const stream = await client.messages.create(params, options);
          for await (const event of stream) {
            for (const out of assembler.push(event)) {
              if (out.type === "text") streamed = true;
              yield out;
            }
          }
          const { blocks, usage } = assembler.finish();
          const stop = stopOf(assembler.endedWith);
          const content = contentOf(blocks);
          // Tool input cut at the token limit does not run.
          if (stop === "max_tokens" && content.some((c) => c.type === "tool_use")) {
            throw new ModelError("invalid_tool_input", "Tool input was cut at max_tokens");
          }
          yield { type: "turn", content, raw: blocks, stop, usage };
          return;
        } catch (err) {
          if (req.signal.aborted || err instanceof ModelError) throw err;
          if (err instanceof Anthropic.APIError) throw mapError(err);
          // With eager_input_streaming, an input that does not parse as JSON rejects the turn. Retries a
          // few times, only if nothing was shown yet (otherwise the streamed text would come out twice).
          if (err instanceof ToolInputJsonError) {
            if (!streamed && attempt < JSON_RETRIES) continue;
            throw new ModelError("invalid_tool_input", err.message);
          }
          // The SDK could not read the stream itself (an event that is not JSON): a malformed response.
          if (err instanceof Anthropic.AnthropicError) throw new ModelError("invalid_response", err.message);
          throw new ModelError("network", err instanceof Error ? err.message : String(err));
        }
      }
    },
  };
}
