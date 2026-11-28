// An agent's mailboxes, databases and repositories, on its Access tab, against the fake server. Scout is
// Ana's agent in Birchwood; Jonas manages agents there, Íris is a member.
import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type * as T from "@vanr/contract";
import type { FakeDatabase, FakeMailAccount } from "../../../dev/fake-connections.ts";
import { chooseOption, newServer, newTestRuntime, renderApp } from "../../../test/app.tsx";
import { blurOnDisable } from "../../../test/focus.ts";

const WS = "workspace_birchwood";
const PATH = `/workspace/${WS}/agents/agt_scout?tab=access`;

const orders = (): FakeMailAccount => ({
  id: "mail_orders",
  workspaceId: WS,
  address: "orders@birchwood.example",
  label: "orders@birchwood.example",
  preset: "gmail",
  provider: "gmail",
  via: "imap",
  status: "active",
  agents: [],
  confirmActions: [],
  disabledActions: [],
});
const shop = (patch: Partial<FakeDatabase> = {}): FakeDatabase => ({
  id: "dbc_shop",
  workspaceId: WS,
  label: "Shop",
  provider: "supabase",
  host: "db.shop.example",
  port: 5432,
  database: "shop",
  username: "reader",
  sslmode: "require",
  status: "active",
  canWrite: false,
  hiddenSuggestion: ["public.customers.card_number"],
  disabledActions: [],
  agents: [],
  ...patch,
});
const readOnly = (patch: Partial<T.MailPolicy> = {}): T.AgentMailbox => ({
  accountId: "mail_orders",
  level: "read",
  deletable: false,
  policy: {
    folders: ["Inbox"],
    senderAllowlist: ["@shop.example"],
    lookbackDays: 30,
    recipientAllowlist: [],
    sendsPerDay: 25,
    autoSend: false,
    senderAddress: null,
    ...patch,
  },
});
/** Loads again what the screen shows of the agent's sources, as a refresh would. */
const refresh = async (app: Awaited<ReturnType<typeof renderApp>>) => {
  await act(async () => {
    await app.runtime.queryClient.refetchQueries({ type: "active" });
  });
};
const seeded = () => {
  const server = newServer();
  server.connections.mail.push(orders());
  server.connections.databases.push(shop());
  server.connections.tables.set("dbc_shop", [
    { schema: "public", name: "customers" },
    { schema: "public", name: "orders" },
    { schema: "sales", name: "Leads" },
  ]);
  return server;
};

const count = (server: ReturnType<typeof newServer>, method: string) =>
  server.calls.filter((call) => call.method === method).length;
const birchwoodGitHub = (server: ReturnType<typeof newServer>) =>
  server.connections.installations.push({
    id: "ins_birch",
    workspaceId: WS,
    accountUsername: "birchwood-labs",
    repoScope: "selected",
    suspended: false,
    repositories: [
      { fullName: "birchwood-labs/print-shop", private: true },
      { fullName: "birchwood-labs/site", private: false },
    ],
  });
const dbLink = (patch: Partial<T.DatabasePolicy> = {}, level: "read" | "none" = "read"): T.AgentDatabase => ({
  connectionId: "dbc_shop",
  level,
  policy: {
    tables: ["public.customers"],
    maskedColumns: [],
    queriesPerDay: 200,
    timeoutSeconds: 30,
    ...patch,
  },
});

describe("mailboxes", () => {
  const part = () => screen.findByRole("region", { name: "Mailboxes" });

  test("a member reads the mailbox access and changes nothing", async () => {
    const server = seeded();
    server.connections.mailboxes.set("agt_scout", [
      {
        accountId: "mail_orders",
        level: "read",
        deletable: false,
        policy: {
          folders: ["Inbox"],
          senderAllowlist: ["@shop.example"],
          lookbackDays: 30,
          recipientAllowlist: [],
          sendsPerDay: 25,
          autoSend: false,
          senderAddress: null,
        },
      },
    ]);
    await renderApp({ path: PATH, signedInAs: "usr_iris", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    const level = within(form).getByRole("combobox", {
      name: "What this agent may do with orders@birchwood.example",
    });
    expect(level.textContent).toBe("Read");
    expect(level.hasAttribute("disabled")).toBe(true);
    expect((within(form).getByLabelText(/^Only mail from/) as HTMLTextAreaElement).value).toBe(
      "@shop.example",
    );
    expect((within(form).getByLabelText(/^Days back/) as HTMLInputElement).value).toBe("30");
    expect(within(form).queryByRole("button", { name: "Save mailbox access" }) === null).toBe(true);
  });

  test("an admin lets the agent write to listed addresses and send to them without asking", async () => {
    const server = seeded();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "What this agent may do with orders@birchwood.example" }),
      "Read and write",
    );
    const autoSend = within(form).getByRole("checkbox", { name: /Send without asking/ });
    expect(autoSend.hasAttribute("disabled")).toBe(true);
    expect(within(form).getByText("List at least one address it may write to first.")).toBeDefined();
    const recipients = within(form).getByLabelText(/^May write to/);
    await app.user.type(recipients, "billing@shop.example\nnot-an-address");
    expect(within(form).getByText("“not-an-address” is not an address or an @domain.")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Save mailbox access" }).hasAttribute("disabled")).toBe(
      true,
    );
    await app.user.clear(recipients);
    await app.user.type(recipients, "billing@shop.example\n@birchwood.example");
    const sends = within(form).getByLabelText(/^Messages a day/);
    await app.user.clear(sends);
    await app.user.type(sends, "10");
    await app.user.click(within(form).getByRole("checkbox", { name: /Send without asking/ }));
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox access" }));
    expect(await screen.findByText("Access to orders@birchwood.example is saved.")).toBeDefined();
    const box = server.connections.mailboxes.get("agt_scout")?.[0];
    expect([
      box?.level,
      box?.policy.recipientAllowlist,
      box?.policy.sendsPerDay,
      box?.policy.autoSend,
    ]).toEqual(["read_write", ["billing@shop.example", "@birchwood.example"], 10, true]);
  });

  test("a day count out of range is refused before it is sent", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server: seeded() });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "What this agent may do with orders@birchwood.example" }),
      "Read",
    );
    await app.user.type(within(form).getByLabelText(/^Days back/), "9999");
    expect(within(form).getByText("A whole number from 1 to 3,650, or empty.")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Save mailbox access" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("a folder name with a comma stays one folder", async () => {
    const server = seeded();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "What this agent may do with orders@birchwood.example" }),
      "Read",
    );
    await app.user.type(within(form).getByLabelText(/^Only these folders/), "Clients, Brazil\nInbox");
    await app.user.type(within(form).getByLabelText(/^Only mail from/), "a@shop.example, @birch.example");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox access" }));
    expect(await screen.findByText("Access to orders@birchwood.example is saved.")).toBeDefined();
    const policy = server.connections.mailboxes.get("agt_scout")?.[0]?.policy;
    expect([policy?.folders, policy?.senderAllowlist]).toEqual([
      ["Clients, Brazil", "Inbox"],
      ["a@shop.example", "@birch.example"],
    ]);
  });

  test("a save sends what the person changed and keeps what someone else saved meanwhile", async () => {
    const server = seeded();
    server.connections.mailboxes.set("agt_scout", [readOnly()]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    const folders = within(form).getByLabelText(/^Only these folders/);
    await app.user.clear(folders);
    await app.user.type(folders, "Orders");
    // Another admin narrows the senders after this form loaded.
    server.connections.mailboxes.set("agt_scout", [readOnly({ senderAllowlist: ["boss@shop.example"] })]);
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox access" }));
    expect(await screen.findByText("Access to orders@birchwood.example is saved.")).toBeDefined();
    const box = server.connections.mailboxes.get("agt_scout")?.[0];
    expect([box?.level, box?.policy.folders, box?.policy.senderAllowlist]).toEqual([
      "read",
      ["Orders"],
      ["boss@shop.example"],
    ]);
    expect((within(form).getByLabelText(/^Only mail from/) as HTMLTextAreaElement).value).toBe(
      "boss@shop.example",
    );
  });

  test("a refresh while typing keeps what was typed and shows the rest as saved now", async () => {
    const server = seeded();
    server.connections.mailboxes.set("agt_scout", [readOnly()]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    const days = within(form).getByLabelText(/^Days back/);
    await app.user.clear(days);
    await app.user.type(days, "7");
    server.connections.mailboxes.set("agt_scout", [readOnly({ senderAllowlist: ["boss@shop.example"] })]);
    await refresh(app);
    await waitFor(() =>
      expect((within(form).getByLabelText(/^Only mail from/) as HTMLTextAreaElement).value).toBe(
        "boss@shop.example",
      ),
    );
    expect((within(form).getByLabelText(/^Days back/) as HTMLInputElement).value).toBe("7");
  });

  test("leaving the delete choice alone keeps it as saved", async () => {
    const server = seeded();
    server.connections.mailboxes.set("agt_scout", [
      { ...readOnly({ recipientAllowlist: ["billing@shop.example"] }), level: "read_write", deletable: true },
    ]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    const sends = within(form).getByLabelText(/^Messages a day/);
    await app.user.clear(sends);
    await app.user.type(sends, "5");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox access" }));
    expect(await screen.findByText("Access to orders@birchwood.example is saved.")).toBeDefined();
    const box = server.connections.mailboxes.get("agt_scout")?.[0];
    expect([box?.policy.sendsPerDay, box?.deletable]).toEqual([5, true]);
  });

  test("a mailbox removed meanwhile is refused, and leaves the list", async () => {
    const server = seeded();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    server.connections.mail.length = 0;
    await chooseOption(
      app,
      within(form).getByRole("combobox", { name: "What this agent may do with orders@birchwood.example" }),
      "Read",
    );
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox access" }));
    expect(await within(await part()).findByText("The workspace has no mailboxes")).toBeDefined();
  });

  test("while a save is on its way the form waits, and the button keeps the focus", async () => {
    const stop = blurOnDisable();
    try {
      const server = seeded();
      server.connections.mailboxes.set("agt_scout", [readOnly()]);
      const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
      const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
      const days = within(form).getByLabelText(/^Days back/);
      await app.user.clear(days);
      await app.user.type(days, "7");
      const held = server.hold("getAgentMail");
      const button = within(form).getByRole("button", { name: "Save mailbox access" });
      await app.user.click(button);
      expect(form.getAttribute("aria-busy")).toBe("true");
      expect(days.hasAttribute("disabled")).toBe(true);
      held.release();
      expect(await screen.findByText("Access to orders@birchwood.example is saved.")).toBeDefined();
      await waitFor(() => expect(document.activeElement === button).toBe(true));
      expect(server.calls.filter((call) => call.method === "replaceAgentMail").length).toBe(1);
    } finally {
      stop();
    }
  });

  test("a server error keeps what was typed, and the next save sends it", async () => {
    const server = seeded();
    server.connections.mailboxes.set("agt_scout", [readOnly()]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "orders@birchwood.example" });
    const days = within(form).getByLabelText(/^Days back/);
    await app.user.clear(days);
    await app.user.type(days, "7");
    server.force("replaceAgentMail", { kind: "error", status: 400, code: "validation" });
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox access" }));
    expect(await within(form).findByRole("alert")).toBeDefined();
    expect((within(form).getByLabelText(/^Days back/) as HTMLInputElement).value).toBe("7");
    await app.user.click(within(form).getByRole("button", { name: "Save mailbox access" }));
    expect(await screen.findByText("Access to orders@birchwood.example is saved.")).toBeDefined();
    expect(server.connections.mailboxes.get("agt_scout")?.[0]?.policy.lookbackDays).toBe(7);
  });

  test("mailboxes that fail to load offer a retry", async () => {
    const server = seeded();
    server.force("getAgentMail", { kind: "error", status: 500, code: "internal" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const region = await part();
    expect(await within(region).findByText("This agent's mailboxes could not be loaded")).toBeDefined();
    server.unforce("getAgentMail");
    await app.user.click(within(region).getByRole("button", { name: "Retry" }));
    expect(await within(await part()).findByRole("form", { name: "orders@birchwood.example" })).toBeDefined();
  });

  test("without mailboxes it says where they are connected", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    expect(await within(await part()).findByText("The workspace has no mailboxes")).toBeDefined();
  });
});

describe("databases", () => {
  const part = () => screen.findByRole("region", { name: "Databases" });

  test("an admin picks the tables, keeps the suggested hidden column and drops the daily limit", async () => {
    const server = seeded();
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    await app.user.click(within(form).getByRole("checkbox", { name: "May query Shop" }));
    const tables = await within(form).findByRole("list", { name: "Tables" });
    const boxes = within(tables).getAllByRole("checkbox");
    expect(boxes.map((each) => each.getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    expect(within(tables).getByText('sales."Leads"')).toBeDefined();
    await app.user.click(within(tables).getByRole("checkbox", { name: "public.orders" }));
    expect((within(form).getByLabelText(/^Hidden columns/) as HTMLTextAreaElement).value).toBe(
      "public.customers.card_number",
    );
    const queries = within(form).getByLabelText(/^Queries a day/);
    expect((queries as HTMLInputElement).value).toBe("200");
    await app.user.clear(queries);
    await app.user.click(within(form).getByRole("button", { name: "Save database access" }));
    expect(await screen.findByText("Access to Shop is saved.")).toBeDefined();
    const link = server.connections.agentDatabases.get("agt_scout")?.[0];
    expect([
      link?.level,
      link?.policy.tables,
      link?.policy.maskedColumns,
      link?.policy.queriesPerDay,
    ]).toEqual(["read", ["public.customers", 'sales."Leads"'], ["public.customers.card_number"], null]);
  });

  test("ticked tables go over the tables saved now, not over the ones the form loaded with", async () => {
    const server = seeded();
    const link = (tables: string[]): T.AgentDatabase => ({
      connectionId: "dbc_shop",
      level: "read",
      policy: { tables, maskedColumns: [], queriesPerDay: 200, timeoutSeconds: 30 },
    });
    server.connections.agentDatabases.set("agt_scout", [link(["public.customers", "public.orders"])]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    const tables = await within(form).findByRole("list", { name: "Tables" });
    await app.user.click(within(tables).getByRole("checkbox", { name: "public.orders" }));
    // Another admin adds the leads after this form loaded.
    server.connections.agentDatabases.set("agt_scout", [
      link(["public.customers", "public.orders", 'sales."Leads"']),
    ]);
    await app.user.click(within(form).getByRole("button", { name: "Save database access" }));
    expect(await screen.findByText("Access to Shop is saved.")).toBeDefined();
    expect(server.connections.agentDatabases.get("agt_scout")?.[0]?.policy.tables).toEqual([
      "public.customers",
      'sales."Leads"',
    ]);
  });

  test("a table named like an SQL word shows as saved", async () => {
    const server = seeded();
    server.connections.tables.set("dbc_shop", [
      { schema: "public", name: "order" },
      { schema: "public", name: "customers" },
    ]);
    server.connections.agentDatabases.set("agt_scout", [
      {
        connectionId: "dbc_shop",
        level: "read",
        policy: { tables: ['public."order"'], maskedColumns: [], queriesPerDay: 200, timeoutSeconds: 30 },
      },
    ]);
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    const tables = await within(form).findByRole("list", { name: "Tables" });
    expect(
      within(tables).getByRole("checkbox", { name: 'public."order"' }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(tables).getByRole("checkbox", { name: "public.customers" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("while a save is on its way the form waits, one save goes out, and the focus comes back", async () => {
    const stop = blurOnDisable();
    try {
      const server = seeded();
      server.connections.agentDatabases.set("agt_scout", [dbLink()]);
      const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
      const form = await within(await part()).findByRole("form", { name: "Shop" });
      const queries = within(form).getByLabelText(/^Queries a day/);
      await app.user.clear(queries);
      await app.user.type(queries, "50");
      const held = server.hold("listAgentDatabases");
      const button = within(form).getByRole("button", { name: "Save database access" });
      await app.user.click(button);
      act(() => {
        fireEvent.submit(form);
      });
      expect(form.getAttribute("aria-busy")).toBe("true");
      expect(queries.hasAttribute("disabled")).toBe(true);
      held.release();
      expect(await screen.findByText("Access to Shop is saved.")).toBeDefined();
      await waitFor(() => expect(document.activeElement === button).toBe(true));
      expect(count(server, "replaceAgentDatabase")).toBe(1);
    } finally {
      stop();
    }
  });

  test("a server error keeps what was typed", async () => {
    const server = seeded();
    server.connections.agentDatabases.set("agt_scout", [dbLink()]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    const queries = within(form).getByLabelText(/^Queries a day/);
    await app.user.clear(queries);
    await app.user.type(queries, "50");
    server.force("replaceAgentDatabase", { kind: "error", status: 400, code: "validation" });
    await app.user.click(within(form).getByRole("button", { name: "Save database access" }));
    expect(await within(form).findByRole("alert")).toBeDefined();
    expect((within(form).getByLabelText(/^Queries a day/) as HTMLInputElement).value).toBe("50");
  });

  test("unticking May query saves none and keeps the saved policy", async () => {
    const server = seeded();
    server.connections.agentDatabases.set("agt_scout", [dbLink({ queriesPerDay: 9 })]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    await app.user.click(within(form).getByRole("checkbox", { name: "May query Shop" }));
    await app.user.click(within(form).getByRole("button", { name: "Save database access" }));
    expect(await screen.findByText("Access to Shop is saved.")).toBeDefined();
    const saved = server.connections.agentDatabases.get("agt_scout")?.[0];
    expect([saved?.level, saved?.policy.queriesPerDay, saved?.policy.tables]).toEqual([
      "none",
      9,
      ["public.customers"],
    ]);
  });

  test("a link first saved at none shows the first-time defaults again, and saves them when raised", async () => {
    const server = seeded();
    server.connections.agentDatabases.set("agt_scout", [dbLink({ tables: [] }, "none")]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    await app.user.click(within(form).getByRole("checkbox", { name: "May query Shop" }));
    const tables = await within(form).findByRole("list", { name: "Tables" });
    expect(
      within(tables)
        .getAllByRole("checkbox")
        .map((each) => each.getAttribute("aria-checked")),
    ).toEqual(["true", "true", "true"]);
    expect((within(form).getByLabelText(/^Hidden columns/) as HTMLTextAreaElement).value).toBe(
      "public.customers.card_number",
    );
    await app.user.click(within(form).getByRole("button", { name: "Save database access" }));
    expect(await screen.findByText("Access to Shop is saved.")).toBeDefined();
    const policy = server.connections.agentDatabases.get("agt_scout")?.[0]?.policy;
    expect([policy?.tables, policy?.maskedColumns]).toEqual([
      ["public.customers", "public.orders", 'sales."Leads"'],
      ["public.customers.card_number"],
    ]);
  });

  test("a saved table the list no longer has shows as saved, and can be taken away", async () => {
    const server = seeded();
    server.connections.agentDatabases.set("agt_scout", [
      dbLink({ tables: ["public.customers", "public.gone"] }),
    ]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    const tables = await within(form).findByRole("list", { name: "Tables" });
    const gone = within(tables).getByRole("checkbox", { name: /public\.gone/ });
    expect(gone.getAttribute("aria-checked")).toBe("true");
    expect(within(tables).getByText("(saved, not in the list now)")).toBeDefined();
    await app.user.click(gone);
    await app.user.click(within(form).getByRole("button", { name: "Save database access" }));
    expect(await screen.findByText("Access to Shop is saved.")).toBeDefined();
    expect(server.connections.agentDatabases.get("agt_scout")?.[0]?.policy.tables).toEqual([
      "public.customers",
    ]);
  });

  test("databases that fail to load offer a retry", async () => {
    const server = seeded();
    server.force("listAgentDatabases", { kind: "error", status: 500, code: "internal" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const region = await part();
    expect(await within(region).findByText("This agent's databases could not be loaded")).toBeDefined();
    server.unforce("listAgentDatabases");
    await app.user.click(within(region).getByRole("button", { name: "Retry" }));
    expect(await within(await part()).findByRole("form", { name: "Shop" })).toBeDefined();
  });

  test("a member reads the chosen tables without asking the database for its list", async () => {
    const server = seeded();
    server.connections.agentDatabases.set("agt_scout", [
      {
        connectionId: "dbc_shop",
        level: "read",
        policy: { tables: ["public.orders"], maskedColumns: [], queriesPerDay: 50, timeoutSeconds: 15 },
      },
    ]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_iris", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    expect(
      within(within(form).getByRole("list", { name: "Tables" })).getByText("public.orders"),
    ).toBeDefined();
    expect(within(form).getByRole("checkbox", { name: "May query Shop" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(app.server.calls.some((call) => call.method === "listDatabaseTables")).toBe(false);
  });

  test("a list of tables that fails offers a retry and holds the save", async () => {
    const server = seeded();
    server.force("listDatabaseTables", { kind: "error", status: 400, code: "database.unreachable" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    await app.user.click(within(form).getByRole("checkbox", { name: "May query Shop" }));
    expect(await within(form).findByText("The database's tables could not be listed")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Save database access" }).hasAttribute("disabled")).toBe(
      true,
    );
    server.unforce("listDatabaseTables");
    await app.user.click(within(form).getByRole("button", { name: "Retry" }));
    expect(await within(form).findByRole("list", { name: "Tables" })).toBeDefined();
  });

  test("a saved link whose tables stay as they are saves while the database is down", async () => {
    const server = seeded();
    server.connections.databases[0] = shop({ status: "reauth_required" });
    server.connections.agentDatabases.set("agt_scout", [
      {
        connectionId: "dbc_shop",
        level: "read",
        policy: { tables: ["public.customers"], maskedColumns: [], queriesPerDay: 200, timeoutSeconds: 30 },
      },
    ]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    const queries = within(form).getByLabelText(/^Queries a day/);
    await app.user.clear(queries);
    await app.user.type(queries, "50");
    await app.user.click(within(form).getByRole("button", { name: "Save database access" }));
    expect(await screen.findByText("Access to Shop is saved.")).toBeDefined();
    const policy = server.connections.agentDatabases.get("agt_scout")?.[0]?.policy;
    expect([policy?.queriesPerDay, policy?.tables]).toEqual([50, ["public.customers"]]);
  });

  test("ticked tables hold the save when the list fails to load again", async () => {
    const server = seeded();
    server.connections.agentDatabases.set("agt_scout", [
      {
        connectionId: "dbc_shop",
        level: "read",
        policy: { tables: ["public.customers"], maskedColumns: [], queriesPerDay: 200, timeoutSeconds: 30 },
      },
    ]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    const tables = await within(form).findByRole("list", { name: "Tables" });
    await app.user.click(within(tables).getByRole("checkbox", { name: "public.orders" }));
    server.force("listDatabaseTables", { kind: "error", status: 400, code: "database.unreachable" }, 4);
    await refresh(app);
    expect(await within(form).findByText("The database's tables could not be listed")).toBeDefined();
    expect(within(form).getByRole("button", { name: "Save database access" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("a database whose password was refused asks for it to be renewed first", async () => {
    const server = seeded();
    server.connections.databases[0] = shop({ status: "reauth_required" });
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "Shop" });
    await app.user.click(within(form).getByRole("checkbox", { name: "May query Shop" }));
    expect(within(form).getByText(/The database refused the saved password/)).toBeDefined();
    await act(async () => {});
    expect(app.server.calls.some((call) => call.method === "listDatabaseTables")).toBe(false);
  });
});

describe("GitHub repositories", () => {
  const part = () => screen.findByRole("region", { name: "GitHub repositories" });

  test("an admin chooses repositories; a whole account covers its repositories", async () => {
    const server = seeded();
    server.connections.installations.push({
      id: "ins_birch",
      workspaceId: WS,
      accountUsername: "birchwood-labs",
      repoScope: "selected",
      suspended: false,
      repositories: [
        { fullName: "birchwood-labs/print-shop", private: true },
        { fullName: "birchwood-labs/site", private: false },
      ],
    });
    server.connections.repositories.set("agt_scout", ["old-org/archive"]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    expect(within(form).getByRole("checkbox", { name: "old-org/archive" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await app.user.click(within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ }));
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(await screen.findByText("The repositories are saved.")).toBeDefined();
    expect(server.connections.repositories.get("agt_scout")).toEqual([
      "old-org/archive",
      "birchwood-labs/site",
    ]);
    await app.user.click(
      within(await within(await part()).findByRole("form", { name: "GitHub repositories" })).getByRole(
        "checkbox",
        {
          name: "Every repository of birchwood-labs",
        },
      ),
    );
    const site = within(await part()).getByRole("checkbox", { name: /birchwood-labs\/site/ });
    expect(site.hasAttribute("disabled")).toBe(true);
  });

  const narrow = async (app: Awaited<ReturnType<typeof renderApp>>, form: HTMLElement) =>
    app.user.click(within(form).getByRole("radio", { name: "Only the ones ticked below" }));

  test("an agent without a list reaches every repository, and the form says so", async () => {
    const server = seeded();
    birchwoodGitHub(server);
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    expect(
      within(form)
        .getByRole("radio", { name: /No limit: every repository the GitHub connection reaches/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    for (const box of within(form).getAllByRole("checkbox")) {
      expect(box.getAttribute("aria-checked")).toBe("true");
      expect(box.hasAttribute("disabled")).toBe(true);
    }
  });

  test("narrowing from no limit saves only the ticked ones, never an empty list", async () => {
    const server = seeded();
    birchwoodGitHub(server);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    await narrow(app, form);
    const save = within(form).getByRole("button", { name: "Save repositories" });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(within(form).getByText(/Keep at least one repository ticked/)).toBeDefined();
    await app.user.click(within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ }));
    await app.user.click(save);
    expect(await screen.findByText("The repositories are saved.")).toBeDefined();
    expect(server.connections.repositories.get("agt_scout")).toEqual(["birchwood-labs/site"]);
  });

  test("the last ticked repository can't be unticked, and the form says how to take GitHub away", async () => {
    const server = seeded();
    birchwoodGitHub(server);
    server.connections.repositories.set("agt_scout", ["birchwood-labs/site"]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    const site = within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ });
    await app.user.click(site);
    expect(site.getAttribute("aria-checked")).toBe("true");
    expect(within(form).getByText(/set GitHub to Nothing under What it reaches/)).toBeDefined();
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(await screen.findByText("The repositories are saved.")).toBeDefined();
    expect(server.connections.repositories.get("agt_scout")).toEqual(["birchwood-labs/site"]);
  });

  test("no limit is its own choice", async () => {
    const server = seeded();
    birchwoodGitHub(server);
    server.connections.repositories.set("agt_scout", ["birchwood-labs/site"]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    await app.user.click(within(form).getByRole("radio", { name: /No limit/ }));
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(await screen.findByText("The repositories are saved.")).toBeDefined();
    expect(server.connections.repositories.get("agt_scout")).toEqual([]);
  });

  test("ticks go over the repositories saved now", async () => {
    const server = seeded();
    birchwoodGitHub(server);
    server.connections.repositories.set("agt_scout", ["birchwood-labs/print-shop"]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    await app.user.click(within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ }));
    // Another admin swaps print-shop for another repository after this form loaded.
    server.connections.repositories.set("agt_scout", ["old-org/archive"]);
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(await screen.findByText("The repositories are saved.")).toBeDefined();
    expect(server.connections.repositories.get("agt_scout")).toEqual([
      "old-org/archive",
      "birchwood-labs/site",
    ]);
  });

  test("no limit set by someone else meanwhile is shown, and the ticks wait for a second save", async () => {
    const server = seeded();
    birchwoodGitHub(server);
    server.connections.repositories.set("agt_scout", ["birchwood-labs/print-shop"]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    await app.user.click(within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ }));
    server.connections.repositories.set("agt_scout", []);
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(
      await within(form).findByText(/Meanwhile someone let this agent reach every repository/),
    ).toBeDefined();
    expect(count(server, "setAgentRepositories")).toBe(0);
    expect(server.connections.repositories.get("agt_scout")).toEqual([]);
    const ticked = () =>
      ["print-shop", "site"].map((name) =>
        within(form)
          .getByRole("checkbox", { name: new RegExp(`birchwood-labs/${name}`) })
          .getAttribute("aria-checked"),
      );
    await waitFor(() => expect(ticked()).toEqual(["true", "true"]));
    expect(
      within(form).getByRole("radio", { name: "Only the ones ticked below" }).getAttribute("aria-checked"),
    ).toBe("true");
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(await screen.findByText("The repositories are saved.")).toBeDefined();
    expect(server.connections.repositories.get("agt_scout")).toEqual([
      "birchwood-labs/print-shop",
      "birchwood-labs/site",
    ]);
  });

  test("ticks survive a refresh, and another's change shows in the entries left alone", async () => {
    const server = seeded();
    birchwoodGitHub(server);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    await narrow(app, form);
    await app.user.click(within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ }));
    server.connections.repositories.set("agt_scout", ["birchwood-labs/print-shop"]);
    await refresh(app);
    await waitFor(() =>
      expect(
        within(form)
          .getByRole("checkbox", { name: /birchwood-labs\/print-shop/ })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(
      within(form)
        .getByRole("checkbox", { name: /birchwood-labs\/site/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("while a save is on its way the form waits, one save goes out, and the focus comes back", async () => {
    const stop = blurOnDisable();
    try {
      const server = seeded();
      birchwoodGitHub(server);
      const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
      const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
      await narrow(app, form);
      const site = within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ });
      await app.user.click(site);
      const held = server.hold("listAgentRepositories");
      const button = within(form).getByRole("button", { name: "Save repositories" });
      await app.user.click(button);
      act(() => {
        fireEvent.submit(form);
      });
      expect(form.getAttribute("aria-busy")).toBe("true");
      expect(site.hasAttribute("disabled")).toBe(true);
      held.release();
      expect(await screen.findByText("The repositories are saved.")).toBeDefined();
      await waitFor(() => expect(document.activeElement === button).toBe(true));
      expect(count(server, "setAgentRepositories")).toBe(1);
    } finally {
      stop();
    }
  });

  test("a server error keeps the ticks", async () => {
    const server = seeded();
    birchwoodGitHub(server);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    await narrow(app, form);
    await app.user.click(within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ }));
    server.force("setAgentRepositories", { kind: "error", status: 400, code: "validation" });
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(await within(form).findByRole("alert")).toBeDefined();
    expect(
      within(form)
        .getByRole("checkbox", { name: /birchwood-labs\/site/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("repositories that fail to load offer a retry", async () => {
    const server = seeded();
    birchwoodGitHub(server);
    server.force("listAgentRepositories", { kind: "error", status: 500, code: "internal" }, 4);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const region = await part();
    expect(await within(region).findByText("The repositories could not be loaded")).toBeDefined();
    server.unforce("listAgentRepositories");
    await app.user.click(within(region).getByRole("button", { name: "Retry" }));
    expect(await within(await part()).findByRole("form", { name: "GitHub repositories" })).toBeDefined();
  });

  test("an agent archived meanwhile is refused, and its repositories turn read-only", async () => {
    const server = seeded();
    server.connections.repositories.set("agt_scout", ["old-org/archive"]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    const scout = server.agents.find((agent) => agent.id === "agt_scout");
    if (scout === undefined) throw new Error("no Scout");
    scout.archivedAt = new Date().toISOString();
    await app.user.click(within(form).getByRole("checkbox", { name: "old-org/archive" }));
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(await within(form).findByRole("alert")).toBeDefined();
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "GitHub repositories" })).queryByRole("button", {
          name: "Save repositories",
        }) === null,
      ).toBe(true),
    );
    expect(server.connections.repositories.get("agt_scout")).toEqual(["old-org/archive"]);
  });

  test("more repositories than the server keeps are refused, not cut", async () => {
    const server = seeded();
    server.connections.installations.push({
      id: "ins_big",
      workspaceId: WS,
      accountUsername: "big-org",
      repoScope: "all",
      suspended: false,
      repositories: Array.from({ length: 201 }, (_, i) => ({ fullName: `big-org/r${i}`, private: false })),
    });
    server.connections.repositories.set(
      "agt_scout",
      Array.from({ length: 201 }, (_, i) => `big-org/r${i}`),
    );
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    expect(within(form).getByRole("alert").textContent).toContain("At most 200 entries; 201 are chosen.");
    expect(within(form).getByRole("button", { name: "Save repositories" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("without GitHub it says where to install it", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    expect(await within(await part()).findByText("GitHub is not linked")).toBeDefined();
  });
});

describe("the fake server's source rules, as the server's", () => {
  const statusOf = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return "ok";
    } catch (error) {
      const { status, rawCode } = error as { status?: number; rawCode?: string };
      return `${status} ${rawCode}`;
    }
  };
  const admin = () => {
    const server = seeded();
    const { runtime } = newTestRuntime({ path: "/", signedInAs: "usr_jonas", server });
    return { server, client: runtime.api.client };
  };
  const database = (client: ReturnType<typeof admin>["client"], body: T.SetAgentDatabaseInput) => () =>
    client.call("replaceAgentDatabase", {
      workspaceId: WS,
      agentId: "agt_scout",
      databaseId: "dbc_shop",
      body,
    });

  test("a hidden column needs its table, and the lists have the server's caps", async () => {
    const { client } = admin();
    expect(await statusOf(database(client, { level: "read", policy: { maskedColumns: ["ssn"] } }))).toBe(
      "400 validation",
    );
    const many = Array.from({ length: 501 }, (_, i) => `public.t${i}`);
    expect(await statusOf(database(client, { level: "read", policy: { tables: many } }))).toBe(
      "400 validation",
    );
    const repositories = Array.from({ length: 201 }, (_, i) => `acme/r${i}`);
    expect(
      await statusOf(() =>
        client.call("setAgentRepositories", {
          workspaceId: WS,
          agentId: "agt_scout",
          body: { repositories },
        }),
      ),
    ).toBe("400 validation");
  });

  test("a first save at none keeps an empty policy", async () => {
    const { server, client } = admin();
    expect(await statusOf(database(client, { level: "none" }))).toBe("ok");
    expect(server.connections.agentDatabases.get("agt_scout")?.[0]?.policy).toEqual({
      tables: [],
      maskedColumns: [],
      queriesPerDay: 200,
      timeoutSeconds: 30,
    });
  });

  test("mailbox and database writes refuse an archived agent", async () => {
    const { server, client } = admin();
    const scout = server.agents.find((agent) => agent.id === "agt_scout");
    if (scout === undefined) throw new Error("no Scout");
    scout.archivedAt = new Date().toISOString();
    expect(
      await statusOf(() =>
        client.call("replaceAgentMail", {
          workspaceId: WS,
          agentId: "agt_scout",
          mailId: "mail_orders",
          body: { level: "read" },
        }),
      ),
    ).toBe("409 agent.archived");
    expect(await statusOf(database(client, { level: "read" }))).toBe("409 agent.archived");
  });
});
