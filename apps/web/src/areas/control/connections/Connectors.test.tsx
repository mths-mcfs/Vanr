// The Connectors section of the settings, against the fake server. Ana owns Birchwood, Jonas is an admin
// there, Íris is a member. The catalog offers Linear (sign-in or key) and Stripe (key only).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { Connection } from "@vanr/contract";
import { chooseOption, newServer, renderApp } from "../../../../test/app.tsx";

const WS = "workspace_birchwood";
const PATH = `/workspace/${WS}/settings/connectors`;
const BACK = `/workspace/${WS}/settings/connectors`;

let left: string[] = [];
let assign: ReturnType<typeof spyOn>;
beforeEach(() => {
  left = [];
  assign = spyOn(window.location, "assign").mockImplementation((url: string | URL) => {
    left.push(String(url));
  });
});
afterEach(() => assign.mockRestore());

const services = () => screen.findByRole("list", { name: "Services" });
const row = (list: HTMLElement, name: string) => {
  const found = within(list)
    .getAllByRole("listitem")
    .find((item) => item.textContent?.includes(name));
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
};
const connection = (connector: string, patch: Partial<Connection> = {}) => ({
  id: `con_${connector}`,
  workspaceId: WS,
  connector,
  label: connector,
  accountDisplayName: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  revokedAt: null,
  status: "active" as const,
  scopeRequest: null,
  ...patch,
});
const toast = (text: string) => screen.findByText(text);

describe("services", () => {
  test("a member is not offered the section and its address says why", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_iris" });
    expect(await screen.findByText("This section is for admins")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Connectors" }) === null).toBe(true);
    expect(screen.queryByRole("list", { name: "Services" }) === null).toBe(true);
  });

  test("an admin connects Stripe with a key; the key never stays anywhere once the dialog closes", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const stripe = row(await services(), "Stripe");
    await app.user.click(within(stripe).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Stripe" });
    expect(within(dialog).queryByRole("button", { name: /Sign in on/ }) === null).toBe(true);
    const key = within(dialog).getByLabelText("Key");
    await app.user.type(key, "sk_1");
    expect(within(dialog).getByText("A key has at least 8 characters.")).toBeDefined();
    const send = within(dialog).getByRole("button", { name: "Connect with this key" });
    expect(send.hasAttribute("disabled")).toBe(true);
    await app.user.type(key, "23456789");
    await app.user.click(send);
    expect(await toast("Stripe is connected.")).toBeDefined();
    expect(screen.queryByRole("dialog") === null).toBe(true);
    expect(within(row(await services(), "Stripe")).getByText("Connected")).toBeDefined();
    const sent = app.server.calls.filter((call) => call.method === "createConnector");
    expect(sent.map((call) => call.params.apiKey)).toEqual(["sk_123456789"]);
    // Nothing the app keeps holds the key: not the address, the cache of calls or the browser's storage.
    expect(app.address().includes("sk_")).toBe(false);
    const cached = JSON.stringify([
      app.runtime.queryClient
        .getMutationCache()
        .getAll()
        .map((each) => each.state.variables),
      app.runtime.queryClient
        .getQueryCache()
        .getAll()
        .map((each) => each.state.data),
    ]);
    expect(cached.includes("sk_123456789")).toBe(false);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage }).includes("sk_")).toBe(false);
  });

  test("a refused key says why in the dialog and connects nothing", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(row(await services(), "Stripe")).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Stripe" });
    await app.user.type(within(dialog).getByLabelText("Key"), "rejected-key");
    await app.user.click(within(dialog).getByRole("button", { name: "Connect with this key" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "The service refused that key. Check it and paste it again.",
    );
    expect(app.server.agentAccess.shared.some((each) => each.connector === "stripe")).toBe(false);
  });

  test("two quick presses connect once", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(row(await services(), "Stripe")).getByRole("button", { name: "Connect" }));
    const form = await screen.findByRole("form", { name: "Key for Stripe" });
    await app.user.type(within(form).getByLabelText("Key"), "sk_live_123456");
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(await toast("Stripe is connected.")).toBeDefined();
    expect(app.server.calls.filter((call) => call.method === "createConnector").length).toBe(1);
  });

  test("signing in on Linear leaves for its page and asks to come back to this section", async () => {
    const server = newServer();
    server.agentAccess.shared.length = 0;
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    await app.user.click(within(row(await services(), "Linear")).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Linear" });
    expect(within(dialog).getByText("Sign in on Linear, or paste a key made there.")).toBeDefined();
    await app.user.click(within(dialog).getByRole("button", { name: "Sign in on Linear" }));
    await act(async () => {});
    expect(left).toEqual(["https://linear.example/authorize"]);
    const started = app.server.calls.find((call) => call.method === "startConnectorOauth");
    expect(started?.params.nextPath).toBe(BACK);
  });

  test("coming back from a sign-in says how it went once and clears the address", async () => {
    const server = newServer();
    server.agentAccess.shared.push(connection("linear", { label: "Linear" }));
    const app = await renderApp({ path: `${PATH}?connected=linear`, signedInAs: "usr_jonas", server });
    expect(await toast("Linear is connected.")).toBeDefined();
    expect(app.address()).toBe(BACK);
    expect(within(row(await services(), "Linear")).getByText("Connected")).toBeDefined();
  });

  test("a failed sign-in or GitHub install comes back as a plain reason", async () => {
    const app = await renderApp({ path: `${PATH}?connector_error=denied`, signedInAs: "usr_jonas" });
    expect(await toast("The service did not give access.")).toBeDefined();
    expect(app.address()).toBe(BACK);
    const other = await renderApp({ path: `${PATH}?connector_error=whatever`, signedInAs: "usr_jonas" });
    expect(await toast("The sign-in did not finish.")).toBeDefined();
    expect(other.address()).toBe(BACK);
    await renderApp({ path: `${PATH}?github_app=taken`, signedInAs: "usr_jonas" });
    expect(await toast("That GitHub account already belongs to another workspace.")).toBeDefined();
  });

  test("a connection the service stopped accepting is connected again as a new one", async () => {
    const server = newServer();
    server.agentAccess.shared.push(connection("stripe", { status: "reauth_required" }));
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const stripe = row(await services(), "Stripe");
    expect(stripe.getAttribute("data-state")).toBe("reauth_required");
    expect(within(stripe).getByText("Sign-in refused")).toBeDefined();
    expect(within(stripe).getByText(/give agents access to the new connection/)).toBeDefined();
    const toAccess = within(stripe).getByRole("link", { name: "Open the agents' access" });
    expect(toAccess.getAttribute("href")).toBe(`/workspace/${WS}/settings/access`);
    await app.user.click(within(stripe).getByRole("button", { name: "Connect again" }));
    expect(await screen.findByRole("dialog", { name: "Connect Stripe again" })).toBeDefined();
  });

  test("each connection of a service gets its own row and controls", async () => {
    const server = newServer();
    server.agentAccess.shared.length = 0;
    server.agentAccess.shared.push(
      connection("linear", { id: "con_old", status: "reauth_required", accountDisplayName: "old@birch" }),
      connection("linear", { id: "con_new", accountDisplayName: "ops@birch" }),
    );
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await services();
    const linear = within(list)
      .getAllByRole("listitem")
      .filter((item) => item.textContent?.includes("Linear"));
    expect(linear.map((item) => item.getAttribute("data-state"))).toEqual(["reauth_required", "active"]);
    // With a working connection beside it, the refused one only offers to be disconnected.
    expect(within(list).queryByRole("button", { name: "Connect again" }) === null).toBe(true);
    await app.user.click(within(list).getByRole("button", { name: "Disconnect Linear (old@birch, 1)" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Disconnect Linear?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    expect(await toast("Linear is disconnected.")).toBeDefined();
    expect(server.agentAccess.shared.map((each) => each.id)).toEqual(["con_new"]);
  });

  test("a tool that needs one more permission can be granted from its row", async () => {
    const server = newServer();
    server.agentAccess.shared.length = 0;
    server.agentAccess.shared.push(
      connection("linear", { scopeRequest: { scope: "write:issues", tool: "create_issue" } }),
    );
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const linear = row(await services(), "Linear");
    expect(
      within(linear).getByText("A tool (create_issue) needs one more permission: write:issues."),
    ).toBeDefined();
    await app.user.click(within(linear).getByRole("button", { name: "Grant it" }));
    await act(async () => {});
    expect(left).toEqual(["https://linear.example/authorize?more=1"]);
  });

  test("disconnecting asks first, then the service is open again", async () => {
    const server = newServer();
    server.agentAccess.shared.push(connection("stripe"));
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(
      within(row(await services(), "Stripe")).getByRole("button", { name: "Disconnect Stripe" }),
    );
    const confirm = await screen.findByRole("alertdialog", { name: "Disconnect Stripe?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    expect(await toast("Stripe is disconnected.")).toBeDefined();
    expect(server.agentAccess.shared.some((each) => each.connector === "stripe")).toBe(false);
    expect(within(row(await services(), "Stripe")).getByRole("button", { name: "Connect" })).toBeDefined();
  });

  test("a connection someone else removed meanwhile is dropped from the screen", async () => {
    const server = newServer();
    server.agentAccess.shared.push(connection("stripe"));
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(
      within(row(await services(), "Stripe")).getByRole("button", { name: "Disconnect Stripe" }),
    );
    server.agentAccess.shared.splice(
      server.agentAccess.shared.findIndex((each) => each.connector === "stripe"),
      1,
    );
    const confirm = await screen.findByRole("alertdialog", { name: "Disconnect Stripe?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    expect(await toast("That no longer exists.")).toBeDefined();
    expect(
      await within(row(await services(), "Stripe")).findByRole("button", { name: "Connect" }),
    ).toBeDefined();
  });

  test("closing a dialog gives the focus back to what opened it", async () => {
    const server = newServer();
    server.agentAccess.shared.push(connection("stripe"));
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const disconnect = within(row(await services(), "Stripe")).getByRole("button", {
      name: "Disconnect Stripe",
    });
    await app.user.click(disconnect);
    await screen.findByRole("alertdialog", { name: "Disconnect Stripe?" });
    await app.user.keyboard("{Escape}");
    await act(async () => {});
    expect(document.activeElement === disconnect).toBe(true);
  });

  test("once the row it came from is gone, the focus goes to the block's heading", async () => {
    const server = newServer();
    server.agentAccess.shared.push(connection("stripe"));
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(
      within(row(await services(), "Stripe")).getByRole("button", { name: "Disconnect Stripe" }),
    );
    const confirm = await screen.findByRole("alertdialog", { name: "Disconnect Stripe?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    expect(await toast("Stripe is disconnected.")).toBeDefined();
    await act(async () => {});
    expect(document.activeElement?.textContent).toBe("Services");
  });

  test("a sign-in link naming a service the catalog doesn't have announces nothing", async () => {
    const app = await renderApp({ path: `${PATH}?connected=your-bank-account`, signedInAs: "usr_jonas" });
    expect(await toast("A sign-in came back. The list below shows what is connected now.")).toBeDefined();
    expect(screen.queryByText(/your-bank-account/) === null).toBe(true);
    expect(app.address()).toBe(BACK);
  });

  test("a sign-in link naming a service that is not available announces nothing", async () => {
    const server = newServer();
    const catalog = (await import("../../../../dev/fake-agent-access.ts")).FAKE_CATALOG;
    const stripe = catalog.connectors.find((each) => each.id === "stripe");
    if (stripe === undefined) throw new Error("no Stripe in the fake catalog");
    stripe.available = false;
    try {
      await renderApp({ path: `${PATH}?connected=stripe`, signedInAs: "usr_jonas", server });
      expect(await toast("A sign-in came back. The list below shows what is connected now.")).toBeDefined();
      expect(screen.queryByText("Stripe is connected.") === null).toBe(true);
    } finally {
      stripe.available = true;
    }
  });

  test("a sign-in link naming an MCP server the workspace doesn't have announces nothing", async () => {
    await renderApp({ path: `${PATH}?connected=custom:con_nowhere`, signedInAs: "usr_jonas" });
    expect(await toast("A sign-in came back. The list below shows what is connected now.")).toBeDefined();
    expect(screen.queryByText("The server is connected. Choose what its tools may do.") === null).toBe(true);
    expect(screen.queryByRole("dialog") === null).toBe(true);
  });

  test("two key connections of one service are told apart by when they were made", async () => {
    const server = newServer();
    server.agentAccess.shared.push(
      connection("stripe", { id: "con_a", label: "Stripe", createdAt: "2026-11-01T10:00:00.000Z" }),
      connection("stripe", { id: "con_b", label: "Stripe", createdAt: "2026-11-10T15:30:00.000Z" }),
    );
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await services();
    const names = within(list)
      .getAllByRole("button", { name: /^Disconnect Stripe/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(names.length).toBe(2);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => name?.startsWith("Disconnect Stripe (Connected Nov"))).toBe(true);
  });

  test("two connections made in the same minute still get different names", async () => {
    const server = newServer();
    server.agentAccess.shared.push(
      connection("stripe", { id: "con_a", label: "Stripe", createdAt: "2026-11-10T15:30:01.000Z" }),
      connection("stripe", { id: "con_b", label: "Stripe", createdAt: "2026-11-10T15:30:45.000Z" }),
    );
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const names = within(await services())
      .getAllByRole("button", { name: /^Disconnect Stripe/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(names.length).toBe(2);
    expect(new Set(names).size).toBe(2);
  });

  test("an account already named like a numbered one never shares its button's name", async () => {
    const server = newServer();
    server.agentAccess.shared.push(
      connection("stripe", { id: "con_a", accountDisplayName: "Team" }),
      connection("stripe", { id: "con_b", accountDisplayName: "Team, 1" }),
      connection("stripe", { id: "con_c", accountDisplayName: "Team" }),
    );
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const names = within(await services())
      .getAllByRole("button", { name: /^Disconnect Stripe/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(names.length).toBe(3);
    expect(new Set(names).size).toBe(3);
  });

  test("an account already named like a numbered one never shares its button's name", async () => {
    const server = newServer();
    server.agentAccess.shared.push(
      connection("stripe", { id: "con_a", accountDisplayName: "Team" }),
      connection("stripe", { id: "con_b", accountDisplayName: "Team, 1" }),
      connection("stripe", { id: "con_c", accountDisplayName: "Team" }),
    );
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const names = within(await services())
      .getAllByRole("button", { name: /^Disconnect Stripe/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(names.length).toBe(3);
    expect(new Set(names).size).toBe(3);
  });

  test("a list that fails to load offers a retry", async () => {
    const server = newServer();
    server.force("listConnectors", { kind: "error", status: 500, code: "internal" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("The services could not be loaded")).toBeDefined();
    server.unforce("listConnectors");
    await app.user.click(screen.getAllByRole("button", { name: "Retry" })[0] as HTMLElement);
    expect(await services()).toBeDefined();
  });
});

describe("own MCP servers", () => {
  const servers = () => screen.findByRole("region", { name: "Your MCP servers" });

  test("an empty list says how to start", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    expect(await within(await servers()).findByText("No MCP servers yet")).toBeDefined();
  });

  test("a new server's tools are reviewed and saved before agents may use them", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await servers()).getByRole("button", { name: "Add a server" }));
    const add = await screen.findByRole("dialog", { name: "Add an MCP server" });
    await app.user.type(within(add).getByLabelText("Address"), "https://billing.example/mcp");
    await app.user.type(within(add).getByLabelText("Name"), "Billing");
    await app.user.click(within(add).getByRole("button", { name: "Add server" }));
    const review = await screen.findByRole("dialog", { name: "Tools of Billing" });
    const tools = within(review).getByRole("list", { name: "Tools" });
    expect(within(tools).getAllByText("The server suggests: Use it freely (reads)").length).toBe(1);
    expect(within(tools).getAllByText("The server suggests: Use it after a person approves").length).toBe(1);
    await chooseOption(
      app,
      within(review).getByRole("combobox", { name: "What agents may do with void_invoice" }),
      "Not use it",
    );
    await app.user.type(
      within(review).getByRole("textbox", { name: "Name shown for find_invoice" }),
      "Find an invoice",
    );
    await app.user.click(within(review).getByRole("button", { name: "Save tools" }));
    expect(await toast("The tools of Billing are saved.")).toBeDefined();
    const saved = app.server.connections.servers[0];
    expect(saved?.tools.map((tool) => [tool.name, tool.access, tool.label, tool.confirmed])).toEqual([
      ["find_invoice", "read", "Find an invoice", true],
      ["void_invoice", "off", "", true],
    ]);
    const listed = within(await servers()).getByRole("list", { name: "Your MCP servers" });
    expect(within(row(listed, "Billing")).getByText("2 tools")).toBeDefined();
    expect(within(row(listed, "Billing")).queryByText(/to review/) === null).toBe(true);
  });

  test("a server that wants a key asks for one before it is added", async () => {
    const server = newServer();
    server.connections.keyServers.add("https://locked.example/mcp");
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await servers()).getByRole("button", { name: "Add a server" }));
    const add = await screen.findByRole("dialog", { name: "Add an MCP server" });
    await app.user.type(within(add).getByLabelText("Address"), "https://locked.example/mcp");
    await app.user.click(within(add).getByRole("button", { name: "Add server" }));
    expect(await within(add).findByText(/This server wants a key/)).toBeDefined();
    expect(within(add).getByRole("button", { name: "Add server" }).hasAttribute("disabled")).toBe(true);
    await app.user.type(within(add).getByLabelText(/^Key/), "mcp-key-123");
    await app.user.click(within(add).getByRole("button", { name: "Add server" }));
    expect(await screen.findByRole("dialog", { name: /^Tools of locked\.example/ })).toBeDefined();
  });

  test("changing the address after a key was asked for lets the new one be tried without a key", async () => {
    const server = newServer();
    server.connections.keyServers.add("https://locked.example/mcp");
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await servers()).getByRole("button", { name: "Add a server" }));
    const add = await screen.findByRole("dialog", { name: "Add an MCP server" });
    const address = within(add).getByLabelText("Address");
    await app.user.type(address, "https://locked.example/mcp");
    await app.user.click(within(add).getByRole("button", { name: "Add server" }));
    expect(await within(add).findByText(/This server wants a key/)).toBeDefined();
    await app.user.clear(address);
    await app.user.type(address, "https://open.example/mcp");
    expect(within(add).queryByText(/This server wants a key/) === null).toBe(true);
    await app.user.click(within(add).getByRole("button", { name: "Add server" }));
    expect(await screen.findByRole("dialog", { name: /^Tools of open\.example/ })).toBeDefined();
  });

  test("a review closes when its server turns out to be gone", async () => {
    const server = newServer();
    server.connections.servers.push({
      id: "con_billing",
      workspaceId: WS,
      label: "Billing",
      serverUrl: "https://billing.example/mcp",
      createdAt: "2026-11-01T10:00:00.000Z",
      vettedAt: null,
      tools: [],
      needsKey: false,
      oauth: false,
    });
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const listed = await within(await servers()).findByRole("list", { name: "Your MCP servers" });
    await app.user.click(within(row(listed, "Billing")).getByRole("button", { name: "Review tools" }));
    expect(await screen.findByRole("dialog", { name: "Tools of Billing" })).toBeDefined();
    server.force("getConnectorCustom", { kind: "error", status: 404, code: "not_found" }, 4);
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    expect(await within(await servers()).findByText("Your MCP servers could not be loaded")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Tools of Billing" }) === null).toBe(true);
  });

  test("access lost while adding a server closes the dialog and says so", async () => {
    const server = newServer();
    server.force("createConnectorCustom", { kind: "error", status: 403, code: "forbidden" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const opener = within(await servers()).getByRole("button", { name: "Add a server" });
    await app.user.click(opener);
    const add = await screen.findByRole("dialog", { name: "Add an MCP server" });
    await app.user.type(within(add).getByLabelText("Address"), "https://billing.example/mcp");
    await app.user.click(within(add).getByRole("button", { name: "Add server" }));
    expect(await toast("You don't have permission to do that.")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Add an MCP server" }) === null).toBe(true);
    await act(async () => {});
    expect(document.activeElement === opener).toBe(true);
  });

  test("a server that wants a sign-in leaves for it", async () => {
    const server = newServer();
    server.connections.oauthServers.add("https://sso.example/mcp");
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await servers()).getByRole("button", { name: "Add a server" }));
    const add = await screen.findByRole("dialog", { name: "Add an MCP server" });
    await app.user.type(within(add).getByLabelText("Address"), "https://sso.example/mcp");
    await app.user.click(within(add).getByRole("button", { name: "Add server" }));
    await act(async () => {});
    expect(left).toEqual(["https://mcp.example/authorize"]);
    expect(app.server.calls.find((call) => call.method === "createConnectorCustom")?.params.nextPath).toBe(
      BACK,
    );
  });

  test("an address the server refuses says why", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(within(await servers()).getByRole("button", { name: "Add a server" }));
    const add = await screen.findByRole("dialog", { name: "Add an MCP server" });
    await app.user.type(within(add).getByLabelText("Address"), "ftp://files.example/mcp");
    await app.user.click(within(add).getByRole("button", { name: "Add server" }));
    expect((await within(add).findByRole("alert")).textContent).toBe(
      "That address is not one Vanr can use. Use a full https:// address.",
    );
  });

  test("a server is refreshed and removed from its row", async () => {
    const server = newServer();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    await app.user.click(within(await servers()).getByRole("button", { name: "Add a server" }));
    const add = await screen.findByRole("dialog", { name: "Add an MCP server" });
    await app.user.type(within(add).getByLabelText("Address"), "https://billing.example/mcp");
    await app.user.type(within(add).getByLabelText("Name"), "Billing");
    await app.user.click(within(add).getByRole("button", { name: "Add server" }));
    const review = await screen.findByRole("dialog", { name: "Tools of Billing" });
    await app.user.click(within(review).getByRole("button", { name: "Cancel" }));
    const listed = within(await servers()).getByRole("list", { name: "Your MCP servers" });
    expect(within(row(listed, "Billing")).getByText("2 to review")).toBeDefined();
    await app.user.click(
      within(row(listed, "Billing")).getByRole("button", { name: "Refresh the tools of Billing" }),
    );
    expect(await toast("Billing lists 2 tools.")).toBeDefined();
    await app.user.click(within(row(listed, "Billing")).getByRole("button", { name: "Remove Billing" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Billing?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(await toast("Billing is removed.")).toBeDefined();
    expect(server.connections.servers.length).toBe(0);
  });

  test("coming back from a server's sign-in opens its tools for review", async () => {
    const server = newServer();
    server.connections.servers.push({
      id: "con_sso",
      workspaceId: WS,
      label: "Helpdesk",
      serverUrl: "https://sso.example/mcp",
      createdAt: "2026-11-01T10:00:00.000Z",
      vettedAt: null,
      tools: [],
      needsKey: false,
      oauth: true,
    });
    const app = await renderApp({
      path: `${PATH}?connected=custom:con_sso`,
      signedInAs: "usr_jonas",
      server,
    });
    expect(await toast("The server is connected. Choose what its tools may do.")).toBeDefined();
    const review = await screen.findByRole("dialog", { name: "Tools of Helpdesk" });
    expect(within(review).getByText("The server lists no tools. Refresh it once it has some.")).toBeDefined();
    expect(app.address()).toBe(BACK);
    // Nothing on the page opened it: closing it leaves the focus on its block's heading.
    await app.user.keyboard("{Escape}");
    await act(async () => {});
    expect(document.activeElement?.textContent).toBe("Your MCP servers");
  });
});

describe("GitHub", () => {
  const github = () => screen.findByRole("region", { name: "GitHub" });

  test("a server without the app says so and offers no install", async () => {
    const server = newServer();
    server.connections.githubInstallable = false;
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const block = await github();
    expect(await within(block).findByText("GitHub is not set up on this server")).toBeDefined();
    expect(within(block).queryByRole("button", { name: "Install on GitHub" }) === null).toBe(true);
  });

  test("repository counts from before a refused read are not shown as current", async () => {
    const server = newServer();
    server.connections.installations.push({
      id: "ins_birch",
      workspaceId: WS,
      accountUsername: "birchwood-labs",
      repoScope: "all",
      suspended: false,
      repositories: [{ fullName: "birchwood-labs/site", private: false }],
    });
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await github()).findByRole("list", { name: "GitHub" });
    expect(await within(row(list, "birchwood-labs")).findByText("1 repository")).toBeDefined();
    server.force("listGithubRepositories", { kind: "error", status: 403, code: "forbidden" }, 4);
    await act(async () => {
      await app.runtime.queryClient.refetchQueries();
    });
    expect(
      await within(await github()).findByText("The repository counts could not be loaded."),
    ).toBeDefined();
    expect(within(row(list, "birchwood-labs")).queryByText("1 repository") === null).toBe(true);
  });

  test("installing leaves for GitHub and asks to come back here", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const block = await github();
    expect(await within(block).findByText("No GitHub account linked")).toBeDefined();
    await app.user.click(within(block).getByRole("button", { name: "Install on GitHub" }));
    await act(async () => {});
    expect(left).toEqual(["https://github.example/apps/vanr/installations/new"]);
    expect(app.server.calls.find((call) => call.method === "installGithubApp")?.params.nextPath).toBe(BACK);
  });

  test("each install shows what it shares or that GitHub suspended it, and can be removed", async () => {
    const server = newServer();
    server.connections.installations.push(
      {
        id: "ins_birch",
        workspaceId: WS,
        accountUsername: "birchwood-labs",
        repoScope: "selected",
        suspended: false,
        repositories: [
          { fullName: "birchwood-labs/print-shop", private: true },
          { fullName: "birchwood-labs/site", private: false },
        ],
      },
      {
        id: "ins_old",
        workspaceId: WS,
        accountUsername: "old-shop",
        repoScope: "all",
        suspended: true,
        repositories: [],
      },
    );
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const list = await within(await github()).findByRole("list", { name: "GitHub" });
    const birch = row(list, "birchwood-labs");
    expect(within(birch).getByText("Chosen repositories")).toBeDefined();
    expect(await within(birch).findByText("2 repositories")).toBeDefined();
    const old = row(list, "old-shop");
    expect(old.getAttribute("data-state")).toBe("suspended");
    expect(within(old).getByText("Suspended on GitHub")).toBeDefined();
    expect(within(old).queryByText(/^\d+ repositor/) === null).toBe(true);
    await app.user.click(within(old).getByRole("button", { name: "Remove the install on old-shop" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove the install on old-shop?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(await toast("The install on old-shop is removed.")).toBeDefined();
    expect(server.connections.installations.map((each) => each.id)).toEqual(["ins_birch"]);
  });
});
