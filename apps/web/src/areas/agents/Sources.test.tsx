// An agent's mailboxes, databases and repositories, on its Access tab, against the fake server. Scout is
// Ana's agent in Birchwood; Jonas manages agents there, Íris is a member.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import type * as T from "@vanr/contract";
import type { FakeDatabase, FakeMailAccount } from "../../../dev/fake-connections.ts";
import { chooseOption, newServer, renderApp } from "../../../test/app.tsx";
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

  test("ticks go over the repositories saved now", async () => {
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
    server.connections.repositories.set("agt_scout", ["birchwood-labs/print-shop"]);
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    const form = await within(await part()).findByRole("form", { name: "GitHub repositories" });
    await app.user.click(within(form).getByRole("checkbox", { name: /birchwood-labs\/site/ }));
    // Another admin takes print-shop away after this form loaded.
    server.connections.repositories.set("agt_scout", []);
    await app.user.click(within(form).getByRole("button", { name: "Save repositories" }));
    expect(await screen.findByText("The repositories are saved.")).toBeDefined();
    expect(server.connections.repositories.get("agt_scout")).toEqual(["birchwood-labs/site"]);
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
