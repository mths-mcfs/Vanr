// The cards a conversation shows, rendered on their own against the fake server: the agent's question
// and the missing connector permission. Who may answer or grant follows the server.
import { describe, expect, spyOn, test } from "bun:test";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentQuestion, MessageMeta, Role } from "@vanr/contract";
import type { ReactNode } from "react";
import { newServer, newTestRuntime } from "../../../../test/app.tsx";
import { AppProviders } from "../../../app/context.tsx";
import { useDirectory } from "../shared.tsx";
import { ConnectorScopeCard } from "./ConnectorScope.tsx";
import { QuestionCard } from "./Question.tsx";

const WORKSPACE = "workspace_birchwood";
const question = (fields: Partial<AgentQuestion> = {}): AgentQuestion => ({
  id: "q_paper",
  agentId: "agt_scout",
  answer: null,
  askedUserId: "usr_ana",
  channelId: "ch_general",
  choices: ["Matte", "Gloss"],
  createdAt: "2026-11-14T11:00:00.000Z",
  responderUserId: null,
  status: "open",
  text: "Which paper for the Hartley cards?",
  threadId: null,
  ...fields,
});

type Props = { me: { userId: string; role: Role }; directory: ReturnType<typeof useDirectory> };

/** Renders the card for one seeded person, with their role in Birchwood. */
async function show(
  who: { userId: string; role: Role },
  server: ReturnType<typeof newServer>,
  card: (props: Props) => ReactNode,
) {
  const { runtime } = newTestRuntime({ path: "/", server, signedInAs: who.userId });
  function Card() {
    const directory = useDirectory(WORKSPACE);
    return <>{card({ me: who, directory })}</>;
  }
  await act(async () => {
    render(
      <AppProviders runtime={runtime}>
        <Card />
      </AppProviders>,
    );
  });
}

const ANA = { userId: "usr_ana", role: "owner" } as const;
const JONAS = { userId: "usr_jonas", role: "admin" } as const;
const TOMAS = { userId: "usr_tomas", role: "member" } as const;

describe("the agent's question", () => {
  test("the person asked picks an answer; the card shows who answered", async () => {
    const server = newServer();
    server.control.questions = [{ workspaceId: WORKSPACE, question: question() }];
    await show(ANA, server, (props) => (
      <QuestionCard
        workspaceId={WORKSPACE}
        question={server.control.questions[0]?.question ?? question()}
        {...props}
      />
    ));
    const card = await screen.findByRole("region", { name: "Scout asks" });
    expect(within(card).getByText("Pick an answer, or reply in the conversation.")).toBeDefined();
    await userEvent.setup().click(within(card).getByRole("button", { name: "Gloss" }));
    expect(server.control.questions[0]?.question).toMatchObject({ status: "answered", answer: "Gloss" });
  });

  test("someone else sees who it waits for, and an answered one says who answered", async () => {
    const server = newServer();
    await show(TOMAS, server, (props) => (
      <>
        <QuestionCard workspaceId={WORKSPACE} question={question()} {...props} />
        <QuestionCard
          workspaceId={WORKSPACE}
          question={question({
            id: "q_done",
            status: "answered",
            answer: "Matte",
            responderUserId: "usr_ana",
          })}
          {...props}
        />
      </>
    ));
    expect(await screen.findByText("Waiting for Ana Beatriz Souza to answer.")).toBeDefined();
    const buttons = screen.getAllByRole("button", { name: "Gloss" });
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByText("Ana Beatriz Souza answered: Matte")).toBeDefined();
  });

  test("an answer that did not go through says so", async () => {
    const server = newServer();
    await show(ANA, server, (props) => (
      <QuestionCard workspaceId={WORKSPACE} question={question()} {...props} />
    ));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Matte" }));
    expect(await screen.findByText(/^The answer was not sent:/)).toBeDefined();
  });
});

describe("the missing connector permission", () => {
  const card = (owner: "agent" | "workspace"): NonNullable<MessageMeta["connectorScope"]> => ({
    connectionId: "conn_drive",
    connector: "drive",
    label: "Drive",
    owner,
    scopes: ["drive.file"],
    state: "pending",
    tool: "Upload a file",
  });

  test("a workspace account: whoever configures grants it, a member is told who can", async () => {
    const server = newServer();
    await show(JONAS, server, (props) => (
      <ConnectorScopeCard workspaceId={WORKSPACE} card={card("workspace")} agentId="agt_scout" {...props} />
    ));
    const region = await screen.findByRole("region", { name: "Scout needs more access to Drive" });
    expect(within(region).getByRole("button", { name: "Grant access" })).toBeDefined();
    expect(within(region).getByText("drive.file")).toBeDefined();
  });

  test("the agent's own account: its owner grants it, anyone else asks", async () => {
    const server = newServer();
    await show(TOMAS, server, (props) => (
      <ConnectorScopeCard workspaceId={WORKSPACE} card={card("agent")} agentId="agt_scout" {...props} />
    ));
    const region = await screen.findByRole("region", {
      name: "Scout needs more access to its own Drive account",
    });
    expect(within(region).queryByRole("button", { name: "Grant access" }) === null).toBe(true);
    expect(
      within(region).getByText("Ask the agent's owner, or someone who manages agents, to grant it."),
    ).toBeDefined();
  });

  test("the agent's own account: its owner grants it without configuring connectors", async () => {
    const server = newServer();
    const scout = server.agents.find((each) => each.id === "agt_scout");
    const own = server.agentAccess.accounts.get("agt_scout")?.[0];
    if (scout === undefined || own === undefined) throw new Error("the seed has Scout's own Linear account");
    // Tomás is a member: he may not configure connectors, but he edits the agent he owns.
    scout.ownerUserId = TOMAS.userId;
    own.scopeRequest = { scope: "issues:write", tool: "Create an issue" };
    const left: string[] = [];
    const assign = spyOn(window.location, "assign").mockImplementation((url: string | URL) => {
      left.push(String(url));
    });
    try {
      await show(TOMAS, server, (props) => (
        <ConnectorScopeCard
          workspaceId={WORKSPACE}
          card={{ ...card("agent"), connectionId: own.id, connector: "linear", label: "Linear" }}
          agentId="agt_scout"
          {...props}
        />
      ));
      const region = await screen.findByRole("region", {
        name: "Scout needs more access to its own Linear account",
      });
      await userEvent.setup().click(within(region).getByRole("button", { name: "Grant access" }));
      await waitFor(() => expect(left).toEqual(["https://linear.example/authorize?more=1"]));
    } finally {
      assign.mockRestore();
    }
  });
});

describe("the fake's rule for more connector scope, as the server's", () => {
  const ask = (server: ReturnType<typeof newServer>, userId: string, connectorId: string) => {
    const operation = server.connections.operations().createConnectorScope;
    if (operation === undefined) throw new Error("the fake has createConnectorScope");
    const answer = operation(
      { workspaceId: WORKSPACE, connectorId, nextPath: "/" },
      server.sessionFor(userId),
    ) as { status: number; body: { error?: { code: string } } };
    return [answer.status, answer.body.error?.code ?? null];
  };
  const seeded = () => {
    const server = newServer();
    const scout = server.agents.find((each) => each.id === "agt_scout");
    const own = server.agentAccess.accounts.get("agt_scout")?.[0];
    const shared = server.agentAccess.shared[0];
    if (scout === undefined || own === undefined || shared === undefined)
      throw new Error("the seed has Scout's own Linear account and a shared one");
    own.scopeRequest = { scope: "issues:write", tool: "Create an issue" };
    shared.scopeRequest = { scope: "issues:write", tool: "Create an issue" };
    return { server, scout, own, shared };
  };

  test("an agent's own account: only who edits the agent", () => {
    const { server, scout, own } = seeded();
    scout.ownerUserId = ANA.userId;
    expect(ask(server, TOMAS.userId, own.id)).toEqual([403, "forbidden"]);
    scout.ownerUserId = TOMAS.userId;
    expect(ask(server, TOMAS.userId, own.id)).toEqual([200, null]);
  });

  test("a workspace account: only who configures", () => {
    const { server, shared } = seeded();
    expect(ask(server, TOMAS.userId, shared.id)).toEqual([403, "forbidden"]);
    expect(ask(server, JONAS.userId, shared.id)).toEqual([200, null]);
  });

  test("an agent's own account made with a key has no sign-in to widen either", () => {
    const { server, scout } = seeded();
    const connect = server.agentAccess.operations().createAgentIdentityConnection;
    if (connect === undefined) throw new Error("the fake has createAgentIdentityConnection");
    // Scout's seeded Linear account signed in; Stripe connects with a key.
    const made = connect(
      { workspaceId: WORKSPACE, agentId: scout.id, connector: "stripe", apiKey: "12345678" },
      server.sessionFor(scout.ownerUserId),
    ) as { status: number; body: { status: string; connection: { id: string } } };
    expect([made.status, made.body.status]).toEqual([200, "connected"]);
    const keyed = server.agentAccess.accounts
      .get(scout.id)
      ?.find((each) => each.id === made.body.connection.id);
    if (keyed === undefined) throw new Error("the key connected");
    keyed.scopeRequest = { scope: "charges:write", tool: "Refund" };
    expect(ask(server, scout.ownerUserId, keyed.id)).toEqual([400, "connector.no_scope_request"]);
  });

  test("a connection made with a key has no sign-in to widen", () => {
    const { server } = seeded();
    const create = server.connections.operations().createConnector;
    if (create === undefined) throw new Error("the fake has createConnector");
    const made = create(
      { workspaceId: WORKSPACE, connector: "stripe", apiKey: "12345678" },
      server.sessionFor(JONAS.userId),
    ) as { status: number; body: { id: string } };
    const keyed = server.agentAccess.shared.find((each) => each.id === made.body.id);
    if (keyed === undefined) throw new Error("the key connected");
    keyed.scopeRequest = { scope: "charges:write", tool: "Refund" };
    expect(ask(server, JONAS.userId, keyed.id)).toEqual([400, "connector.no_scope_request"]);
  });
});
