// The agent's browser. The runner offers a browser only when it finds Chrome/Chromium in this environment;
// the driver talks to it over the DevTools protocol (CDP). The implementation lives in cdp.ts.
import type { AgentRef, RunnerFrame, RunnerOp } from "@vanr/engine/runner-protocol";

export interface BrowserDriver {
  handle(
    op: RunnerOp,
    agent: AgentRef,
    args: unknown,
    send: (frame: RunnerFrame) => boolean,
    /** The request's: aborted (canceled, the connection dropped), the op stops what it still can. */
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
}
