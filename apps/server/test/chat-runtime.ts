// The real agent runtime with what the chat tests watch around it: the messages the route handed to it, a hold
// before routing (to race a resend against the first post), and extra live runs for the active-runs routes'
// reveal rules (a debate's turn or a delegation is never a conversation run, so the runtime itself lists none).
import type { ActiveRun, Message } from "@vanr/contract";
import type { RuntimePort } from "../src/context";

export interface ChatRuntime {
  /** The ids of the messages the route handed to the runtime, in order. */
  routed: string[];
  /** Live runs `activeRuns` answers besides the runtime's own, each with its workspace (the test fills it). */
  live: (ActiveRun & { workspaceId: string })[];
  /** Called with each routed message before the runtime routes it; the test can hold it there. */
  before?: (message: Message) => Promise<void>;
  /** Wraps the server's port. */
  port(base: RuntimePort): RuntimePort;
}

export function chatRuntime(): ChatRuntime {
  const runtime: ChatRuntime = {
    routed: [],
    live: [],
    port(base) {
      return {
        ...base,
        activeRuns: (filter) => [
          ...base.activeRuns(filter),
          ...runtime.live
            .filter(
              (r) =>
                r.workspaceId === filter.workspaceId &&
                (!filter.channelId || r.channelId === filter.channelId),
            )
            .map(({ workspaceId: _, ...run }) => run),
        ],
        async onPersonMessage(input) {
          runtime.routed.push(input.message.id);
          await runtime.before?.(input.message);
          return base.onPersonMessage(input);
        },
      };
    },
  };
  return runtime;
}
