// The agent thinking with the Claude Code or the Codex of a paired runner (the plan of whoever paired it).
// For the runtime it is one more provider: a turn becomes a `harness.turn` on the runner, the text arrives bit
// by bit (`harness.event`) and each tool the CLI calls comes back here and runs down the same path as the
// model's tools (steps, events, approvals). The CLI runs its own tool loop, so the turn always ends in
// `end_turn`. The usage doesn't go into the budget: the plan isn't billed here.
import type { MessageMeta } from "@vanr/contract";
import type { ModelEvent, ModelMessage, ModelProvider, ModelRequest } from "@vanr/engine/models/types";
import { HARNESS_PROMPT_MAX, HARNESS_SYSTEM_MAX, type HarnessTurnResult } from "@vanr/engine/runner-protocol";
import { z } from "zod";
import type { AppDeps } from "../context";
import { RunnerCallError } from "../runners/hub";
import { networkPolicyFor } from "../runners/network";
import { EXECUTOR_NAME, type Executor, type RunHarness, type UnavailableCode } from "../runners/plans";

/** The cap of one turn on the runner (it includes waiting for a tool's approval). */
const HARNESS_TURN_SECONDS = 6 * 3600;

/** The runner's harness didn't answer (offline, not logged in, the plan's limit...). */
export class HarnessError extends Error {
  constructor(
    readonly code: UnavailableCode,
    message: string,
    readonly executor: Executor,
    readonly runnerId: string | null,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

export type ToolInvoker = (name: string, input: unknown) => Promise<{ content: string; isError: boolean }>;

const TRANSCRIPT_HEAD = "The conversation so far, oldest first:";
const TRANSCRIPT_TAIL =
  "Reply to the latest message(s) as yourself. Your reply is posted to the conversation as is. " +
  "Use your tools when they help. If there is nothing useful to add, reply with nothing.";

/**
 * The conversation as text: each turn of the CLI starts from scratch (no session kept on the runner). It fits
 * in `max` characters: the oldest messages go first, and a single message larger than the cap keeps its end.
 */
export function transcript(messages: ModelMessage[], max = HARNESS_PROMPT_MAX): string {
  const blocks = messages.map((m) => {
    const text = m.content
      .map((c) =>
        c.type === "text"
          ? c.text
          : c.type === "tool_use"
            ? `[you called ${c.name}]`
            : c.type === "search_result"
              ? `[source ${c.source}] ${c.title}\n${c.texts.join("\n")}`
              : `[tool result${c.isError ? ", error" : ""}] ${c.content}`,
      )
      .filter(Boolean)
      .join("\n");
    return m.role === "assistant" ? `You: ${text}` : text;
  });
  // The header, the footer, the separators and the cut notice.
  let room = max - TRANSCRIPT_HEAD.length - TRANSCRIPT_TAIL.length - 200;
  const kept: string[] = [];
  for (let i = blocks.length - 1; i >= 0 && room > 0; i--) {
    const block = blocks[i] ?? "";
    const piece = block.length + 2 <= room ? block : `[...]${block.slice(block.length - (room - 7))}`;
    kept.unshift(piece);
    room -= piece.length + 2;
  }
  const left = blocks.length - kept.length;
  return [
    TRANSCRIPT_HEAD,
    ...(left > 0 ? [`(${left} older message${left === 1 ? "" : "s"} left out)`] : []),
    kept.join("\n\n"),
    TRANSCRIPT_TAIL,
  ].join("\n\n");
}

const CODE_FROM_RUNNER: Partial<Record<string, UnavailableCode>> = {
  offline: "offline",
  paused: "paused",
  not_allowed: "tool_off",
  not_logged_in: "not_logged_in",
  plan_limit: "plan_limit",
};

function harnessError(err: unknown, executor: Executor, runnerId: string): unknown {
  if (!(err instanceof RunnerCallError) || err.code === "canceled") return err;
  return new HarnessError(CODE_FROM_RUNNER[err.code] ?? "harness_failed", err.message, executor, runnerId);
}

const tokens = z.number().int().nonnegative();
/** The turn's answer as the runner sent it (the socket only checked that it is a result frame). */
const turnResult = z.object({
  text: z.string(),
  usage: z.object({ inputTokens: tokens, outputTokens: tokens, cachedTokens: tokens }),
  model: z.string().nullable(),
}) satisfies z.ZodType<HarnessTurnResult>;

/**
 * The provider that thinks on the runner. `invoke` runs the agent's tools on the server. A turn goes out once:
 * it isn't idempotent (the CLI may already have called tools), so a failure or the deadline ends the turn with
 * the error instead of asking again.
 */
export function remoteProvider(
  deps: AppDeps,
  input: {
    runId: string;
    agent: { id: string; handle: string };
    harness: Extract<RunHarness, { kind: "remote" }>;
    invoke: ToolInvoker;
  },
): ModelProvider {
  const { harness } = input;
  return {
    kind: "anthropic",
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const queue: ModelEvent[] = [];
      let wake: (() => void) | null = null;
      // Set by the call's callbacks (an object, so the reads after the loop aren't narrowed to the initial value).
      const end: { finished: boolean; result: HarnessTurnResult | null; failure: unknown } = {
        finished: false,
        result: null,
        failure: null,
      };
      const push = (event: ModelEvent) => {
        queue.push(event);
        wake?.();
      };
      // The harness only reaches its own CLI's domain; the mode goes along because the runner has a single proxy.
      const network = await networkPolicyFor(deps, harness.runner.workspaceId, input.agent.id);
      void deps.runners
        .call<"harness.turn", unknown>(
          harness.runner.id,
          "harness.turn",
          {
            runId: input.runId,
            executor: harness.executor,
            ...(harness.model ? { model: harness.model } : {}),
            system: req.system.slice(0, HARNESS_SYSTEM_MAX),
            prompt: transcript(req.messages),
            tools: req.tools,
            timeoutSeconds: HARNESS_TURN_SECONDS,
            network,
          },
          {
            agent: input.agent,
            timeoutMs: HARNESS_TURN_SECONDS * 1000 + 60_000,
            signal: req.signal,
            onHarnessEvent: (event) => push({ type: "text", text: event.text }),
            onHarnessTool: input.invoke,
          },
        )
        .then(
          (data) => {
            const parsed = turnResult.safeParse(data);
            if (parsed.success) end.result = parsed.data;
            else
              end.failure = new HarnessError(
                "harness_failed",
                "The runner answered the turn in a shape it doesn't have",
                harness.executor,
                harness.runner.id,
              );
          },
          (err) => {
            end.failure = harnessError(err, harness.executor, harness.runner.id);
          },
        )
        .finally(() => {
          end.finished = true;
          wake?.();
        });
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (end.finished) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      if (end.failure) throw end.failure;
      const done = end.result;
      if (!done)
        throw new HarnessError(
          "harness_failed",
          "The runner answered nothing",
          harness.executor,
          harness.runner.id,
        );
      yield {
        type: "turn",
        content: done.text.trim() ? [{ type: "text", text: done.text }] : [],
        raw: null,
        stop: "end_turn",
        usage: {
          inputTokens: done.usage.inputTokens,
          cachedTokens: done.usage.cachedTokens,
          cacheWriteTokens: 0,
          outputTokens: done.usage.outputTokens,
        },
      };
    },
  };
}

const NOTICE_TEXT: Partial<Record<UnavailableCode, string>> = {
  offline: "is offline right now",
  paused: "is paused right now",
  personal_plan: "runs on the personal plan of whoever paired the runner and only answers that person",
  not_logged_in: "is not logged in to a plan on the runner",
  plan_limit: "hit the plan's usage limit; try again later",
  no_environment: "needs a paired runner",
};

/** The agent's message when the runner's harness couldn't answer (it shows translated). */
export function harnessNotice(
  agentId: string,
  { code, executor, runnerId }: Pick<HarnessError, "code" | "executor" | "runnerId">,
): { body: string; meta: MessageMeta } {
  const harness = EXECUTOR_NAME[executor];
  return {
    body: `${harness} ${NOTICE_TEXT[code] ?? "is not available right now"} (${code}).`,
    meta: {
      bodyTemplate: `harness.${code}`,
      templateVars: { harness, code },
      harnessUnavailable: { harness: executor, code, runnerId, agentId },
    },
  };
}
