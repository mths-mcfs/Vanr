// Fake provider: deterministic answers for development and tests, with no network and no key.
//
// Reads the last message of the conversation:
//   - if it carries tool results, says what it did with each one (fake-speech.ts);
//   - otherwise, looks for directives in the person's text:
//       [[tool:name {"field":"value"}]]  calls the tool (several directives = parallel calls)
//       [[slow:300]]                    waits 300 ms between pieces of the text (to test stopping)
//       [[fail]]                        fails the turn with ModelError("fake_failure") (also works in
//                                       the system prompt, to simulate an agent that always fails)
//       [[silent]]                      ends without text (the agent decides not to answer)
//       [[reply:TEXT]]                  in a call without tools (a debate turn, a synthesis, the
//                                       approvals reviewer), answers exactly TEXT; ignored in a run
//                                       with tools
//       [[advise]]                      with an advisor in the request, consults it once per directive
//                                       (up to `maxUses`): the usage comes back in `iterations`, as in
//                                       the API
//   - if the person sent search results (ask mode), answers with the first sentence of each one (up to
//     3), each sentence citing the result it came from (native citation).
//   - without a directive, answers by repeating the request.
// When the request comes from the assignment verifier (the system prompt asks for the JSON with
// "verdicts"), answers the JSON: passes every deliverable and fails the ones with [[reject]] in the
// evidence. Without this an assignment never closes without a key (development and E2E). [[fail]] and
// [[silent]] in the evidence work as anywhere else.
// The speech has no ids or directives: without an Anthropic key, this provider is the one answering the
// people who use the product.
// Token usage is estimated at 4 characters per token.
import { aboutToUse, afterTool, echo } from "./fake-speech";
import { toolPromptChars, usedTools } from "./tool-tokens";
import {
  type ModelContent,
  ModelError,
  type ModelEvent,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type Usage,
} from "./types";

const TOOL_RE = /\[\[tool:([a-z_]+)(?:\s+(\{[\s\S]*?\}))?\]\]/g;
const SLOW_RE = /\[\[slow:(\d{1,5})\]\]/;
const REPLY_RE = /\[\[reply:([^\]]{1,200})\]\]/;
const ADVISE_RE = /\[\[advise\]\]/g;
/** Output of each advisor call in the fake provider. */
export const FAKE_ADVICE_TOKENS = 300;

export interface FakeOptions {
  /** Pause between pieces of the text, in ms (0 in tests). */
  chunkDelayMs?: number;
}

const tokens = (chars: number) => Math.ceil(chars / 4);

function textOf(message: ModelMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((c): c is Extract<ModelContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Prompt size as the API counts it: the tool definitions as they go over the wire, without the deferred
 * ones not found yet (the ones the model already called count: search loaded them).
 */
function promptChars(req: ModelRequest): number {
  let n = req.system.length + toolPromptChars(req.tools, usedTools(req.messages));
  for (const m of req.messages) n += JSON.stringify(m.content).length;
  return n;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Pieces of ~3 words, keeping the spaces, so the stream looks real. */
export function chunksOf(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(""));
  return out;
}

interface Plan {
  /** Advisor calls in this turn. */
  advice?: number;
  text: string;
  /** Ready text blocks (with citations), when the answer is not just `text`. */
  blocks?: Extract<ModelContent, { type: "text" }>[];
  calls: { name: string; input: unknown }[];
  delayMs: number;
  fail: boolean;
}

/** The fake verifier's verdicts: one per "## Deliverable <id>:" of the request. */
function verdictsFor(prompt: string): string {
  const verdicts = prompt
    .split(/^## Deliverable /m)
    .slice(1)
    .map((block) => {
      const passes = !block.includes("[[reject]]");
      return {
        id: block.slice(0, block.indexOf(":")).trim(),
        passes,
        reason: passes ? "The evidence shows the criterion." : "The evidence does not show the criterion.",
      };
    });
  return JSON.stringify({ verdicts });
}

const DEBATE_RE = /\[\[debate:([^\]]+)\]\]/;

function planFor(req: ModelRequest, defaultDelay: number): Plan {
  const last = req.messages.at(-1);
  const results = last?.content.filter(
    (c): c is Extract<ModelContent, { type: "tool_result" }> => c.type === "tool_result",
  );
  // The pause directive applies to the whole run: it is looked up in the person's last text message.
  const lastUserText = textOf(
    [...req.messages].reverse().find((m) => m.role === "user" && m.content.some((c) => c.type === "text")),
  );
  const slow = SLOW_RE.exec(lastUserText);
  const delayMs = slow ? Number(slow[1]) : defaultDelay;

  if (results && results.length > 0) {
    const previous = req.messages.at(-2);
    const asked = new Map(
      (previous?.content ?? [])
        .filter((c): c is Extract<ModelContent, { type: "tool_use" }> => c.type === "tool_use")
        .map((c) => [c.id, c]),
    );
    const lines = results.map((r) => {
      const call = asked.get(r.toolUseId);
      return afterTool(call?.name ?? "tool", call?.input, r.content, r.isError);
    });
    return { text: lines.join("\n"), calls: [], delayMs, fail: false };
  }

  const sources = last?.role === "user" ? last.content.filter((c) => c.type === "search_result") : [];
  if (sources.length) {
    const blocks = sources.slice(0, 3).flatMap((r, i) => {
      const cited = r.texts[0]?.trim() ?? "";
      if (!cited) return [];
      const sentence = /^[^.!?\n]{1,240}[.!?]?/.exec(cited)?.[0] ?? cited.slice(0, 240);
      return [
        {
          type: "text" as const,
          text: `${sentence.trim()} `,
          citations: [{ searchResultIndex: i, source: r.source, title: r.title, citedText: cited }],
        },
      ];
    });
    if (!blocks.length) return { text: "I found nothing in the sources.", calls: [], delayMs, fail: false };
    return { text: blocks.map((b) => b.text).join(""), blocks, calls: [], delayMs, fail: false };
  }

  const text = textOf(last);
  if (text.includes("[[fail]]") || req.system.includes("[[fail]]"))
    return { text: "", calls: [], delayMs, fail: true };
  if (text.includes("[[silent]]")) return { text: "", calls: [], delayMs, fail: false };
  if (req.system.includes('{"verdicts":'))
    return { text: verdictsFor(text), calls: [], delayMs, fail: false };
  // A debate turn with a position scripted in the instructions: `[[debate:X|Y]]` answers X in round 0
  // and Y from round 1 on (the last item holds for the following rounds).
  const debate = DEBATE_RE.exec(req.system);
  const round = /^Round (\d+) of/.exec(text);
  if (debate && round) {
    const answers = (debate[1] as string).split("|");
    const answer = answers[Math.min(Number(round[1]), answers.length - 1)] as string;
    const before =
      Number(round[1]) > 0 ? answers[Math.min(Number(round[1]) - 1, answers.length - 1)] : answer;
    const position = {
      answer,
      confidence: 0.7,
      reason: before !== answer ? `changed from ${before}` : "",
      evidence: [`fake evidence for ${answer}`],
    };
    return { text: `I argue for ${answer}.\n${JSON.stringify(position)}`, calls: [], delayMs, fail: false };
  }
  const reply = req.tools.length === 0 ? REPLY_RE.exec(text) : null;
  if (reply) return { text: reply[1] as string, calls: [], delayMs, fail: false };
  const calls: Plan["calls"] = [];
  for (const m of text.matchAll(TOOL_RE)) {
    let input: unknown = {};
    if (m[2]) {
      try {
        input = JSON.parse(m[2]);
      } catch {
        input = { invalid: m[2] };
      }
    }
    calls.push({ name: m[1] as string, input });
  }
  const advice = req.advisor ? Math.min(text.match(ADVISE_RE)?.length ?? 0, req.advisor.maxUses) : 0;
  if (calls.length > 0) {
    return { text: aboutToUse(calls.map((c) => c.name)), calls, delayMs, fail: false, advice };
  }
  return { text: echo(text), calls, delayMs, fail: false, advice };
}

export function fakeProvider(opts: FakeOptions = {}): ModelProvider {
  const defaultDelay = opts.chunkDelayMs ?? 0;
  let nextId = 1;
  return {
    kind: "fake",
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const plan = planFor(req, defaultDelay);
      yield { type: "thinking" };
      await sleep(plan.delayMs, req.signal);
      if (plan.fail) throw new ModelError("fake_failure", "Fake provider was asked to fail");
      for (const chunk of chunksOf(plan.text)) {
        req.signal.throwIfAborted();
        yield { type: "text", text: chunk };
        await sleep(plan.delayMs, req.signal);
      }
      req.signal.throwIfAborted();
      const content: ModelContent[] = [];
      if (plan.blocks) content.push(...plan.blocks);
      else if (plan.text) content.push({ type: "text", text: plan.text });
      for (const call of plan.calls) {
        content.push({ type: "tool_use", id: `toolu_fake_${nextId++}`, name: call.name, input: call.input });
      }
      const usage: Usage = {
        inputTokens: tokens(promptChars(req)),
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: tokens(JSON.stringify(content).length),
      };
      // As in the API: the executor and each advisor call become iterations; the advisor reads the whole conversation.
      if (req.advisor && plan.advice) {
        const executor = { type: "message", ...usage };
        const consult = {
          type: "advisor_message",
          model: req.advisor.model,
          inputTokens: usage.inputTokens,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: Math.min(FAKE_ADVICE_TOKENS, req.advisor.maxTokens),
        };
        usage.iterations = [executor, ...Array.from({ length: plan.advice }, () => consult)];
      }
      yield { type: "turn", content, raw: null, stop: plan.calls.length ? "tool_use" : "end_turn", usage };
    },
  };
}
