// The web's part of real time: one connection per open workspace, channel subscriptions counted,
// and the refetch of the few calls the client's own table does not tie to an event.
import { describe, expect, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useApiQuery } from "@vanr/client/react";
import { type ReactNode, StrictMode } from "react";
import { newTestRuntime } from "../../test/app.tsx";
import { AppProviders } from "../app/context.tsx";
import { useChannelSubscription, useInvalidateOn, useRealtimeStatus, WorkspaceRealtime } from "./react.tsx";

const WORKSPACE = "workspace_birchwood";

function Status() {
  return <output aria-label="connection">{useRealtimeStatus()}</output>;
}

function Follower({ channelId }: { channelId: string }) {
  useChannelSubscription(channelId);
  return null;
}

async function mount(children: ReactNode, wrap: (tree: ReactNode) => ReactNode = (tree) => tree) {
  const test = newTestRuntime({ path: "/", signedInAs: "usr_ana" });
  const tree = (inside: ReactNode) =>
    wrap(
      <AppProviders runtime={test.runtime}>
        <WorkspaceRealtime workspaceId={WORKSPACE}>
          <Status />
          {inside}
        </WorkspaceRealtime>
      </AppProviders>,
    );
  const view = await act(async () => render(tree(children)));
  await waitFor(() => expect(screen.getByLabelText("connection").textContent).toBe("open"));
  return { ...test, ...view, show: (next: ReactNode) => act(async () => view.rerender(tree(next))) };
}

const frames = (sent: Record<string, unknown>[], type: string) => sent.filter((frame) => frame.type === type);

describe("the connection of a workspace", () => {
  test("mounting twice, as StrictMode does, opens one socket", async () => {
    const app = await mount(null, (tree) => <StrictMode>{tree}</StrictMode>);
    expect(app.server.socketsAsked).toBe(1);
    expect(app.server.openSockets()).toHaveLength(1);
  });

  test("outside a workspace there is no connection and the status says stopped", async () => {
    const test = newTestRuntime({ path: "/", signedInAs: "usr_ana" });
    await act(async () =>
      render(
        <AppProviders runtime={test.runtime}>
          <Status />
        </AppProviders>,
      ),
    );
    expect(screen.getByLabelText("connection").textContent).toBe("stopped");
    expect(test.server.socketsAsked).toBe(0);
  });
});

describe("following a channel", () => {
  test("is counted: two followers share one subscription, and the last one out releases it", async () => {
    // A list, so that taking one follower out leaves the other one mounted.
    const followers = (keys: string[]) => keys.map((key) => <Follower key={key} channelId="ch_general" />);
    const app = await mount(followers(["a", "b"]));
    const socket = () => app.server.openSockets()[0];
    await waitFor(() => expect(socket()?.channels).toEqual(["ch_general"]));
    expect(frames(socket()?.sent ?? [], "subscribe")).toHaveLength(1);

    await app.show(followers(["b"]));
    expect(socket()?.channels).toEqual(["ch_general"]);
    expect(frames(socket()?.sent ?? [], "unsubscribe")).toHaveLength(0);

    await app.show(followers([]));
    await waitFor(() => expect(socket()?.channels).toEqual([]));
    expect(frames(socket()?.sent ?? [], "unsubscribe")).toHaveLength(1);
  });

  test("under StrictMode a follower still leaves one subscription behind, then none", async () => {
    const app = await mount(<Follower channelId="ch_general" />, (tree) => <StrictMode>{tree}</StrictMode>);
    const socket = () => app.server.openSockets()[0];
    await waitFor(() => expect(socket()?.channels).toEqual(["ch_general"]));
    await app.show(null);
    await waitFor(() => expect(socket()?.channels).toEqual([]));
  });
});

describe("refetching on an event", () => {
  function Waiting() {
    const overview = useApiQuery("getOverview", { workspaceId: WORKSPACE });
    useInvalidateOn("approval.resolved", { method: "getOverview", args: { workspaceId: WORKSPACE } });
    return <output aria-label="waiting">{overview.data?.myApprovalQueue ?? "…"}</output>;
  }

  test("a pair the client's table does not have refetches the call named", async () => {
    const app = await mount(<Waiting />);
    await waitFor(() => expect(screen.getByLabelText("waiting").textContent).toBe("2"));
    app.server.approvals.set(WORKSPACE, ["usr_ana"]);
    await act(async () => app.server.emit(WORKSPACE, { type: "approval.resolved", approvalId: "apr_1" }));
    await waitFor(() => expect(screen.getByLabelText("waiting").textContent).toBe("1"));
  });

  test("an event of another name leaves the call alone", async () => {
    const app = await mount(<Waiting />);
    await waitFor(() => expect(screen.getByLabelText("waiting").textContent).toBe("2"));
    const before = app.server.calls.filter((call) => call.method === "getOverview").length;
    await act(async () => app.server.emit(WORKSPACE, { type: "run.status_changed", agentId: "agt_scout" }));
    expect(app.server.calls.filter((call) => call.method === "getOverview")).toHaveLength(before);
  });
});
